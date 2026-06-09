// streem — signaling server.
// The server ONLY relays WebRTC handshakes + chat. Audio/video never touch it,
// so it stays light enough for Render's free tier. Media flows browser-to-browser.

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  // generous so 60fps screen shares survive brief network hiccups
  pingTimeout: 30000,
  maxHttpBufferSize: 1e6,
});

app.use(express.static(path.join(__dirname, 'public')));

// ICE servers (STUN for discovery + TURN as a relay fallback for tough NATs/firewalls).
// Plug your own TURN in via Render env vars: TURN_URL, TURN_USERNAME, TURN_CREDENTIAL.
// TURN_URL may be comma-separated (e.g. "turn:host:80,turn:host:443?transport=tcp").
app.get('/config', (_req, res) => {
  const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];

  if (process.env.TURN_URL) {
    iceServers.push({
      urls: process.env.TURN_URL.split(',').map((u) => u.trim()),
      username: process.env.TURN_USERNAME || '',
      credential: process.env.TURN_CREDENTIAL || '',
    });
  } else {
    // Free public fallback (Open Relay). Fine for testing; get your own for real use.
    iceServers.push(
      { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
    );
  }

  res.json({ iceServers });
});

app.get('/healthz', (_req, res) => res.send('ok'));

// roomId -> Map(socketId -> { name, sharing, muted })
const rooms = new Map();

io.on('connection', (socket) => {
  let joinedRoom = null;
  let username = null;

  socket.on('join', ({ roomId, name }) => {
    joinedRoom = String(roomId || 'lobby').trim().slice(0, 64) || 'lobby';
    username = String(name || 'Guest').trim().slice(0, 32) || 'Guest';

    socket.join(joinedRoom);
    if (!rooms.has(joinedRoom)) rooms.set(joinedRoom, new Map());
    const peers = rooms.get(joinedRoom);

    // tell the newcomer who is already in the room (so it can dial them)
    const existing = [...peers.entries()].map(([id, p]) => ({
      id,
      name: p.name,
      sharing: p.sharing,
      muted: p.muted,
    }));
    socket.emit('joined', { selfId: socket.id, peers: existing });

    // register + announce to everyone else
    peers.set(socket.id, { name: username, sharing: false, muted: false });
    socket.to(joinedRoom).emit('peer-joined', { id: socket.id, name: username });
  });

  // blind relay of SDP offers/answers and ICE candidates between two peers
  socket.on('signal', ({ to, data }) => {
    if (to && data) io.to(to).emit('signal', { from: socket.id, data });
  });

  socket.on('chat', (text) => {
    if (!joinedRoom || text == null) return;
    const msg = String(text).slice(0, 2000).trim();
    if (!msg) return;
    io.to(joinedRoom).emit('chat', {
      id: socket.id,
      name: username,
      text: msg,
      ts: Date.now(),
    });
  });

  // mic-muted / screen-sharing status, mirrored to the room for the UI
  socket.on('presence', (state) => {
    if (!joinedRoom || !rooms.has(joinedRoom)) return;
    const me = rooms.get(joinedRoom).get(socket.id);
    if (me) {
      if (typeof state.sharing === 'boolean') me.sharing = state.sharing;
      if (typeof state.muted === 'boolean') me.muted = state.muted;
    }
    socket.to(joinedRoom).emit('presence', { id: socket.id, ...state });
  });

  socket.on('disconnect', () => {
    if (joinedRoom && rooms.has(joinedRoom)) {
      const peers = rooms.get(joinedRoom);
      peers.delete(socket.id);
      if (peers.size === 0) rooms.delete(joinedRoom);
      socket.to(joinedRoom).emit('peer-left', { id: socket.id });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`streem signaling server listening on :${PORT}`));

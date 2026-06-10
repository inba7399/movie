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
  // ping often (fast ghost-peer detection) but stay generous enough on the timeout
  // that brief hiccups during a 60fps share don't kick anyone; reconnecting tabs
  // also kill their own ghost instantly via the session key in 'join'
  pingInterval: 10000,
  pingTimeout: 20000,
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
  }
  // No free public TURN fallback on purpose: the old Open Relay service is dead, and
  // dead TURN servers actively HURT — browsers wait on their allocations during ICE,
  // delaying every connection. STUN alone covers most home networks; for strict
  // NATs/firewalls configure your own TURN via env vars (e.g. a coturn box or a
  // metered.ca account): TURN_URL, TURN_USERNAME, TURN_CREDENTIAL.

  res.json({ iceServers });
});

app.get('/healthz', (_req, res) => res.send('ok'));

// roomId -> Map(socketId -> { name, sharing, muted, sess })
const rooms = new Map();

io.on('connection', (socket) => {
  let joinedRoom = null;
  let username = null;

  socket.on('join', (payload) => {
    const { roomId, name, sess } = payload || {};
    joinedRoom = String(roomId || 'lobby').trim().slice(0, 64) || 'lobby';
    username = String(name || 'Guest').trim().slice(0, 32) || 'Guest';

    socket.join(joinedRoom);
    if (!rooms.has(joinedRoom)) rooms.set(joinedRoom, new Map());
    const peers = rooms.get(joinedRoom);

    // A reconnecting tab announces the same session key — kick its ghost socket NOW
    // so nobody keeps encoding to (or waiting on) a dead connection for ~30s, and so
    // the newcomer doesn't dial its own corpse.
    if (sess) {
      for (const [id, p] of peers) {
        if (p.sess === sess && id !== socket.id) {
          peers.delete(id);
          socket.to(joinedRoom).emit('peer-left', { id });
          io.sockets.sockets.get(id)?.disconnect(true);
        }
      }
    }

    // tell the newcomer who is already in the room (so it can dial them)
    const existing = [...peers.entries()].map(([id, p]) => ({
      id,
      name: p.name,
      sharing: p.sharing,
      muted: p.muted,
    }));
    socket.emit('joined', { selfId: socket.id, peers: existing });

    // register + announce to everyone else
    peers.set(socket.id, { name: username, sharing: false, muted: false, sess: typeof sess === 'string' ? sess.slice(0, 64) : null });
    socket.to(joinedRoom).emit('peer-joined', { id: socket.id, name: username });
  });

  // relay of SDP offers/answers and ICE candidates — only within the sender's room
  socket.on('signal', (payload) => {
    const { to, data } = payload || {};
    if (!to || !data || !joinedRoom) return;
    const peers = rooms.get(joinedRoom);
    if (!peers || !peers.has(to)) return;
    io.to(to).emit('signal', { from: socket.id, data });
  });

  socket.on('chat', (text) => {
    if (!joinedRoom || (typeof text !== 'string' && typeof text !== 'number')) return;
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
    if (!state || typeof state !== 'object') return;
    const clean = {};
    if (typeof state.sharing === 'boolean') clean.sharing = state.sharing;
    if (typeof state.muted === 'boolean') clean.muted = state.muted;
    const me = rooms.get(joinedRoom).get(socket.id);
    if (me) Object.assign(me, clean);
    socket.to(joinedRoom).emit('presence', { id: socket.id, ...clean });
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

/* streem client — WebRTC mesh.
 *
 * Topology: every pair of people shares ONE RTCPeerConnection. Each connection
 * always carries your mic (both directions → Discord-style group voice). When you
 * share your screen, that video (+ the movie's audio) is added onto every
 * connection and renegotiated. Video/audio go straight peer-to-peer; the server
 * only relays the handshake.
 *
 * Glare (both sides offering at once, e.g. two people share together) is handled
 * with the WebRTC "perfect negotiation" pattern.
 */

const socket = io();

let selfId = null;
let roomId = null;
let myName = null;
let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];

// peerId -> { pc, name, polite, makingOffer, ignoreOffer, audioStream }
const peers = new Map();
// peerId -> MediaStream currently shown on the stage ('self' for your own share)
const presenters = new Map();

let micStream = null;
let screenStream = null;
let sharing = false;
let micEnabled = true;

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const joinScreen = $('join');
const appScreen = $('app');
const nameInput = $('nameInput');
const roomInput = $('roomInput');
const participantsEl = $('participants');
const messagesEl = $('messages');
const stageVideo = $('stageVideo');
const stagePlaceholder = $('stagePlaceholder');
const presenterTag = $('presenterTag');
const audioSink = $('audioSink');

const AVATAR_COLORS = ['#5865f2', '#3ba55d', '#faa61a', '#ed4245', '#9b59b6', '#1abc9c', '#e91e63', '#00b0f4'];
const colorFor = (id) => AVATAR_COLORS[[...id].reduce((a, c) => a + c.charCodeAt(0), 0) % AVATAR_COLORS.length];
const initials = (name) => name.trim().slice(0, 2).toUpperCase() || '?';

// ---------- Join ----------
$('joinBtn').addEventListener('click', join);
roomInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') roomInput.focus(); });

// prefill room from ?room=
const urlRoom = new URLSearchParams(location.search).get('room');
if (urlRoom) roomInput.value = urlRoom;

async function loadConfig() {
  try {
    const res = await fetch('/config');
    const json = await res.json();
    if (json.iceServers) iceServers = json.iceServers;
  } catch (_) { /* fall back to STUN-only */ }
}

async function join() {
  myName = (nameInput.value || 'Guest').trim().slice(0, 32) || 'Guest';
  roomId = (roomInput.value || 'lobby').trim().slice(0, 64) || 'lobby';

  await loadConfig();

  // Grab the mic up front. Echo cancellation/noise suppression on for voice.
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
  } catch (_) {
    micStream = new MediaStream(); // no mic? still let them watch + chat
    systemMsg('No microphone detected — you can still watch and chat.');
  }

  $('roomLabel').textContent = roomId;
  joinScreen.classList.add('hidden');
  appScreen.classList.remove('hidden');

  addParticipant(socket.id || 'self', myName + ' (You)', true);
  socket.emit('join', { roomId, name: myName });
}

// ---------- Signaling handlers ----------
socket.on('joined', ({ selfId: id, peers: existing }) => {
  selfId = id;
  // re-key our own participant entry now that we know the real id
  refreshSelfEntry();
  for (const p of existing) {
    addParticipant(p.id, p.name);
    if (p.sharing || p.muted) updatePresence(p.id, p.sharing, p.muted);
    createPeer(p.id, p.name); // dial everyone already here
  }
  systemMsg(`You joined #${roomId}.`);
});

socket.on('peer-joined', ({ id, name }) => {
  addParticipant(id, name);
  createPeer(id, name);
  systemMsg(`${name} joined.`);
});

socket.on('peer-left', ({ id }) => {
  const state = peers.get(id);
  systemMsg(`${state ? state.name : 'Someone'} left.`);
  removePeer(id);
});

socket.on('signal', ({ from, data }) => handleSignal(from, data));
socket.on('chat', renderChat);
socket.on('presence', ({ id, sharing: s, muted: m }) => updatePresence(id, s, m));

// ---------- Peer connections ----------
function createPeer(peerId, name) {
  if (peers.has(peerId)) return peers.get(peerId);

  // Deterministic, symmetric role assignment so glare resolves cleanly.
  const polite = selfId < peerId;
  const pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' });
  const state = { pc, name, polite, makingOffer: false, ignoreOffer: false, audioStream: new MediaStream() };
  peers.set(peerId, state);

  // Always publish mic. If we're already sharing, publish the screen too.
  for (const track of micStream.getTracks()) pc.addTrack(track, micStream);
  if (sharing && screenStream) {
    for (const track of screenStream.getTracks()) pc.addTrack(track, screenStream);
    tuneVideoSender(pc);
  }

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) socket.emit('signal', { to: peerId, data: { candidate } });
  };

  pc.onnegotiationneeded = async () => {
    try {
      state.makingOffer = true;
      await pc.setLocalDescription();
      socket.emit('signal', { to: peerId, data: { description: pc.localDescription } });
    } catch (err) {
      console.error('negotiation error', err);
    } finally {
      state.makingOffer = false;
    }
  };

  pc.ontrack = ({ track }) => {
    if (track.kind === 'video') {
      showPresenter(peerId, new MediaStream([track]), state.name);
      track.onmute = () => clearPresenter(peerId);
      track.onended = () => clearPresenter(peerId);
    } else {
      // mic audio and/or shared-movie audio — play through a per-peer element
      state.audioStream.addTrack(track);
      attachAudio(peerId, state.audioStream);
      track.onended = () => { try { state.audioStream.removeTrack(track); } catch (_) {} };
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') pc.restartIce();
  };

  return state;
}

async function handleSignal(from, data) {
  let state = peers.get(from);
  if (!state) state = createPeer(from, 'Guest'); // signal raced ahead of peer-joined
  const pc = state.pc;

  try {
    if (data.description) {
      const offerCollision =
        data.description.type === 'offer' && (state.makingOffer || pc.signalingState !== 'stable');
      state.ignoreOffer = !state.polite && offerCollision;
      if (state.ignoreOffer) return; // impolite peer wins; drop the colliding offer

      await pc.setRemoteDescription(data.description);
      if (data.description.type === 'offer') {
        await pc.setLocalDescription();
        socket.emit('signal', { to: from, data: { description: pc.localDescription } });
      }
    } else if (data.candidate) {
      try {
        await pc.addIceCandidate(data.candidate);
      } catch (err) {
        if (!state.ignoreOffer) throw err; // ignore candidates for a rejected offer
      }
    }
  } catch (err) {
    console.error('signal handling error', err);
  }
}

function removePeer(peerId) {
  const state = peers.get(peerId);
  if (state) {
    try { state.pc.close(); } catch (_) {}
    peers.delete(peerId);
  }
  clearPresenter(peerId);
  const audio = $('audio-' + peerId);
  if (audio) audio.remove();
  const li = $('p-' + peerId);
  if (li) li.remove();
}

// ---------- Screen sharing ----------
$('shareBtn').addEventListener('click', () => (sharing ? stopShare() : startShare()));

async function startShare() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: { ideal: 60, max: 60 },
        width: { ideal: 1920, max: 1920 },
        height: { ideal: 1080, max: 1080 },
      },
      // capture the movie's sound; don't process it like a mic
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch (_) {
    return; // user cancelled the picker
  }

  screenStream = stream;
  sharing = true;

  const videoTrack = stream.getVideoTracks()[0];
  videoTrack.contentHint = 'motion'; // tell the encoder to favor framerate (good for video)
  videoTrack.onended = stopShare; // browser's own "Stop sharing" button

  // push the screen onto every existing connection
  for (const [, state] of peers) {
    for (const track of stream.getTracks()) state.pc.addTrack(track, stream);
    tuneVideoSender(state.pc);
  }

  showPresenter('self', stream, myName + ' (You)');
  socket.emit('presence', { sharing: true });
  updateShareBtn();
}

function stopShare() {
  if (!sharing) return;
  sharing = false;

  const tracks = screenStream ? screenStream.getTracks() : [];
  for (const [, state] of peers) {
    for (const sender of state.pc.getSenders()) {
      if (sender.track && tracks.includes(sender.track)) state.pc.removeTrack(sender);
    }
  }
  for (const t of tracks) t.stop();
  screenStream = null;

  clearPresenter('self');
  socket.emit('presence', { sharing: false });
  updateShareBtn();
}

// Crank up quality: 8 Mbps ceiling, lock 60fps, never trade framerate for resolution.
function tuneVideoSender(pc) {
  const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
  if (!sender) return;
  const params = sender.getParameters();
  if (!params.encodings || !params.encodings.length) params.encodings = [{}];
  params.encodings[0].maxBitrate = 8_000_000;
  params.encodings[0].maxFramerate = 60;
  params.degradationPreference = 'maintain-framerate';
  sender.setParameters(params).catch(() => {});
}

// ---------- Stage (the shared screen) ----------
function showPresenter(peerId, stream, label) {
  presenters.set(peerId, { stream, label });
  renderStage();
}
function clearPresenter(peerId) {
  presenters.delete(peerId);
  renderStage();
}
function renderStage() {
  // prefer someone else's share over your own preview
  const remote = [...presenters.entries()].find(([id]) => id !== 'self');
  const pick = remote || [...presenters.entries()][0];
  if (pick) {
    const [, { stream, label }] = pick;
    if (stageVideo.srcObject !== stream) stageVideo.srcObject = stream;
    stageVideo.classList.remove('hidden');
    stagePlaceholder.classList.add('hidden');
    presenterTag.textContent = label + ' is sharing';
    presenterTag.classList.remove('hidden');
  } else {
    stageVideo.srcObject = null;
    stageVideo.classList.add('hidden');
    stagePlaceholder.classList.remove('hidden');
    presenterTag.classList.add('hidden');
  }
}

// ---------- Audio (remote voices + movie sound) ----------
function attachAudio(peerId, stream) {
  let audio = $('audio-' + peerId);
  if (!audio) {
    audio = document.createElement('audio');
    audio.id = 'audio-' + peerId;
    audio.autoplay = true;
    audioSink.appendChild(audio);
  }
  if (audio.srcObject !== stream) audio.srcObject = stream;
  audio.play().catch(() => {});
}

// ---------- Mic ----------
$('micBtn').addEventListener('click', toggleMic);
function toggleMic() {
  micEnabled = !micEnabled;
  for (const t of micStream.getAudioTracks()) t.enabled = micEnabled;
  socket.emit('presence', { muted: !micEnabled });
  updateMicBtn();
  updatePresence(selfId, undefined, !micEnabled);
}
function updateMicBtn() {
  const btn = $('micBtn');
  btn.classList.toggle('muted-on', !micEnabled);
  btn.querySelector('span').textContent = micEnabled ? 'Mute' : 'Unmute';
}
function updateShareBtn() {
  const btn = $('shareBtn');
  btn.classList.toggle('active', sharing);
  btn.querySelector('span').textContent = sharing ? 'Stop sharing' : 'Share screen';
}

// ---------- Fullscreen / leave ----------
$('fsBtn').addEventListener('click', () => {
  const el = $('stage');
  if (!document.fullscreenElement) el.requestFullscreen?.();
  else document.exitFullscreen?.();
});
$('leaveBtn').addEventListener('click', () => location.reload());

// ---------- Participants list ----------
function addParticipant(id, name, isSelf = false) {
  if ($('p-' + id)) return;
  const li = document.createElement('li');
  li.id = 'p-' + id;
  li.innerHTML = `
    <div class="avatar" style="background:${colorFor(id)}">${initials(name)}</div>
    <div class="p-name">${escapeHtml(name)}</div>
    <div class="p-badges" id="badges-${id}"></div>`;
  participantsEl.appendChild(li);
}
function refreshSelfEntry() {
  const old = $('p-' + (socket.id || 'self'));
  if (old) old.id = 'p-' + selfId;
  const badges = document.getElementById('badges-' + (socket.id || 'self'));
  if (badges) badges.id = 'badges-' + selfId;
}
function updatePresence(id, isSharing, isMuted) {
  const badges = $('badges-' + id);
  if (!badges) return;
  const cur = { sharing: badges.dataset.sharing === '1', muted: badges.dataset.muted === '1' };
  if (typeof isSharing === 'boolean') cur.sharing = isSharing;
  if (typeof isMuted === 'boolean') cur.muted = isMuted;
  badges.dataset.sharing = cur.sharing ? '1' : '0';
  badges.dataset.muted = cur.muted ? '1' : '0';
  badges.textContent = `${cur.sharing ? '🖥️' : ''}${cur.muted ? '🔇' : ''}`;
}

// ---------- Chat ----------
$('chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('chatInput');
  const text = input.value.trim();
  if (!text) return;
  socket.emit('chat', text);
  input.value = '';
});
function renderChat({ name, text, ts, id }) {
  const div = document.createElement('div');
  div.className = 'msg';
  const time = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const who = id === selfId ? 'You' : name;
  div.innerHTML = `<span class="who" style="color:${colorFor(id)}">${escapeHtml(who)}</span><span class="time">${time}</span><div class="body">${escapeHtml(text)}</div>`;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}
function systemMsg(text) {
  const div = document.createElement('div');
  div.className = 'msg system';
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ---------- utils ----------
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

window.addEventListener('beforeunload', () => {
  for (const [, s] of peers) { try { s.pc.close(); } catch (_) {} }
});

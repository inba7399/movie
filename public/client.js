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

// websocket-only: skips the long-polling handshake, so signaling (and therefore
// call setup / renegotiation) is as fast as the network allows
const socket = io({ transports: ['websocket'], upgrade: false });

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

// Viewer-selectable quality. Each viewer has its OWN connection to the presenter, so
// the presenter can encode a different quality per viewer — true per-viewer quality with
// no media server. Picking a level signals the presenter, who scales their captured
// screen DOWN to that level on this one connection. (Screen capture caps at ~60fps.)
// Bitrates sized for real home uplinks (Twitch streams 1080p60 at ~6 Mbps) — asking
// for more than the line can carry is itself a cause of stutter.
const QUALITY_PRESETS = {
  auto:   { label: 'Auto',  maxBitrate: null,       height: null, maxFramerate: 60 },
  '2160': { label: '4K',    maxBitrate: 24_000_000, height: 2160, maxFramerate: 60 },
  '1440': { label: '1440p', maxBitrate: 12_000_000, height: 1440, maxFramerate: 60 },
  '1080': { label: '1080p', maxBitrate:  8_000_000, height: 1080, maxFramerate: 60 },
  '720':  { label: '720p',  maxBitrate:  4_500_000, height: 720,  maxFramerate: 60 },
  '480':  { label: '480p',  maxBitrate:  1_500_000, height: 480,  maxFramerate: 30 },
};
// In a mesh every viewer gets their OWN encode — N viewers means N uploads at once.
// Split a total uplink budget across them so 4 friends don't ask a home connection
// for 4×8 Mbps and drown everyone (the per-connection BWE can't see its siblings).
const UPLINK_BUDGET = 20_000_000;
let myQualityChoice = 'auto';  // what I (as a viewer) last asked the presenter for
let broadcastQuality = 'auto'; // ceiling I (as the presenter) send to all viewers
let contentMode = 'motion';    // 'motion' = fluid 60fps video (default — it's a movie app), 'detail' = sharp text/apps
let stagePeerId = null;        // whose share is on the stage ('self' = my own preview)

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
const qualitySelect = $('qualitySelect');
const statsHud = $('statsHud');

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
    const res = await fetch('/config', { signal: AbortSignal.timeout(4000) });
    const json = await res.json();
    if (json.iceServers) iceServers = json.iceServers;
  } catch (_) { /* fall back to STUN-only */ }
}

let hasJoined = false;
// Stable per-tab identity: lets the server recognize a reconnecting tab and kill
// its ghost socket instantly instead of everyone waiting out the ping timeout.
const sessionKey = Math.random().toString(36).slice(2) + Date.now().toString(36);

async function join() {
  if (hasJoined) return; // double-click during the mic prompt would dial ourselves
  myName = (nameInput.value || 'Guest').trim().slice(0, 32) || 'Guest';
  roomId = (roomInput.value || 'lobby').trim().slice(0, 64) || 'lobby';
  hasJoined = true;

  // Config fetch and mic permission have nothing to wait on each other for.
  // Echo cancellation/noise suppression on for voice.
  const [, mic] = await Promise.all([
    loadConfig(),
    navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    }).catch(() => null),
  ]);
  micStream = mic || new MediaStream(); // no mic? still let them watch + chat
  if (!mic) systemMsg('No microphone detected — you can still watch and chat.');

  $('roomLabel').textContent = roomId;
  joinScreen.classList.add('hidden');
  appScreen.classList.remove('hidden');

  addParticipant(socket.id || 'self', myName + ' (You)', true);
  socket.emit('join', { roomId, name: myName, sess: sessionKey });
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

// If the signaling socket drops (wifi blip, server redeploy) we get a NEW socket id,
// so every peer connection is orphaned. Tear down and rejoin — the 'joined' handler
// rebuilds the room and redials everyone, so the stream recovers by itself.
// (Listen on the socket's 'connect', NOT the manager's 'reconnect': the manager event
// fires before the new socket id exists, and everything below needs that id.)
let everConnected = false;
socket.on('connect', () => {
  if (!everConnected) { everConnected = true; return; }
  if (!hasJoined) return;
  systemMsg('Connection restored — rejoining…');
  for (const id of [...peers.keys()]) removePeer(id);
  participantsEl.innerHTML = '';
  addParticipant(socket.id, myName + ' (You)', true);
  socket.emit('join', { roomId, name: myName, sess: sessionKey });
  // re-announce full state — others must see us muted/sharing again, not defaults
  socket.emit('presence', { sharing, muted: !micEnabled });
});

// ---------- Peer connections ----------
function createPeer(peerId, name) {
  const known = peers.get(peerId);
  if (known) {
    // a signal raced ahead of peer-joined and we created them as 'Guest' — fix the name
    if (name && name !== 'Guest') known.name = name;
    return known;
  }

  // Deterministic, symmetric role assignment so glare resolves cleanly.
  const polite = selfId < peerId;
  // iceCandidatePoolSize pre-gathers candidates so the first frame lands sooner
  const pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle', iceCandidatePoolSize: 4 });
  const state = { pc, name, polite, makingOffer: false, ignoreOffer: false, audioStream: new MediaStream(), wantQuality: 'auto' };
  peers.set(peerId, state);

  // Always publish mic. If we're already sharing, publish the screen too.
  for (const track of micStream.getTracks()) pc.addTrack(track, micStream);
  // Voice must stay clear even while a movie saturates the same link.
  for (const sender of pc.getSenders()) {
    if (!sender.track || sender.track.kind !== 'audio') continue;
    try {
      const p = sender.getParameters();
      if (!p.encodings || !p.encodings.length) p.encodings = [{}];
      p.encodings[0].priority = 'high';
      p.encodings[0].networkPriority = 'high';
      sender.setParameters(p).catch(() => {});
    } catch (_) {}
  }
  // No mic → no tracks → negotiation never starts and ICE/DTLS would only be set up
  // when someone shares (adding seconds to their first frame). A recvonly transceiver
  // warms the connection up right away.
  if (micStream.getTracks().length === 0) {
    try { pc.addTransceiver('audio', { direction: 'recvonly' }); } catch (_) {}
  }
  if (sharing && screenStream) {
    for (const track of screenStream.getTracks()) pc.addTrack(track, screenStream);
    preferVideoCodec(pc); // codec choice depends on Sharp/Smooth mode
    // a new viewer changes the per-viewer uplink budget — rebalance everyone
    for (const [, s] of peers) tuneVideoSender(s);
  }

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) socket.emit('signal', { to: peerId, data: { candidate } });
  };

  pc.onnegotiationneeded = async () => {
    try {
      state.makingOffer = true;
      await pc.setLocalDescription();
      socket.emit('signal', { to: peerId, data: { description: tuneSdp(pc.localDescription) } });
    } catch (err) {
      console.error('negotiation error', err);
    } finally {
      state.makingOffer = false;
    }
  };

  pc.ontrack = ({ track, receiver }) => {
    if (track.kind === 'video') {
      // Start with a SMALL receive buffer (low glass-to-glass delay). The adaptive
      // loop below grows it only when playback actually hitches, then shrinks back.
      setJitterTarget(receiver, jbTarget);
      state.videoReceiver = receiver;
      const videoStream = new MediaStream([track]);
      showPresenter(peerId, videoStream, state.name);
      // 'mute' also fires on transient gaps (presenter minimized the shared window,
      // brief RTP starvation) — clear the stage only if it doesn't recover quickly,
      // and ALWAYS bring the picture back on unmute. 'ended' is final.
      let muteTimer = null;
      track.onmute = () => {
        clearTimeout(muteTimer);
        muteTimer = setTimeout(() => clearPresenter(peerId), 2500);
      };
      track.onunmute = () => {
        clearTimeout(muteTimer);
        showPresenter(peerId, videoStream, state.name);
      };
      track.onended = () => { clearTimeout(muteTimer); clearPresenter(peerId); };
    } else {
      // mic audio and/or shared-movie audio — play through a per-peer element
      state.audioStream.addTrack(track);
      attachAudio(peerId, state.audioStream);
      track.onended = () => { try { state.audioStream.removeTrack(track); } catch (_) {} };
    }
  };

  pc.oniceconnectionstatechange = () => {
    // 'disconnected' often self-heals, but a viewer staring at a frozen frame for
    // 10-15s until 'failed' is not acceptable — nudge ICE after a 3s grace period.
    clearTimeout(state.iceTimer);
    if (pc.iceConnectionState === 'disconnected') {
      state.iceTimer = setTimeout(() => {
        if (pc.iceConnectionState === 'disconnected') pc.restartIce();
      }, 3000);
    }
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') pc.restartIce();
  };

  return state;
}

async function handleSignal(from, data) {
  // A viewer is asking us (the presenter) for a quality level on their connection.
  if (data && data.quality) { applyQualityRequest(from, data.quality); return; }

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
        socket.emit('signal', { to: from, data: { description: tuneSdp(pc.localDescription) } });
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
    clearTimeout(state.iceTimer);
    try { state.pc.close(); } catch (_) {}
    peers.delete(peerId);
    // one viewer fewer — give the remaining ones their share of the uplink back
    if (sharing && screenStream) for (const [, s] of peers) tuneVideoSender(s);
  }
  clearPresenter(peerId);
  const audio = $('audio-' + peerId);
  if (audio) audio.remove();
  const li = $('p-' + peerId);
  if (li) li.remove();
}

// ---------- Screen sharing ----------
$('shareBtn').addEventListener('click', () => (sharing ? stopShare() : startShare()));

// Sharp (text/apps) ⇄ Smooth (video) — only meaningful while you're the one sharing.
$('optBtn').addEventListener('click', () => {
  setContentMode(contentMode === 'detail' ? 'motion' : 'detail');
  $('optBtn').querySelector('span').textContent = contentMode === 'detail' ? 'Sharp' : 'Smooth';
});

async function startShare() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      // Capture only as much as we'll actually send (default 1080p30). Grabbing 4K60 and
      // encoding it is what makes a single machine stutter — match capture to the target.
      video: captureConstraints(),
      // capture the movie's sound in stereo; don't process it like a mic
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 },
      surfaceSwitching: 'include',   // swap tabs/windows without restarting the share
      selfBrowserSurface: 'exclude', // don't offer this tab (hall-of-mirrors)
      systemAudio: 'include',
    });
  } catch (_) {
    return; // user cancelled the picker
  }

  screenStream = stream;
  sharing = true;

  const videoTrack = stream.getVideoTracks()[0];
  videoTrack.contentHint = contentMode; // 'detail' = sharp text/UI, 'motion' = fluid video
  videoTrack.onended = stopShare; // browser's own "Stop sharing" button
  // 'music' tells Opus this is full-range audio, not speech — no aggressive DTX/CNG
  for (const t of stream.getAudioTracks()) t.contentHint = 'music';
  if (stream.getAudioTracks().length === 0) {
    systemMsg('No audio is being captured — your friends will see a silent movie. Share a tab, or tick "Also share system audio" in the picker.');
  }

  // push the screen onto every existing connection
  for (const [, state] of peers) {
    for (const track of stream.getTracks()) state.pc.addTrack(track, stream);
    preferVideoCodec(state.pc); // H264 hw for movies, VP9 for sharp text
    tuneVideoSender(state);
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
  cpuRelief = 0; cpuStrikes = 0; cpuClean = 0; // next share starts clean, not pre-degraded

  clearPresenter('self');
  socket.emit('presence', { sharing: false });
  updateShareBtn();
}

// Apply an encoding preset to one connection's video sender. Because each viewer is a
// separate connection, this sets quality for THAT viewer only. We scale the captured
// screen down to the preset's height (never up — can't invent detail that isn't there).
function applyEncoding(sender, preset) {
  if (!sender || !sender.track) return;
  const params = sender.getParameters();
  if (!params.encodings || !params.encodings.length) params.encodings = [{}];
  const enc = params.encodings[0];
  // Per-viewer slice of the uplink budget. Even on 'Auto' we cap at the slice —
  // BWE still adapts below it, but no single viewer can starve the others.
  const meshShare = Math.max(1_500_000, Math.floor(UPLINK_BUDGET / Math.max(1, peers.size)));
  enc.maxBitrate = preset.maxBitrate ? Math.min(preset.maxBitrate, meshShare) : meshShare;
  enc.maxFramerate = preset.maxFramerate || 60;
  const capH = (sender.track.getSettings && sender.track.getSettings().height) || 1080;
  enc.scaleResolutionDownBy = preset.height ? Math.max(1, capH / preset.height) : 1;
  // Sharp mode keeps resolution (crisp text); smooth mode keeps framerate (fluid video).
  params.degradationPreference = contentMode === 'detail' ? 'maintain-resolution' : 'maintain-framerate';
  sender.setParameters(params).catch(() => {});
}

// Combine a viewer's request with my broadcast ceiling — the lower wins for each
// dimension (a viewer can drop below what I broadcast, never rise above it). null = source.
function effectivePreset(requestKey) {
  const req = QUALITY_PRESETS[requestKey] || QUALITY_PRESETS.auto;
  const ceil = QUALITY_PRESETS[broadcastQuality] || QUALITY_PRESETS.auto;
  const lower = (a, b) => (a == null ? b : b == null ? a : Math.min(a, b));
  return {
    maxBitrate: lower(req.maxBitrate, ceil.maxBitrate),
    height: lower(req.height, ceil.height),
    maxFramerate: Math.min(req.maxFramerate || 60, ceil.maxFramerate || 60),
  };
}

// (Re)tune one viewer's video sender from their request + my broadcast ceiling.
function tuneVideoSender(state) {
  const sender = state.pc.getSenders().find((s) => s.track && s.track.kind === 'video');
  applyEncoding(sender, effectivePreset(state.wantQuality || 'auto'));
}

// We're the presenter; viewer `peerId` asked for a level. Remember it and apply to just
// their connection so the other viewers are unaffected.
function applyQualityRequest(peerId, qualityKey) {
  const state = peers.get(peerId);
  if (!state) return;
  state.wantQuality = QUALITY_PRESETS[qualityKey] ? qualityKey : 'auto';
  tuneVideoSender(state);
}

// We're the presenter; set the ceiling sent to ALL viewers, re-capture at that resolution
// (so we don't waste CPU on bigger frames), then re-tune each connection.
function setBroadcastQuality(qualityKey) {
  broadcastQuality = QUALITY_PRESETS[qualityKey] ? qualityKey : 'auto';
  recaptureScreen();
  for (const [, state] of peers) tuneVideoSender(state);
}

// Capture constraints sized to what we'll actually send: cap resolution to the chosen
// broadcast quality (default 1080p — 4K only if explicitly picked) and use 30fps for text,
// 60fps for video. Over-capturing (e.g. 4K60) is the main cause of stutter on one machine.
function captureConstraints() {
  const capHeight = { '2160': 2160, '1440': 1440, '1080': 1080, '720': 720, '480': 480 };
  let height = capHeight[broadcastQuality] || 1080;
  let fps = contentMode === 'motion' ? 60 : 30;
  // If the encoder reported sustained CPU overload, capture less — a steady 30fps
  // beats a stuttering 60fps every time. (cpuRelief recovers on its own when clean.)
  if (cpuRelief >= 1) fps = 30;
  if (cpuRelief >= 2) height = Math.min(height, 720);
  return { height: { ideal: height }, frameRate: { ideal: fps } };
}

// Re-apply capture constraints to a live share (after a quality/mode change).
function recaptureScreen() {
  if (!screenStream) return;
  for (const t of screenStream.getVideoTracks()) t.applyConstraints(captureConstraints()).catch(() => {});
}

// Pick the video codec to match the content:
//  - 'motion' (movies): H264 first. Nearly every machine has a HARDWARE H264 encoder,
//    so 1080p60 costs almost no CPU — software VP9 at the same rate pegs a core and
//    stutters. This is the single biggest presenter-side smoothness lever.
//  - 'detail' (text/apps): VP9/AV1 first — real screen-content coding keeps text crisp.
// Set before the offer; falls back silently to the browser default if unsupported.
function preferVideoCodec(pc) {
  try {
    if (!('getCapabilities' in RTCRtpSender)) return;
    const caps = RTCRtpSender.getCapabilities('video');
    const tx = pc.getTransceivers().find(
      (t) => t.sender && t.sender.track && t.sender.track.kind === 'video'
    );
    if (!caps || !caps.codecs || !tx || !tx.setCodecPreferences) return;
    const order = contentMode === 'motion'
      ? ['/h264', '/vp9', '/av1', '/vp8']
      : ['/vp9', '/av1', '/h264', '/vp8'];
    const rank = (c) => {
      const m = c.mimeType.toLowerCase();
      const i = order.findIndex((suffix) => m.endsWith(suffix));
      return i === -1 ? order.length : i; // rtx/red/fec — keep after real codecs
    };
    tx.setCodecPreferences([...caps.codecs].sort((a, b) => rank(a) - rank(b)));
  } catch (_) { /* unsupported — use default */ }
}

// Presenter: switch between sharp (text/apps, 30fps) and smooth (video, 60fps). Updates the
// live track hint, re-captures at the new framerate, re-ranks the codec (H264 hw for motion,
// VP9 for detail — needs a renegotiation to take effect) and re-tunes every connection.
function setContentMode(mode) {
  contentMode = mode === 'motion' ? 'motion' : 'detail';
  if (screenStream) for (const t of screenStream.getVideoTracks()) t.contentHint = contentMode;
  recaptureScreen();
  for (const [, state] of peers) {
    if (sharing && screenStream) {
      preferVideoCodec(state.pc);
      state.pc.onnegotiationneeded(); // codec change doesn't auto-fire negotiation
    }
    tuneVideoSender(state);
  }
}

// ---------- Adaptive streaming (stats-driven, Twitch-style) ----------
// Twitch feels smooth because it constantly measures playback health and trades
// quality for fluidity BEFORE you notice a stall. We do the same with WebRTC stats:
//   viewer side  — adaptive jitter buffer + auto down/up-switching of quality
//   presenter side — back off capture when the encoder is CPU-starved

let jbTarget = 60;        // ms of receive buffer; low = low delay, grows on hitches
let prevInbound = null;   // last inbound-rtp stats snapshot for delta math
let healthyTicks = 0;
let autoStep = 0;         // 0 = source quality; deeper = lower rung on the ladder
const AUTO_LADDER = ['auto', '1080', '720', '480'];
let cpuRelief = 0;        // 0 none · 1 cap 30fps · 2 also cap 720p
let cpuStrikes = 0;
let cpuClean = 0;

function setJitterTarget(receiver, ms) {
  try {
    if ('jitterBufferTarget' in receiver) receiver.jitterBufferTarget = ms;
    else if ('playoutDelayHint' in receiver) receiver.playoutDelayHint = ms / 1000;
  } catch (_) {}
}

setInterval(() => { monitorViewer(); monitorPresenter(); }, 2000);

async function monitorViewer() {
  if (!stagePeerId || stagePeerId === 'self') { prevInbound = null; return; }
  // A background tab throttles timers and decode — those "freezes" are not the
  // network's fault. Skip, and re-baseline when the tab comes back.
  if (document.hidden) { prevInbound = null; return; }
  const state = peers.get(stagePeerId);
  const staged = presenters.get(stagePeerId);
  if (!state || !staged) return;
  const stagedTrack = staged.stream.getVideoTracks()[0];
  let report;
  try { report = await state.pc.getStats(); } catch (_) { return; }
  let inbound = null;
  report.forEach((s) => {
    if (s.type !== 'inbound-rtp' || s.kind !== 'video') return;
    // stale receivers can linger after renegotiations — only trust the LIVE track
    if (stagedTrack && s.trackIdentifier && s.trackIdentifier !== stagedTrack.id) return;
    inbound = s;
  });
  if (!inbound) return;
  const prev = prevInbound;
  prevInbound = inbound;
  if (!prev || prev.id !== inbound.id) return; // stream changed — need a fresh baseline

  const freezes = (inbound.freezeCount || 0) - (prev.freezeCount || 0);
  const lost = (inbound.packetsLost || 0) - (prev.packetsLost || 0);
  const recv = (inbound.packetsReceived || 0) - (prev.packetsReceived || 0);
  const lossRate = recv > 0 ? lost / (lost + recv) : 0;
  // NOTE: low fps alone is NOT distress — a paused movie or a static screen encodes
  // near 0fps by design. Real signals are playback freezes and packet loss.
  const struggling = freezes > 0 || lossRate > 0.05;

  // Jitter buffer: hug the low-latency floor; only buy buffer when playback hitched.
  jbTarget = struggling ? Math.min(jbTarget + 50, 300) : Math.max(jbTarget - 25, 60);
  const rx = (state.videoReceiver && state.videoReceiver.track === stagedTrack)
    ? state.videoReceiver
    : state.pc.getReceivers().find((r) => r.track === stagedTrack);
  if (rx) setJitterTarget(rx, jbTarget);
  // Keep this peer's AUDIO on the same playout target — otherwise the movie's sound
  // runs up to a quarter second ahead of the picture as the video buffer grows.
  for (const r of state.pc.getReceivers()) {
    if (r.track && r.track.kind === 'audio') setJitterTarget(r, jbTarget);
  }

  updateHud(inbound, prev);

  // Auto ABR — only while the user has the menu on Auto (manual picks are respected).
  if (myQualityChoice !== 'auto') { autoStep = 0; healthyTicks = 0; return; }
  if (struggling) {
    healthyTicks = 0;
    if (autoStep < AUTO_LADDER.length - 1) {
      autoStep++;
      socket.emit('signal', { to: stagePeerId, data: { quality: AUTO_LADDER[autoStep] } });
    }
  } else if (autoStep > 0 && ++healthyTicks >= 8) { // ~16s clean → try one rung up
    healthyTicks = 0;
    autoStep--;
    socket.emit('signal', { to: stagePeerId, data: { quality: AUTO_LADDER[autoStep] } });
  }
}

// Tiny live health readout on the stage (resolution · fps · bitrate · buffer).
function updateHud(inbound, prev) {
  if (!statsHud) return;
  const kbps = Math.max(0, Math.round(((inbound.bytesReceived || 0) - (prev.bytesReceived || 0)) * 8 / 2000));
  const fps = Math.round(inbound.framesPerSecond || 0);
  const h = inbound.frameHeight || 0;
  const rate = kbps >= 1000 ? (kbps / 1000).toFixed(1) + ' Mbps' : kbps + ' kbps';
  statsHud.textContent = `${h ? h + 'p' : '·'} · ${fps} fps · ${rate} · buffer ${jbTarget} ms`;
}

async function monitorPresenter() {
  if (!sharing || !screenStream) { cpuStrikes = 0; cpuClean = 0; return; }
  let cpuLimited = false;
  for (const [, state] of peers) {
    let report;
    try { report = await state.pc.getStats(); } catch (_) { continue; }
    report.forEach((s) => {
      if (s.type === 'outbound-rtp' && s.kind === 'video' && s.qualityLimitationReason === 'cpu') {
        cpuLimited = true;
      }
    });
    if (cpuLimited) break;
  }
  if (cpuLimited) {
    cpuClean = 0;
    if (++cpuStrikes >= 3 && cpuRelief < 2) { // ~6s of sustained overload
      cpuStrikes = 0;
      cpuRelief++;
      recaptureScreen();
      // the capture size changed — recompute every sender's scaling against it
      for (const [, s] of peers) tuneVideoSender(s);
    }
  } else if (cpuRelief > 0 && ++cpuClean >= 15) { // ~30s clean → ease back up
    cpuClean = 0;
    cpuRelief--;
    recaptureScreen();
    for (const [, s] of peers) tuneVideoSender(s);
  } else if (!cpuLimited) {
    cpuStrikes = 0;
  }
}

// Tune the SDP we TRANSMIT (the fmtp lines a party sends describe what it wants to
// receive, so munging the transmitted copy is enough — both sides do it, so both
// directions benefit):
//  - Opus: stereo + 256k cap + in-band FEC on EVERY audio m-line. The movie audio is
//    usually the SECOND m-line — a non-global regex here silently skips it. A mono mic
//    doesn't get bigger just because stereo is allowed, so a blanket boost is safe.
//  - Video: x-google-start-bitrate skips libwebrtc's ~300kbps slow-start ramp, so a
//    share is sharp in about a second instead of ten. Non-Chrome ignores it harmlessly.
function tuneSdp(description) {
  try {
    let sdp = description.sdp;
    const opusWant = { stereo: '1', 'sprop-stereo': '1', maxaveragebitrate: '256000', useinbandfec: '1' };
    const opusFmtp = Object.entries(opusWant).map(([k, v]) => `${k}=${v}`).join(';');
    const opusIds = [...sdp.matchAll(/a=rtpmap:(\d+) opus\/48000\/2/gi)].map((m) => m[1]);
    for (const id of new Set(opusIds)) {
      let touched = false;
      sdp = sdp.replace(new RegExp(`(a=fmtp:${id} )([^\\r\\n]*)`, 'g'), (_, head, params) => {
        touched = true;
        const map = {};
        for (const kv of params.split(';')) {
          const [k, v] = kv.split('=');
          if (k) map[k.trim()] = (v || '').trim();
        }
        Object.assign(map, opusWant);
        return head + Object.entries(map).map(([k, v]) => (v === '' ? k : `${k}=${v}`)).join(';');
      });
      if (!touched) {
        // no fmtp line for this payload at all — insert one after each rtpmap
        sdp = sdp.replace(
          new RegExp(`(a=rtpmap:${id} opus\\/48000\\/2\\r?\\n)`, 'gi'),
          (line) => line + `a=fmtp:${id} ${opusFmtp}\r\n`
        );
      }
    }
    const vidIds = [...sdp.matchAll(/a=rtpmap:(\d+) (?:VP9|VP8|H264|AV1)\//gi)].map((m) => m[1]);
    for (const id of new Set(vidIds)) {
      if (new RegExp(`a=fmtp:${id} `).test(sdp)) {
        sdp = sdp.replace(new RegExp(`(a=fmtp:${id} [^\\r\\n]*)`, 'g'), (line) =>
          line.includes('x-google-start-bitrate') ? line : line + ';x-google-start-bitrate=4000'
        );
      } else {
        sdp = sdp.replace(new RegExp(`(a=rtpmap:${id} [^\\r\\n]*\\r?\\n)`, 'g'), (line) =>
          line + `a=fmtp:${id} x-google-start-bitrate=4000\r\n`
        );
      }
    }
    return { type: description.type, sdp };
  } catch (_) {
    return description;
  }
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
  // prefer someone else's share over your own preview; among remotes the NEWEST wins
  // (after a presenter reconnect their dead old entry must not block the live one)
  const remotes = [...presenters.entries()].filter(([id]) => id !== 'self');
  const pick = remotes.length ? remotes[remotes.length - 1] : [...presenters.entries()][0];
  if (pick) {
    const [peerId, { stream, label }] = pick;
    const stageChanged = peerId !== stagePeerId;
    stagePeerId = peerId;
    if (stageVideo.srcObject !== stream) stageVideo.srcObject = stream;
    stageVideo.classList.remove('hidden');
    stagePlaceholder.classList.add('hidden');
    presenterTag.textContent = label + ' is sharing';
    presenterTag.classList.remove('hidden');
    // The quality menu does double duty: pick what you RECEIVE when watching someone,
    // or what you BROADCAST (a ceiling for all viewers) when it's your own share.
    const watchingRemote = peerId !== 'self';
    const showQuality = watchingRemote || sharing;
    qualitySelect.classList.toggle('hidden', !showQuality);
    statsHud.classList.toggle('hidden', !watchingRemote);
    if (watchingRemote) {
      qualitySelect.title = 'Quality you receive';
      // Only when the staged peer CHANGES — re-requesting on every render would wipe
      // the ABR ladder and yank the presenter back to full rate mid-congestion.
      if (stageChanged) {
        jbTarget = 60; // fresh stream, fresh low-latency baseline
        requestQuality(myQualityChoice);
      }
    } else if (showQuality) {
      qualitySelect.title = 'Broadcast quality — ceiling for all viewers';
      qualitySelect.value = broadcastQuality;
    }
  } else {
    stagePeerId = null;
    stageVideo.srcObject = null;
    stageVideo.classList.add('hidden');
    stagePlaceholder.classList.remove('hidden');
    presenterTag.classList.add('hidden');
    qualitySelect.classList.add('hidden');
    statsHud.classList.add('hidden');
  }
}

// Viewer side: ask whoever's on the stage to send us a given quality level.
function requestQuality(qualityKey) {
  myQualityChoice = qualityKey;
  autoStep = 0; healthyTicks = 0; prevInbound = null; // fresh ABR baseline
  if (qualitySelect.value !== qualityKey) qualitySelect.value = qualityKey;
  if (stagePeerId && stagePeerId !== 'self') {
    socket.emit('signal', { to: stagePeerId, data: { quality: qualityKey } });
  }
}
// While watching others the dropdown picks what you RECEIVE; while sharing it sets the
// ceiling you BROADCAST to everyone.
qualitySelect.addEventListener('change', () => {
  if (stagePeerId === 'self') setBroadcastQuality(qualitySelect.value);
  else requestQuality(qualitySelect.value);
});

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
  audio.play().catch(() => {
    // autoplay blocked — retry on the next user interaction instead of staying silent
    const resume = () => {
      audio.play().catch(() => {});
      document.removeEventListener('pointerdown', resume);
    };
    document.addEventListener('pointerdown', resume);
  });
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
  $('optBtn').classList.toggle('hidden', !sharing); // content-mode toggle only while sharing
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
  // presenter stopped on purpose — clear their stage slot now instead of waiting
  // for the track-mute grace timer (keeps "stop sharing" feeling instant)
  if (isSharing === false) clearPresenter(id);
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

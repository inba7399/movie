// Integration test for the signaling server: join flow, signal relay scoping,
// ghost-kill on session rejoin, presence, and malformed-payload resilience.
process.env.PORT = 3457;
require('./server.js');

const { io } = require('socket.io-client');
const URL = 'http://localhost:3457';
const opts = { transports: ['websocket'] };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, cond) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name);
  if (!cond) failures++;
};

(async () => {
  // --- two peers join, see each other, can signal ---
  const a = io(URL, opts);
  const b = io(URL, opts);
  await Promise.all([
    new Promise((r) => a.on('connect', r)),
    new Promise((r) => b.on('connect', r)),
  ]);

  const aJoined = new Promise((r) => a.once('joined', r));
  a.emit('join', { roomId: 'test', name: 'Alice', sess: 'sess-A' });
  const aj = await aJoined;
  check('A joins empty room', aj.peers.length === 0 && aj.selfId === a.id);

  const aSeesB = new Promise((r) => a.once('peer-joined', r));
  const bJoined = new Promise((r) => b.once('joined', r));
  b.emit('join', { roomId: 'test', name: 'Bob', sess: 'sess-B' });
  const [bj, ab] = await Promise.all([bJoined, aSeesB]);
  check('B sees A in peer list', bj.peers.length === 1 && bj.peers[0].id === a.id);
  check('A notified of B', ab.id === b.id && ab.name === 'Bob');

  const bGotSignal = new Promise((r) => b.once('signal', r));
  a.emit('signal', { to: b.id, data: { hello: 1 } });
  const sig = await bGotSignal;
  check('in-room signal relayed', sig.from === a.id && sig.data.hello === 1);

  // --- signal must NOT cross rooms ---
  const c = io(URL, opts);
  await new Promise((r) => c.on('connect', r));
  c.emit('join', { roomId: 'other-room', name: 'Carol', sess: 'sess-C' });
  await sleep(150);
  let crossLeaked = false;
  b.on('signal', ({ from }) => { if (from === c.id) crossLeaked = true; });
  c.emit('signal', { to: b.id, data: { evil: true } });
  await sleep(250);
  check('cross-room signal blocked', !crossLeaked);

  // --- malformed payloads must not crash the server ---
  a.emit('join', null);
  a.emit('signal', null);
  a.emit('signal', 42);
  a.emit('presence', null);
  a.emit('presence', 'bogus');
  a.emit('chat', { obj: true });
  await sleep(200);
  const alive = await fetch(URL + '/healthz').then((r) => r.ok).catch(() => false);
  check('server survives malformed payloads', alive);

  // --- ghost-kill: same sess rejoins with a new socket ---
  const aId = a.id; // socket.io-client clears .id on disconnect — capture it now
  const a2 = io(URL, opts); // simulates Alice's tab reconnecting
  await new Promise((r) => a2.on('connect', r));
  const bSeesGhostLeave = new Promise((r) => b.once('peer-left', r));
  const a2Joined = new Promise((r) => a2.once('joined', r));
  a2.emit('join', { roomId: 'test', name: 'Alice', sess: 'sess-A' });
  const [a2j, ghostLeft] = await Promise.all([a2Joined, bSeesGhostLeave]);
  check('B told the ghost left immediately', ghostLeft.id === aId);
  check('rejoining tab does not see its own ghost', !a2j.peers.some((p) => p.id === aId));
  check('rejoining tab still sees B', a2j.peers.some((p) => p.id === b.id));
  await sleep(200);
  check('ghost socket force-disconnected', a.disconnected);

  // --- presence persists for late joiners ---
  a2.emit('presence', { sharing: true, muted: true });
  await sleep(150);
  const d = io(URL, opts);
  await new Promise((r) => d.on('connect', r));
  const dJoined = new Promise((r) => d.once('joined', r));
  d.emit('join', { roomId: 'test', name: 'Dave', sess: 'sess-D' });
  const dj = await dJoined;
  const aliceEntry = dj.peers.find((p) => p.id === a2.id);
  check('late joiner sees sharing+muted state', !!aliceEntry && aliceEntry.sharing === true && aliceEntry.muted === true);

  console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('TEST CRASH', e); process.exit(1); });

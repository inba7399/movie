# 🎬 streem

A Discord-style watch-together app: join a room, **voice chat**, **share your screen at 60fps** (movie + its sound), and **text chat** — all in the browser. Free to host on Render.

Video and audio flow **peer-to-peer over WebRTC**. The Node/Express server only relays the connection handshake and chat messages, so it stays tiny and runs on Render's free tier.

## ✨ Features
- 🔊 Group **voice chat** (full mesh — everyone hears everyone)
- 🖥️ **60fps screen sharing** with the movie's audio, tuned for smooth motion (8 Mbps, `maintain-framerate`)
- 💬 Live **text chat**
- 👥 Participant list with mic-muted / sharing badges
- 🌑 Clean dark UI, fullscreen stage, shareable room links (`?room=movie-night`)

## 🚀 Run locally
```bash
npm install
npm start
# open http://localhost:3000 in two tabs (or two devices) and join the same room
```
> Screen share + mic need a **secure context**. `localhost` counts as secure, so local testing works. In production you need **HTTPS** — Render gives you that automatically.

## ☁️ Deploy to Render (free)
1. Push this folder to a GitHub repo.
2. On [render.com](https://render.com): **New → Web Service** → connect the repo.
   - Render auto-detects `render.yaml`. Otherwise set **Build:** `npm install`, **Start:** `node server.js`.
   - Plan: **Free**.
3. Deploy. Open the `https://your-app.onrender.com` URL, share the room code, done.

### Heads-up on the free tier
- The free service **sleeps after ~15 min idle**; the first visitor wakes it (~30s). Fine for movie nights.
- For connections behind strict corporate/mobile firewalls you may need your own **TURN** relay (see below). The included free public TURN is fine for testing.

## 🌐 TURN (optional, for tricky networks)
STUN handles most home networks. If someone can't connect, add a TURN server via Render **Environment** variables:

| Variable | Example |
|---|---|
| `TURN_URL` | `turn:your-host:3478,turn:your-host:443?transport=tcp` |
| `TURN_USERNAME` | `youruser` |
| `TURN_CREDENTIAL` | `yoursecret` |

Free/cheap TURN options: [Metered Open Relay](https://www.metered.ca/tools/openrelay/), Twilio NTS, or self-hosted [coturn](https://github.com/coturn/coturn).

## 📐 How many people?
This is a **P2P mesh**, ideal for a **movie-night group of ~2–6**. The screen-sharer uploads their video to each viewer directly, so the limit is the sharer's **upload bandwidth**, not the server. 60fps/1080p needs a solid connection (~8 Mbps up per viewer). For big audiences (20+), you'd swap the mesh for an SFU media server — which won't fit a free host.

## 🧩 Project layout
```
server.js          Express + Socket.io signaling (relays handshake + chat)
public/index.html  UI
public/style.css   dark theme
public/client.js   all WebRTC: mesh, perfect-negotiation, 60fps tuning
render.yaml        one-click Render config
```

## 🛠️ Tips for the smoothest stream
- Sharer: use a **wired/strong Wi-Fi** connection — quality follows the sharer's upload.
- Everyone: **headphones** prevent echo (mic has echo-cancellation, but headphones are best).
- When sharing in Chrome, tick **"Share tab audio"** / **"Share system audio"** so viewers hear the movie.
- Chrome or Edge give the best `getDisplayMedia` 60fps support.

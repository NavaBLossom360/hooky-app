// Live: random video chat with a stranger your own age.
//
// Three parts, all in the browser:
//   media   one camera + mic stream, reused across every "Next"
//   peer    a WebRTC connection per pairing, signalled over the pairing's
//           realtime channel, with a small chat alongside
//   guard   an on-device nudity check on the OTHER person's video
//
// The guard is the same MobileNetV4 nudity model the server uses to check
// profile photos (vendor/nsfw, Apache 2.0), run by onnxruntime-web 1.14
// (vendor/onnxruntime, MIT). It looks at a frame about once a second. The
// other person's video starts blurred and only shows once a frame has been
// checked (a fraction of a second). A borderline frame blurs it again until a
// clean one arrives. Only a sustained, unmistakable hit ends the chat. Frames
// never leave the phone.
(function () {
  // ICE servers (STUN, plus TURN when configured) come from store.iceServers(),
  // which gets short-lived Cloudflare TURN credentials from the
  // turn-credentials Edge Function. A config.js `iceServers` list overrides it.
  const CONNECT_TIMEOUT_MS = 15000;

  // The score is the model's porn + hentai probability, 0 to 1. Its "sexy"
  // class is ignored: it scored an ordinary group photo in party dresses 1.00.
  // History: nsfwjs MobileNetV2 scored a plain strapless-top selfie 0.86 and
  // was dropped; nsfwjs MobileNetV2Mid reached 0.77 on clothed webcam frames;
  // this model scores those frames 0.00 to 0.02. The thresholds were set for
  // the noisier model and kept: blurring is cheap and temporary, but ending a
  // chat and reporting someone needs about three seconds of near-certain
  // explicit video.
  const GUARD = { BLUR: 0.75, CLEAR: 0.6, TRIP: 0.92, TRIP_STREAK: 3, EVERY_MS: 900 };
  const MODEL_URL = "vendor/nsfw/mobilenetv4-nsfw.onnx";
  const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225]; // ImageNet
  const S = 224;

  // ---------- media ----------
  async function openMedia() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      const e = new Error("This browser can't use the camera. Open Hooky in Safari or Chrome."); e.code = "no-camera"; throw e;
    }
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
      });
    } catch (err) {
      const e = new Error(err && err.name === "NotAllowedError"
        ? "Camera and mic access are off. Allow them for this site, then try again."
        : "We couldn't open your camera and mic."); e.code = "camera-denied"; throw e;
    }
  }

  // ---------- guard ----------
  let guardLoading = null;
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script"); s.src = src; s.async = true;
      s.onload = resolve; s.onerror = () => reject(new Error("Couldn't load the safety check. Check your connection and try again."));
      document.head.appendChild(s);
    });
  }
  // Live refuses to start without the guard: if it can't load, nobody goes live.
  // Resolves to { score(canvas) -> porn + hentai probability }.
  function loadGuard() {
    if (guardLoading) return guardLoading;
    guardLoading = (async () => {
      if (!window.ort) await loadScript("vendor/onnxruntime/ort.wasm.min.js");
      const ort = window.ort;
      ort.env.wasm.numThreads = 1; // threads need cross-origin isolation, which Pages can't set
      ort.env.wasm.wasmPaths = "vendor/onnxruntime/";
      const session = await ort.InferenceSession.create(MODEL_URL, { executionProviders: ["wasm"] });
      const input = new Float32Array(3 * S * S);
      const score = async (canvas) => {
        const d = canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, S, S).data;
        for (let i = 0; i < S * S; i++) {
          for (let c = 0; c < 3; c++) input[c * S * S + i] = (d[i * 4 + c] / 255 - MEAN[c]) / STD[c];
        }
        // One image, shaped [3, 224, 224]: this model takes no batch dimension.
        const out = await session.run({ [session.inputNames[0]]: new ort.Tensor("float32", input, [3, S, S]) });
        const l = Array.from(out[session.outputNames[0]].data);
        const m = Math.max(...l), e = l.map((v) => Math.exp(v - m)), sum = e.reduce((a, b) => a + b, 0);
        return (e[1] + e[3]) / sum; // labels: drawings, hentai, neutral, porn, sexy
      };
      // Warm up so the first real check is fast.
      const c = document.createElement("canvas"); c.width = c.height = S;
      await score(c);
      return { score };
    })();
    guardLoading.catch(() => { guardLoading = null; });
    return guardLoading;
  }

  // Watches a <video>. Callbacks: onState("checking" | "clear" | "hidden"),
  // onTrip() once, when the video is clearly explicit. Returns stop().
  function watch(video, model, { onState, onTrip }) {
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = S;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    let stopped = false, hidden = true, streak = 0, busy = false;
    onState("checking");
    const tick = async () => {
      if (stopped || busy) return;
      if (video.readyState < 2 || !video.videoWidth) return;
      busy = true;
      try {
        ctx.drawImage(video, 0, 0, S, S);
        const score = await model.score(canvas);
        if (stopped) return;
        streak = score >= GUARD.TRIP ? streak + 1 : 0;
        if (streak >= GUARD.TRIP_STREAK) { stopped = true; onState("hidden"); onTrip(score); return; }
        if (score >= GUARD.BLUR) { if (!hidden) { hidden = true; onState("hidden"); } }
        else if (hidden && score < GUARD.CLEAR) { hidden = false; onState("clear"); }
      } catch { /* a skipped frame is fine; the video stays as it was */ }
      finally { busy = false; }
    };
    const iv = setInterval(tick, GUARD.EVERY_MS);
    const kick = () => tick();
    setTimeout(kick, 50); // check the first frame right away, not a second later
    video.addEventListener("playing", kick);
    return () => { stopped = true; clearInterval(iv); video.removeEventListener("playing", kick); };
  }

  // ---------- peer ----------
  // Both sides say hello when their channel is ready and answer the first
  // hello they hear, so neither side's offer is lost to a late subscriber. The
  // person with the smaller user id makes the offer.
  function connect({ store, sessionId, me, partner, stream, iceServers, onRemote, onConnected, onChat, onEnd }) {
    let ended = false, connected = false;
    const finish = (reason) => {
      if (ended) return; ended = true;
      clearTimeout(timer);
      try { ch.send("bye", { reason }); } catch {}
      setTimeout(() => { try { ch.close(); } catch {} }, 300);
      if (pc) { try { pc.close(); } catch {} }
      onEnd && onEnd(reason);
    };

    // Demo: nobody is really on the other end.
    if (store.kind === "local") {
      setTimeout(() => { if (!ended) { connected = true; onRemote(null); onConnected(); } }, 700);
      return {
        sendChat(text) { if (!ended) setTimeout(() => { if (!ended) onChat(store.demoReply()); }, 900 + Math.random() * 1500); return text; },
        close(reason) { if (ended) return; ended = true; onEnd && onEnd(reason, true); },
      };
    }

    const ch = store.rouletteChannel(sessionId);
    const pc = new RTCPeerConnection({ iceServers: (window.HOOKY_CONFIG && window.HOOKY_CONFIG.iceServers) || iceServers });
    const pendingIce = [];
    let offered = false, repliedHello = false;
    const iAmCaller = String(me.id) < String(partner.id);
    stream.getTracks().forEach((t) => pc.addTrack(t, stream));
    pc.ontrack = (ev) => onRemote(ev.streams[0]);
    pc.onicecandidate = (ev) => { if (ev.candidate) ch.send("ice", ev.candidate); };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === "connected" && !connected) { connected = true; clearTimeout(timer); onConnected(); }
      if (s === "failed" || s === "closed") finish(connected ? "dropped" : "no-connect");
      if (s === "disconnected") setTimeout(() => { if (pc.connectionState === "disconnected") finish("dropped"); }, 4000);
    };
    const makeOffer = async () => {
      if (offered) return; offered = true;
      const o = await pc.createOffer(); await pc.setLocalDescription(o); ch.send("offer", pc.localDescription);
    };
    const flushIce = async () => { while (pendingIce.length) { try { await pc.addIceCandidate(pendingIce.shift()); } catch {} } };
    ch.on(async (m) => {
      if (ended) return;
      try {
        if (m.type === "hello") {
          if (!repliedHello) { repliedHello = true; ch.send("hello", {}); }
          if (iAmCaller) await makeOffer();
        } else if (m.type === "offer" && !iAmCaller) {
          await pc.setRemoteDescription(m.data); await flushIce();
          const a = await pc.createAnswer(); await pc.setLocalDescription(a); ch.send("answer", pc.localDescription);
        } else if (m.type === "answer" && iAmCaller) {
          await pc.setRemoteDescription(m.data); await flushIce();
        } else if (m.type === "ice") {
          if (pc.remoteDescription) { try { await pc.addIceCandidate(m.data); } catch {} } else pendingIce.push(m.data);
        } else if (m.type === "chat") {
          onChat(String((m.data && m.data.text) || "").slice(0, 300));
        } else if (m.type === "bye") {
          finish("left");
        }
      } catch { /* a bad signal just means this pairing won't connect; the timeout moves on */ }
    });
    ch.ready.then(() => { if (!ended) ch.send("hello", {}); });
    const timer = setTimeout(() => { if (!connected) finish("no-connect"); }, CONNECT_TIMEOUT_MS);

    return {
      sendChat(text) { ch.send("chat", { text }); return text; },
      close(reason) { finish(reason || "next"); },
    };
  }

  window.HookyLive = { openMedia, loadGuard, watch, connect, GUARD };
})();

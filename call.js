// Live video calls between two matched users.
// Demo mode shows your own camera and a placeholder for the other person.
// Real mode uses WebRTC with signaling over the store's call channel.
(function () {
  // STUN and TURN come from store.iceServers() (the turn-credentials function);
  // a config.js `iceServers` list overrides it.
  const configIce = () => window.HOOKY_CONFIG && window.HOOKY_CONFIG.iceServers;
  const E = window.HookyEmoji;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // Browsers may refuse to start sound that nobody tapped for (Edge on a
  // computer especially, when the call was answered on the other side). If
  // play() is refused, show one big button: the tap is what unlocks sound.
  function playOrAsk(el, container) {
    const p = el.play();
    if (!p || !p.catch) return;
    p.catch((err) => {
      if (!err || err.name !== "NotAllowedError" || container.querySelector(".tap-sound")) return;
      const b = document.createElement("button");
      b.className = "tap-sound btn lime";
      b.innerHTML = `${E.emo("megaphone", 24)} Tap to hear them`;
      b.onclick = () => { container.querySelectorAll("audio, video").forEach((m) => m.play().catch(() => {})); b.remove(); };
      container.appendChild(b);
    });
  }

  // mode is "video" or "voice". A voice call asks for no camera at all, which
  // is the point: some people want to talk without being on camera.
  function start({ store, me, other, matchId, isCaller, mode, onEnd, onReport }) {
    const voice = mode === "voice";
    const root = document.createElement("div");
    root.className = "call" + (voice ? " voice" : "");
    root.innerHTML = `
      <div class="call-remote" id="remote">
        <div class="call-placeholder" style="background:${other.gradient}">
          ${other.photo ? `<img src="${esc(other.photo)}" alt="">` : E.char(other.emoji || "😎", 180)}
        </div>
        <video id="remoteVideo" autoplay playsinline class="hidden"></video>
        <audio id="remoteAudio" autoplay class="hidden"></audio>
      </div>
      <video id="localVideo" class="call-local" autoplay muted playsinline></video>
      <div class="call-top">
        <div class="call-name">${esc(other.name)}${voice ? " · voice" : ""}</div>
        <div class="call-status" id="status">Connecting…</div>
        <div class="call-notes" id="notes"></div>
      </div>
      <div class="call-rules">${voice
        ? "Voice only · keep it appropriate · hang up any time"
        : "Face on · keep it appropriate · hang up any time"}</div>
      <div class="call-controls">
        <button class="cbtn" id="mute" title="Mute">${E.emo("mic", 30)}</button>
        ${voice ? "" : `<button class="cbtn" id="cam" title="Camera">${E.emo("camera", 30)}</button>`}
        <button class="cbtn end" id="end" title="End"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
        <button class="cbtn" id="report" title="Report">${E.emo("flag", 30)}</button>
      </div>`;
    document.getElementById("app").appendChild(root);

    const $ = (s) => root.querySelector(s);
    const status = $("#status"), remoteVideo = $("#remoteVideo"), localVideo = $("#localVideo");
    let stream = null, pc = null, ch = null, timer = null, startedAt = null, ended = false, health = null;

    // Notes say plainly what's missing in the call (and on whose side), and
    // stay put under the timer instead of being overwritten by it.
    const notes = {};
    function note(key, text) {
      if (text) notes[key] = text; else delete notes[key];
      $("#notes").innerHTML = Object.values(notes).map((t) => `<div>${esc(t)}</div>`).join("");
    }
    // Once connected, read the connection's own stats every two seconds:
    // are their video frames arriving, is there any sound from them, and is
    // this device's mic picking anything up. A silent mic is the classic
    // computer problem (Windows set to the wrong input device).
    function watchHealth() {
      const first = Date.now();
      let prev = null, quietThem = 0, quietMe = 0;
      health = setInterval(async () => {
        if (!pc || ended) return;
        let frames = 0, energyThem = 0, energyMe = 0, gotAudio = false, gotVideo = false;
        try {
          (await pc.getStats()).forEach((r) => {
            if (r.type === "inbound-rtp" && r.kind === "video") { gotVideo = true; frames += r.framesDecoded || 0; }
            if (r.type === "inbound-rtp" && r.kind === "audio") { gotAudio = true; energyThem += r.totalAudioEnergy || 0; }
            if (r.type === "media-source" && r.kind === "audio") energyMe += r.totalAudioEnergy || 0;
          });
        } catch { return; }
        const warm = Date.now() - first > 5000;
        if (prev) {
          quietThem = energyThem - prev.energyThem < 1e-6 ? quietThem + 1 : 0;
          quietMe = energyMe - prev.energyMe < 1e-6 ? quietMe + 1 : 0;
        }
        const micOn = stream && stream.getAudioTracks().some((t) => t.enabled);
        if (!voice) note("theirVideo", warm && (!gotVideo || frames === (prev ? prev.frames : 0)) ? `No video from ${other.name}: their camera may be off or blocked` : null);
        note("theirSound", warm && (!gotAudio || quietThem >= 3) ? `No sound from ${other.name} yet. If they're talking, their mic may be muted or not working` : null);
        note("mySound", warm && micOn && quietMe >= 3 ? "Your mic isn't picking anything up. If you're talking, check the microphone in your device's sound settings" : null);
        prev = { frames, energyThem, energyMe };
      }, 2000);
    }

    function tick() {
      const s = Math.floor((Date.now() - startedAt) / 1000);
      status.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    }
    function connected() {
      if (startedAt) return;
      startedAt = Date.now(); tick(); timer = setInterval(tick, 1000);
      if (pc) watchHealth();
      root.classList.add("live");
    }
    function end(reason) {
      if (ended) return; ended = true;
      clearInterval(timer); clearInterval(health);
      stream && stream.getTracks().forEach((t) => t.stop());
      pc && pc.close();
      if (ch) { ch.send("end", {}); setTimeout(() => ch.close(), 300); }
      root.classList.add("out");
      setTimeout(() => root.remove(), 250);
      onEnd && onEnd({ seconds: startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0, reason });
    }

    $("#end").onclick = () => end("hangup");
    $("#report").onclick = () => { end("report"); onReport && onReport(); };
    $("#mute").onclick = (e) => { if (!stream) return; const t = stream.getAudioTracks()[0]; if (!t) return; t.enabled = !t.enabled; e.currentTarget.classList.toggle("off", !t.enabled); };
    $("#cam") && ($("#cam").onclick = (e) => { if (!stream) return; const t = stream.getVideoTracks()[0]; if (!t) return; t.enabled = !t.enabled; e.currentTarget.classList.toggle("off", !t.enabled); });

    (async () => {
      // Step down to plainer requests before giving up (some webcams refuse
      // the preferred size), and for video let a camera-only or mic-only
      // computer still join, since half a call beats none.
      const tries = voice ? [{ audio: true }]
        : [{ video: { facingMode: "user", width: { ideal: 640 } }, audio: true }, { video: true, audio: true }, { video: true, audio: false }, { video: false, audio: true }];
      let lastErr = null;
      for (const c of tries) {
        try { stream = await navigator.mediaDevices.getUserMedia(c); break; }
        catch (err) { lastErr = err; if (err && (err.name === "NotAllowedError" || err.name === "SecurityError")) break; }
      }
      if (stream) {
        if (voice || !stream.getVideoTracks().length) localVideo.classList.add("hidden"); else localVideo.srcObject = stream;
        if (!stream.getAudioTracks().length) note("myMic", "No microphone found: they can't hear you");
        if (!voice && !stream.getVideoTracks().length) note("myCam", `Your camera didn't start: they can't see you. ${window.HookyLive ? window.HookyLive.mediaErrorText(lastErr) : ""}`.trim());
      } else {
        const why = voice && lastErr && lastErr.name === "NotFoundError" ? "No microphone found"
          : window.HookyLive && window.HookyLive.mediaErrorText ? window.HookyLive.mediaErrorText(lastErr) : "Camera or mic blocked";
        status.textContent = why;
        localVideo.classList.add("hidden");
        if (store.kind === "local") setTimeout(connected, 800);
        else { setTimeout(() => end("no-media"), 5000); return; }
      }

      if (store.kind === "local") {
        // Demo: nobody on the other end, so just show the placeholder as "connected".
        setTimeout(connected, 1500);
        return;
      }

      // Real call: WebRTC over the store's signaling channel. The two phones
      // open the call at different moments (camera prompts, network), and a
      // broadcast sent before the other side is listening is simply lost. So
      // each side says hello once it's listening, and the caller only makes
      // the offer after hearing the other side's hello, the same handshake Live
      // uses. Candidates that arrive before the offer or answer are queued.
      ch = store.callChannel(matchId);
      const iceServers = configIce() || (store.iceServers ? await store.iceServers() : [{ urls: "stun:stun.l.google.com:19302" }]);
      if (ended) return;
      pc = new RTCPeerConnection({ iceServers });
      stream && stream.getTracks().forEach((t) => pc.addTrack(t, stream));
      const pendingIce = [];
      let offered = false, repliedHello = false;
      // ontrack fires once per track. Audio always plays through the <audio>
      // element; the <video> only shows once there is a video track, so a
      // mic-only caller leaves their photo up instead of a black screen.
      pc.ontrack = (ev) => {
        const audioEl = $("#remoteAudio");
        if (ev.track.kind === "audio") { audioEl.srcObject = new MediaStream([ev.track]); playOrAsk(audioEl, root); }
        else if (!voice) { remoteVideo.muted = true; remoteVideo.srcObject = new MediaStream([ev.track]); remoteVideo.classList.remove("hidden"); playOrAsk(remoteVideo, root); }
      };
      pc.onicecandidate = (ev) => { if (ev.candidate) ch.send("ice", ev.candidate); };
      pc.onconnectionstatechange = () => {
        const s = pc.connectionState;
        if (s === "connected") { clearTimeout(giveUp); connected(); }
        else if (s === "failed" || s === "closed") end(startedAt ? "dropped" : "no-connect");
        // Wi-Fi to cellular hand-offs blip "disconnected" and usually recover.
        else if (s === "disconnected") setTimeout(() => { if (pc.connectionState === "disconnected") end("dropped"); }, 5000);
      };
      const makeOffer = async () => {
        if (offered) return; offered = true;
        const o = await pc.createOffer(); await pc.setLocalDescription(o); ch.send("offer", pc.localDescription);
      };
      const flushIce = async () => { while (pendingIce.length) { try { await pc.addIceCandidate(pendingIce.shift()); } catch {} } };
      ch.on(async (msg) => {
        if (ended) return;
        try {
          if (msg.type === "hello") {
            if (!repliedHello) { repliedHello = true; ch.send("hello", {}); }
            if (isCaller) await makeOffer();
          } else if (msg.type === "offer" && !isCaller) {
            status.textContent = "Connecting…";
            await pc.setRemoteDescription(msg.data); await flushIce();
            const a = await pc.createAnswer(); await pc.setLocalDescription(a); ch.send("answer", pc.localDescription);
          } else if (msg.type === "answer" && isCaller) {
            await pc.setRemoteDescription(msg.data); await flushIce();
          } else if (msg.type === "ice") {
            if (pc.remoteDescription) { try { await pc.addIceCandidate(msg.data); } catch {} } else pendingIce.push(msg.data);
          } else if (msg.type === "end") { end("remote"); }
        } catch { /* a bad signal means this call won't connect; the timeout ends it */ }
      });
      ch.ready.then(() => { if (!ended) ch.send("hello", {}); });
      const giveUp = setTimeout(() => { if (!startedAt) end("no-connect"); }, 30000);
    })();

    return { end };
  }

  window.HookyCall = { start, playOrAsk };
})();

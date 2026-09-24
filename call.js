// Live video calls between two matched users.
// Demo mode shows your own camera and a placeholder for the other person.
// Real mode uses WebRTC with signaling over the store's call channel.
(function () {
  const ICE = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // mode is "video" or "voice". A voice call asks for no camera at all, which
  // is the point: some people want to talk without being on camera.
  function start({ store, me, other, matchId, isCaller, mode, onEnd, onReport }) {
    const voice = mode === "voice";
    const root = document.createElement("div");
    root.className = "call" + (voice ? " voice" : "");
    root.innerHTML = `
      <div class="call-remote" id="remote">
        <div class="call-placeholder" style="background:${other.gradient}">
          ${other.photo ? `<img src="${esc(other.photo)}" alt="">` : `<span>${esc(other.emoji || "🙂")}</span>`}
        </div>
        <video id="remoteVideo" autoplay playsinline class="hidden"></video>
        <audio id="remoteAudio" autoplay class="hidden"></audio>
      </div>
      <video id="localVideo" class="call-local" autoplay muted playsinline></video>
      <div class="call-top">
        <div class="call-name">${esc(other.name)}${voice ? " · voice" : ""}</div>
        <div class="call-status" id="status">Connecting…</div>
      </div>
      <div class="call-rules">${voice
        ? "Voice only · keep it appropriate · hang up any time"
        : "Face on · keep it appropriate · hang up any time"}</div>
      <div class="call-controls">
        <button class="cbtn" id="mute" title="Mute">🎤</button>
        ${voice ? "" : `<button class="cbtn" id="cam" title="Camera">📷</button>`}
        <button class="cbtn end" id="end" title="End">✕</button>
        <button class="cbtn" id="report" title="Report">⚑</button>
      </div>`;
    document.getElementById("app").appendChild(root);

    const $ = (s) => root.querySelector(s);
    const status = $("#status"), remoteVideo = $("#remoteVideo"), localVideo = $("#localVideo");
    let stream = null, pc = null, ch = null, timer = null, startedAt = null, ended = false;

    function tick() {
      const s = Math.floor((Date.now() - startedAt) / 1000);
      status.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    }
    function connected() {
      if (startedAt) return;
      startedAt = Date.now(); tick(); timer = setInterval(tick, 1000);
      root.classList.add("live");
    }
    function end(reason) {
      if (ended) return; ended = true;
      clearInterval(timer);
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
      try {
        stream = await navigator.mediaDevices.getUserMedia(voice
          ? { audio: true }
          : { video: { facingMode: "user", width: { ideal: 640 } }, audio: true });
        if (voice) localVideo.classList.add("hidden"); else localVideo.srcObject = stream;
      } catch {
        status.textContent = voice ? "Microphone blocked" : "Camera or mic blocked";
        localVideo.classList.add("hidden");
        if (store.kind === "local") setTimeout(connected, 800);
        else { setTimeout(() => end("no-media"), 1500); return; }
      }

      if (store.kind === "local") {
        // Demo: nobody on the other end, so just show the placeholder as "connected".
        setTimeout(connected, 1500);
        return;
      }

      // Real call: WebRTC over the store's signaling channel.
      ch = store.callChannel(matchId);
      pc = new RTCPeerConnection(ICE);
      stream && stream.getTracks().forEach((t) => pc.addTrack(t, stream));
      pc.ontrack = (ev) => {
        if (voice) { $("#remoteAudio").srcObject = ev.streams[0]; }
        else { remoteVideo.srcObject = ev.streams[0]; remoteVideo.classList.remove("hidden"); }
        connected();
      };
      pc.onicecandidate = (ev) => { if (ev.candidate) ch.send("ice", ev.candidate); };
      pc.onconnectionstatechange = () => { if (["failed", "disconnected", "closed"].includes(pc.connectionState) && startedAt) end("dropped"); };
      ch.on(async (msg) => {
        if (ended) return;
        if (msg.type === "offer") { await pc.setRemoteDescription(msg.data); const a = await pc.createAnswer(); await pc.setLocalDescription(a); ch.send("answer", pc.localDescription); }
        else if (msg.type === "answer") { await pc.setRemoteDescription(msg.data); }
        else if (msg.type === "ice") { try { await pc.addIceCandidate(msg.data); } catch {} }
        else if (msg.type === "end") { end("remote"); }
      });
      if (isCaller) { const o = await pc.createOffer(); await pc.setLocalDescription(o); ch.send("offer", pc.localDescription); }
    })();

    return { end };
  }

  window.HookyCall = { start };
})();

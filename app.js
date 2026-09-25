// Hooky UI. Plain DOM, no build step.
// Vocabulary: a "hook" is a like, a "catch" is a match, and Hooky+ / Hooky Max
// are the paid tiers.
//
// Signup order: Sign up -> on-device face age check -> email + password ->
// confirm email -> log in -> set up profile -> browse.
(function () {
  const S = window.HookySafety, E = window.HookyEmoji, AC = window.HookyAgeCheck;
  const { LocalStore, SupabaseStore, FREE_DAILY_LIKES, gradientFor } = window.HookyStore;
  const $ = (sel, el = document) => el.querySelector(sel);
  const screen = $("#screen"), tabs = $("#tabs"), modalRoot = $("#modal-root"), toastEl = $("#toast");
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const emo = E.emo;

  const svg = (d, w = 3) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const ICON = {
    arrow: svg(`<path d="M5 12h14M13 6l6 6-6 6"/>`),
    back: svg(`<path d="M15 5l-7 7 7 7"/>`),
    x: svg(`<path d="M6 6l12 12M18 6L6 18"/>`, 3.4),
    undo: svg(`<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 010 11H11"/>`, 2.6),
    send: svg(`<path d="M5 12l14-7-5 15-3-6-6-2z"/>`, 2.4),
    more: svg(`<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>`, 2.6),
    plus: svg(`<path d="M12 5v14M5 12h14"/>`, 3.6),
    spin: svg(`<path d="M12 3a9 9 0 1 0 9 9"/>`, 3),
  };

  const store = window.HOOKY_CONFIG && window.HOOKY_CONFIG.supabaseUrl && !/YOUR-PROJECT/.test(window.HOOKY_CONFIG.supabaseUrl)
    ? new SupabaseStore(window.HOOKY_CONFIG) : new LocalStore();
  const real = store.kind === "supabase";

  const SUPPORT_EMAIL = "support@example.com"; // change before shipping
  const state = { me: null, tab: "discover", draft: {}, step: 0, chatId: null, onlineOnly: false, inCall: false, ageCheck: null, leave: null };
  try { state.ageCheck = JSON.parse(sessionStorage.getItem("hooky.ageCheck")) || null; } catch {}

  const GENDERS = S.GENDERS;
  const ALL_GENDERS = GENDERS.map((g) => g.id);
  const GENDER_PLURAL = Object.fromEntries(GENDERS.map((g) => [g.id, g.plural]));

  // ---------- helpers ----------
  function toast(msg, ms = 2400) { toastEl.textContent = msg; toastEl.classList.remove("hidden"); clearTimeout(toast.t); toast.t = setTimeout(() => toastEl.classList.add("hidden"), ms); }
  function buzz(p = 12) { if (navigator.vibrate && (!navigator.userActivation || navigator.userActivation.hasBeenActive)) navigator.vibrate(p); }
  function modal(html, opts) {
    const onMount = typeof opts === "function" ? opts : opts && opts.onMount;
    modalRoot.innerHTML = `<div class="modal-bg"><div class="modal"><div class="handle"></div>${html}</div></div>`;
    const bg = $(".modal-bg", modalRoot);
    bg.addEventListener("click", (e) => { if (e.target === bg && !(opts && opts.sticky)) closeModal(); });
    onMount && onMount(bg);
  }
  function closeModal() { modalRoot.innerHTML = ""; }
  // Swap the whole screen. Runs the previous screen's cleanup first (camera,
  // realtime subscriptions) so nothing keeps running in the background.
  function paint(html) {
    if (state.leave) { const f = state.leave; state.leave = null; try { f(); } catch {} }
    screen.onclick = null;
    screen.innerHTML = html;
    screen.scrollTop = 0;
  }
  function avatarHtml(u, cls = "", online) {
    const size = /xl/.test(cls) ? 92 : /lg/.test(cls) ? 70 : /sm/.test(cls) ? 26 : 34;
    const inner = u.photo ? `<img src="${esc(u.photo)}" alt="">` : E.char(u.emoji || "😎", size);
    const av = `<div class="avatar ${cls}" style="background:${u.gradient || gradientFor(u.id || u.name || "me")}">${inner}</div>`;
    return online === undefined ? av : `<div class="avatar-wrap ${online ? "online" : ""}">${av}</div>`;
  }
  function timeAgo(t) { const d = (Date.now() - t) / 60000; if (d < 1) return "now"; if (d < 60) return Math.floor(d) + "m"; if (d < 1440) return Math.floor(d / 60) + "h"; return Math.floor(d / 1440) + "d"; }
  function setTabsVisible(v) { tabs.classList.toggle("hidden", !v); }
  async function refreshUnread() {
    try {
      const n = await store.totalUnread();
      const b = $("#unread"); b.textContent = n; b.classList.toggle("hidden", !n);
    } catch {}
  }
  function hooksLeftText(l) { return l === Infinity ? "Unlimited hooks with your plan" : `${l} of ${FREE_DAILY_LIKES} hooks left today`; }
  function legalLine(prefix = "By continuing you agree to the") {
    return `<p class="legal-line">${prefix} <a href="legal.html#terms" target="_blank">Terms</a>, <a href="legal.html#privacy" target="_blank">Privacy Policy</a> and <a href="legal.html#guidelines" target="_blank">Community Guidelines</a>.</p>`;
  }
  function nextBtn(disabled) { return `<button class="next" id="next" aria-label="Continue" ${disabled ? "disabled" : ""}>${ICON.arrow}</button>`; }
  function busy(btn, on) {
    if (!btn) return;
    btn.disabled = on;
    if (btn.classList.contains("next")) { btn.classList.toggle("busy", on); btn.innerHTML = on ? ICON.spin : ICON.arrow; }
  }
  // Standard onboarding page: top bar, huge headline with a sticker, body, footer.
  function flowHtml({ back = true, skip = false, bar = null, title, sticker, stickerL = false, lead = "", body = "", foot = "" }) {
    const segs = bar ? `<div class="bar">${Array.from({ length: bar[1] }, (_, i) => `<i class="${i <= bar[0] ? "on" : ""}"></i>`).join("")}</div>` : `<div class="grow"></div>`;
    return `<div class="flow">
      <div class="flow-top">${back ? `<button class="back" id="back" aria-label="Back">${ICON.back}</button>` : ""}${segs}${skip ? `<button class="textbtn" id="skip">Skip</button>` : ""}</div>
      <div class="flow-head"><h1 class="display">${title}</h1>${sticker ? emo(sticker, 86, "sticker" + (stickerL ? " l" : "")) : ""}</div>
      ${lead ? `<p class="lead">${lead}</p>` : ""}
      <div class="flow-body">${body}</div>
      <div class="flow-foot">${foot}</div>
    </div>`;
  }
  function saveAgeCheckLocal(ac) {
    state.ageCheck = ac;
    try { ac ? sessionStorage.setItem("hooky.ageCheck", JSON.stringify(ac)) : sessionStorage.removeItem("hooky.ageCheck"); } catch {}
  }

  // ---------- boot ----------
  let bootToken = 0;
  async function boot() {
    const token = ++bootToken;
    await store.init();
    if (token !== bootToken) return;
    setTabsVisible(false);
    if (real && store.recovery) return renderNewPassword();
    if (real && !store.uid) { state.me = null; return renderWelcome(); }
    state.me = await store.getMe().catch(() => null);
    if (token !== bootToken) return;
    if (!state.me || !state.me.name) {
      if (!real && !store.ageCheck()) return renderWelcome();
      if (!store.ageCheck()) return renderAgeIntro("account");
      return startSetup();
    }
    // Accounts from before the age check existed: nobody sees them in the deck
    // until they do it, so send them through it once.
    if (real && !state.me.verification) {
      if (!store.ageCheck()) return renderAgeIntro("account");
      try { await store.claimAgeCheck(); state.me = await store.getMe(); }
      catch (e) { return renderClaimFail(e); }
    }
    paintMeTab();
    showTab("discover");
  }
  function hideSplash() {
    const splash = $("#splash");
    if (splash) { setTimeout(() => splash.classList.add("out"), 450); setTimeout(() => splash.remove(), 850); }
  }
  if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("sw.js").catch(() => {});

  // Confirming an email or opening a reset link signs in asynchronously, so
  // redraw the moment the session flips.
  if (real) {
    let signedIn = null, recovering = false;
    store.onChange(() => {
      if (store.recovery && !recovering) { recovering = true; return renderNewPassword(); }
      const now = !!store.uid;
      if (signedIn !== null && now !== signedIn && !store.recovery) { signedIn = now; boot(); }
      signedIn = now;
    });
  }

  function paintMeTab() {
    const img = $("#meTabIcon"); if (!img || !state.me) return;
    const slug = E.BY_CHAR[state.me.emoji];
    img.classList.toggle("me-photo", !!state.me.photo);
    if (state.me.photo) img.src = state.me.photo;
    else if (slug) img.src = `assets/emoji/${slug}.webp`;
  }

  // ---------- incoming calls ----------
  store.subscribeCalls(async (p) => {
    if (p.type !== "ring" || state.inCall) return;
    const m = (await store.matches()).find((x) => x.id === p.matchId); if (!m) return;
    const voice = p.mode === "voice";
    buzz([80, 60, 80]);
    modal(`<div class="ringing">${avatarHtml(m.user, "lg")}<h2>${esc(m.user.name)} wants to ${voice ? "talk" : "go live"}</h2><p class="muted small">${voice ? "Voice call" : "Video call"}, right now, inside Hooky. Keep it appropriate, and hang up any time.</p></div>
      <button class="btn lime" id="accept">${emo(voice ? "receiver" : "video-camera", 26)} ${voice ? "Answer" : "Go live"}</button>
      <button class="btn dark" id="decline">Not now</button>`, { sticky: true, onMount: () => {
      $("#decline").onclick = async () => { closeModal(); await store.answerCall(p.matchId, p.from, false); };
      $("#accept").onclick = async () => { closeModal(); await store.answerCall(p.matchId, p.from, true); startCall(m, false, p.mode); };
    } });
  });

  function startCall(m, isCaller, mode) {
    state.inCall = true;
    window.HookyCall.start({ store, me: state.me, other: m.user, matchId: m.id, isCaller, mode,
      onEnd: async ({ seconds, reason }) => {
        state.inCall = false;
        const kind = mode === "voice" ? "Voice call" : "Video call";
        if (seconds > 0) await store.addSystemMessage(m.id, `${kind} · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`);
        if (reason !== "report") toast(seconds ? "Call ended" : "Couldn't connect");
        if (state.chatId === m.id) openChat(m.id);
      },
      onReport: () => openReport(m.user, () => showTab("matches")),
    });
  }

  // mode is "voice" or "video". Voice never asks for the camera at all.
  async function ringUser(m, mode) {
    if (!store.isOnline(m.userId)) return toast(`${m.user.name} isn't online right now`);
    const voice = mode === "voice";
    modal(`${emo(voice ? "receiver" : "video-camera", 76, "sheet-sticker sticker")}
      <h2 class="center">${voice ? "Voice call" : "Video call"} with ${esc(m.user.name)}?</h2>
      <p class="muted small center">${voice ? "Audio only, inside Hooky. Your camera stays off." : "A video call inside Hooky."} Nothing is recorded, nothing is saved.</p>
      <div class="note">${emo("shield", 22)}<div>${voice ? "Keep it appropriate." : "Face on. Keep it appropriate."} If anyone asks you to do or say something you don't want to, hang up and report. You're never in trouble for ending a call.</div></div><br>
      <button class="btn lime" id="ring">Ring ${esc(m.user.name)}</button>`, () => {
      $("#ring").onclick = async () => {
        modal(`<div class="ringing">${avatarHtml(m.user, "lg")}<h2>Ringing ${esc(m.user.name)}…</h2><p class="muted small">They have 30 seconds to pick up.</p></div><button class="btn dark" id="cancel">Cancel</button>`, { sticky: true, onMount: () => { $("#cancel").onclick = () => { closeModal(); state.cancelRing = true; }; } });
        state.cancelRing = false;
        const res = await store.requestCall(m.id, mode);
        if (state.cancelRing) return;
        closeModal();
        if (res.accepted) startCall(m, true, mode);
        else toast(res.timeout ? `${m.user.name} didn't pick up` : `${m.user.name} can't right now`);
      };
    });
  }

  function askCallKind(m) {
    if (!store.isOnline(m.userId)) return toast(`${m.user.name} isn't online right now`);
    modal(`<h2 class="center">Call ${esc(m.user.name)}</h2>
      <p class="muted small center">You're both online.</p>
      <button class="btn lime" id="cVoice">${emo("receiver", 26)} Voice call</button>
      <button class="btn grad" id="cVideo">${emo("video-camera", 26)} Video call</button>`, () => {
      $("#cVoice").onclick = () => { closeModal(); ringUser(m, "voice"); };
      $("#cVideo").onclick = () => { closeModal(); ringUser(m, "video"); };
    });
  }

  // =====================================================================
  // Welcome
  // =====================================================================
  // A little planet of 3D emoji floating around the app icon.
  const WORLD = [
    ["fishing-pole", 8, 10, 74, -12, 7], ["sunglasses", 62, 4, 66, 10, 6], ["video-game", 78, 26, 58, -8, 8],
    ["headphone", 4, 38, 60, 8, 6.5], ["pizza", 30, 18, 48, 14, 7.5], ["tropical-fish", 70, 50, 70, -6, 6],
    ["party", 14, 64, 56, 12, 8], ["sparkling-heart", 46, 74, 50, -10, 7], ["skateboard", 76, 74, 58, 16, 6.8],
    ["star-struck", 38, 2, 44, -6, 9], ["mic", 88, 6, 42, 12, 7], ["palette", 0, 84, 46, -14, 7.2],
    ["bubble-tea", 58, 30, 38, 8, 8.4], ["rocket", 22, 44, 36, -18, 6.2], ["ghost", 88, 88, 40, 6, 7.8],
    ["basketball", 32, 88, 38, 0, 6.6],
  ];
  function renderWelcome() {
    setTabsVisible(false);
    const blobs = [["#ff4f8b", 10, 10, 200], ["#c8ff4f", 60, 45, 180], ["#38bdf8", -10, 60, 190], ["#a78bfa", 70, -5, 170]]
      .map(([c, x, y, s]) => `<i class="blob" style="background:${c};left:${x}%;top:${y}%;width:${s}px;height:${s}px"></i>`).join("");
    const floaters = WORLD.map(([slug, x, y, size, r, d], i) =>
      `<span class="e" style="left:${x}%;top:${y}%;width:${size}px;height:${size}px;--r:${r}deg;--d:${d}s;--dx:${(i % 3) * 4 - 4}px;--dy:${-8 - (i % 4) * 3}px;animation-delay:${i * 40}ms,${i * 40 + 700}ms">${emo(slug, size, "sticker")}</span>`).join("");
    paint(`<div class="welcome">
      <div class="world">${blobs}${floaters}<div class="logo-center"><img class="icon" src="assets/icon-192.png" alt=""></div></div>
      <div class="welcome-foot">
        <h1 class="display grad-text" style="padding-bottom:4px">Catch your people.</h1>
        <p class="lead">Swipe, match and go live with people your age. Friends, not dating.</p>
        <button class="btn lime" id="signup">Sign up</button>
        <button class="btn white" id="login">Log in</button>
        ${legalLine("13 to 25 only. By continuing you agree to the")}
      </div>
    </div>`);
    $("#signup").onclick = () => { buzz(8); renderAgeIntro("signup"); };
    $("#login").onclick = () => {
      if (!real) return toast("Demo mode has no accounts. Tap Sign up to try it.");
      renderLogin();
    };
  }

  // =====================================================================
  // Age check (runs entirely on this device)
  // =====================================================================
  // mode: "signup" (before an account exists) or "account" (signed in, but
  // the account predates the check).
  function renderAgeIntro(mode) {
    setTabsVisible(false);
    const row = (slug, t, s) => `<div class="prow"><div class="ico">${emo(slug, 34)}</div><div><b>${t}</b><span>${s}</span></div></div>`;
    paint(flowHtml({
      title: "Quick age check", sticker: "shield",
      lead: "Hooky is for 13 to 25, and everyone only meets people close to their own age. A 10 second selfie scan keeps it that way.",
      body: `<div class="plist">
        ${row("phone", "It happens on your phone", "Your camera is analyzed right here, on this device. The video never leaves it.")}
        ${row("prohibited", "Sent to no one", "No photo or video goes to Hooky's servers or to any outside company.")}
        ${row("locked", "No biometric data collected", "We never create or store a faceprint. We keep one thing: the age estimate.")}
        ${row("wastebasket", "Camera off when it's done", "The camera switches off the moment the scan finishes.")}
      </div>`,
      foot: `<button class="btn lime" id="go">${emo("camera", 26)} Start the scan</button>${legalLine()}`,
    }));
    $("#back").onclick = async () => { if (mode === "account") { await store.signOut(); boot(); } else renderWelcome(); };
    $("#go").onclick = () => renderAgeScan(mode);
    AC.load().catch(() => {}); // warm the models up while they read
  }

  const HINTS = {
    "no-face": ["eyes", "Look at the camera"],
    many: ["see-no-evil", "Just you in the frame"],
    closer: ["magnifier", "Move a little closer"],
    back: ["hand-stop", "Back up a little"],
    center: ["dart", "Center your face in the oval"],
    light: ["bulb", "Find some more light"],
    hold: ["sparkles", "Hold still…", "go"],
    smile: ["grin", "Now give us a big smile!", "ask"],
    neutral: ["thinking", "Now a straight face", "ask"],
  };
  function renderAgeScan(mode) {
    setTabsVisible(false);
    paint(`<div class="flow">
      <div class="flow-top"><button class="back" id="back" aria-label="Back">${ICON.back}</button><div class="grow"></div></div>
      <h1 class="display h-md center" style="margin:6px 0 16px">Fit your face in the oval</h1>
      <div class="scan">
        <video id="cam" playsinline muted autoplay></video>
        <svg class="mask" viewBox="0 0 300 400" preserveAspectRatio="xMidYMid slice">
          <path fill="rgba(11,10,16,0.74)" fill-rule="evenodd" d="M0 0h300v400H0z M48 200a102 138 0 1 0 204 0a102 138 0 1 0 -204 0z"/>
          <ellipse class="ring-track" cx="150" cy="200" rx="102" ry="138"/>
          <ellipse class="ring" id="ring" cx="150" cy="200" rx="102" ry="138" pathLength="100" stroke-dasharray="100" stroke-dashoffset="100" transform="rotate(-90 150 200)"/>
        </svg>
        <div class="loading" id="loading"><div>${emo("hourglass", 56)}<div style="margin-top:10px" id="loadTxt">Starting the camera…</div></div></div>
        <div class="scan-hint hidden" id="hint"></div>
      </div>
      <div class="flow-foot" style="padding-top:16px">
        <div class="note blue" style="width:100%">${emo("bulb", 30)}<div>Face a light and take off sunglasses, hats or masks. Everything stays on this phone.</div></div>
      </div>
    </div>`);
    const video = $("#cam"), ring = $("#ring"), hintEl = $("#hint");
    let stream = null, job = null;
    const cleanup = () => { job && job.cancel(); job = null; if (stream) stream.getTracks().forEach((t) => t.stop()); stream = null; };
    state.leave = cleanup;
    $("#back").onclick = () => renderAgeIntro(mode);

    const setHint = (code) => {
      const [slug, text, cls] = HINTS[code] || HINTS.hold;
      hintEl.className = "scan-hint " + (cls || "");
      hintEl.innerHTML = `${emo(slug, 22)}${text}`;
      if (cls === "ask") buzz(20);
    };
    (async () => {
      try {
        const loadP = AC.load((p) => { const t = $("#loadTxt"); if (t && stream) t.textContent = `Getting ready… ${Math.round(p * 100)}%`; });
        stream = await AC.openCamera();
        if (!screen.contains(video)) return cleanup();
        video.srcObject = stream;
        await video.play().catch(() => {});
        await loadP;
        if (!screen.contains(video)) return cleanup();
        $("#loading").remove();
        hintEl.classList.remove("hidden");
        setHint("no-face");
        job = AC.run(video, {
          onHint: setHint,
          onProgress: (p) => { ring.setAttribute("stroke-dashoffset", String(100 - p * 100)); },
        });
        const res = await job.promise;
        cleanup(); state.leave = null;
        buzz([20, 40, 20]);
        renderAgeResult(mode, res);
      } catch (e) {
        cleanup(); state.leave = null;
        if (e.code === "cancelled" || !screen.contains(video)) return;
        renderAgeFail(mode, e);
      }
    })();
  }

  // Out-of-range results are rate limited, so nobody can keep re-rolling the
  // camera until a lucky reading gets them in.
  function tooOldTries(add) {
    let t = [];
    try { t = JSON.parse(localStorage.getItem("hooky.ageOut") || "[]").filter((x) => Date.now() - x < 86400000); } catch {}
    if (add) { t.push(Date.now()); try { localStorage.setItem("hooky.ageOut", JSON.stringify(t)); } catch {} }
    return t.length;
  }

  function renderAgeResult(mode, res) {
    if (!S.estimateAllowsSignup(res.estimate)) {
      const n = tooOldTries(true);
      const locked = n >= 3;
      paint(flowHtml({
        back: false, title: "Hooky's for 13 to 25", sticker: "see-no-evil",
        lead: locked
          ? "The scan keeps saying you look outside Hooky's age range, so it's paused for today. Nothing about your face was saved."
          : "The scan says you look outside Hooky's age range. Bad lighting can throw it off, so you can try again. Nothing about your face was saved.",
        foot: `${locked ? "" : `<button class="btn lime" id="retry">Try again</button>`}<button class="btn dark" id="home">Back to start</button>`,
      }));
      $("#retry") && ($("#retry").onclick = () => renderAgeScan(mode));
      $("#home").onclick = async () => { if (mode === "account") { await store.signOut(); boot(); } else renderWelcome(); };
      return;
    }
    const check = { estimate: res.estimate, method: res.method, engine: res.engine, liveness: res.liveness, at: res.at, v: 1 };
    paint(flowHtml({
      back: false, title: "You're good to go!",
      body: `<div class="age-card">
          ${emo("party", 70, "sticker s1")}<div class="label"><div class="display">${S.estimateLabel(res.estimate)}</div><small>years old, roughly</small></div>
          ${emo("sparkles", 70, "sticker l s2")}
        </div>
        <div class="note lime">${emo("check", 26)}<div>The camera is off. We kept just that estimate, nothing else. Your birthday will need to fit it.</div></div>`,
      foot: `<button class="next" id="next" aria-label="Continue">${ICON.arrow}</button>`,
    }));
    $("#next").onclick = async (ev) => {
      const btn = ev.currentTarget;
      if (mode === "signup" && real) { saveAgeCheckLocal(check); return renderCreateAccount(); }
      busy(btn, true);
      try {
        await store.saveAgeCheck(check);
        // An existing profile gets the result applied; a new one is set up next.
        if (state.me && state.me.name) boot(); else startSetup();
      } catch (e) { busy(btn, false); toast(e.message); }
    };
  }

  // An older account whose birthday doesn't fit its fresh age check.
  function renderClaimFail(e) {
    const mismatch = /does not match/i.test(e.message || "");
    if (!mismatch) return renderAgeIntro("account");
    paint(flowHtml({
      back: false, title: "That doesn't add up", sticker: "thinking",
      lead: "Your birthday on Hooky doesn't match your age check, so your profile stays hidden for now. Bad lighting can throw the scan off, so you can try again.",
      foot: `<button class="btn lime" id="retry">Scan again</button><button class="btn dark" id="out">Log out</button>
        <p class="legal-line">Birthday wrong? Email <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>`,
    }));
    $("#retry").onclick = () => renderAgeScan("account");
    $("#out").onclick = async () => { await store.signOut(); boot(); };
  }

  function renderAgeFail(mode, e) {
    const sticker = { "camera-denied": "camera", "no-camera": "camera", "virtual-camera": "robot", timeout: "thinking", liveness: "grin" }[e.code] || "crying";
    const title = { "camera-denied": "Camera's off", "no-camera": "No camera here", "virtual-camera": "Real camera only" }[e.code] || "Let's try that again";
    paint(flowHtml({
      title, sticker, lead: esc(e.message || "Something went wrong with the scan."),
      body: e.code === "camera-denied" ? `<div class="note">${emo("gear", 24)}<div>On iPhone: Settings, then Safari, then Camera, and choose Allow. On Android: tap the lock by the address bar, then Permissions.</div></div>` : "",
      foot: `<button class="btn lime" id="retry">Try again</button>`,
    }));
    $("#back").onclick = () => renderAgeIntro(mode);
    $("#retry").onclick = () => renderAgeScan(mode);
  }

  // =====================================================================
  // Account: create, confirm email, log in, reset password
  // =====================================================================
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  function pwField(id, placeholder, auto) {
    return `<div class="pw-wrap"><input id="${id}" class="input" type="password" placeholder="${placeholder}" autocomplete="${auto}" minlength="8"><button class="pw-toggle" type="button" data-pw="${id}">Show</button></div>`;
  }
  function wirePwToggles() {
    screen.querySelectorAll("[data-pw]").forEach((b) => b.onclick = () => {
      const i = $("#" + b.dataset.pw); const show = i.type === "password";
      i.type = show ? "text" : "password"; b.textContent = show ? "Hide" : "Show";
    });
  }

  function renderCreateAccount(prefill = "") {
    if (!state.ageCheck) return renderAgeIntro("signup");
    setTabsVisible(false);
    paint(flowHtml({
      title: "Create your account", sticker: "key",
      body: `<input id="email" class="input" type="email" inputmode="email" autocomplete="email" placeholder="Email" value="${esc(prefill)}">
        ${pwField("pw", "Password (8+ characters)", "new-password")}
        <div id="err" class="error"></div>`,
      foot: `${nextBtn(true)}${legalLine("By signing up you agree to the")}`,
    }));
    wirePwToggles();
    $("#back").onclick = () => renderWelcome();
    const email = $("#email"), pw = $("#pw"), next = $("#next"), err = $("#err");
    const check = () => {
      const ok = EMAIL_RE.test(email.value.trim()) && pw.value.length >= 8;
      next.disabled = !ok;
      email.classList.toggle("good", EMAIL_RE.test(email.value.trim()));
      return ok;
    };
    email.oninput = pw.oninput = check; check();
    pw.onkeydown = (e) => { if (e.key === "Enter" && check()) next.click(); };
    next.onclick = async () => {
      err.innerHTML = "";
      busy(next, true);
      try {
        const addr = email.value.trim();
        const r = await store.signUp(addr, pw.value, state.ageCheck);
        if (r.needsConfirm) renderCheckEmail(addr);
        else { saveAgeCheckLocal(null); boot(); }
      } catch (e) {
        busy(next, false); check();
        err.innerHTML = esc(e.message) + (e.code === "exists" ? ` <button class="link" id="toLogin">Log in</button>` : "");
        $("#toLogin") && ($("#toLogin").onclick = () => renderLogin(email.value.trim()));
      }
    };
    setTimeout(() => email.focus(), 250);
  }

  function renderCheckEmail(email) {
    setTabsVisible(false);
    paint(flowHtml({
      title: "Check your inbox", sticker: "mailbox",
      lead: `We sent a confirmation link to <b>${esc(email)}</b>. Tap it to activate your account, then log in.`,
      body: `<div class="note">${emo("bulb", 24)}<div>Can't find it? Check spam or promotions. If you open the link on this phone, you'll land straight back in Hooky, logged in.</div></div>`,
      foot: `<button class="btn lime" id="toLogin">I confirmed it, log in</button>
        <button class="btn dark" id="resend">Resend the email</button>
        <button class="textbtn" id="diff">Use a different email</button>`,
    }));
    $("#back").onclick = () => renderCreateAccount(email);
    $("#toLogin").onclick = () => renderLogin(email);
    $("#diff").onclick = () => renderCreateAccount();
    const resend = $("#resend");
    resend.onclick = async () => {
      resend.disabled = true;
      try { await store.resendConfirm(email); toast("Sent again. Check your inbox."); }
      catch (e) { toast(e.message, 3200); }
      let s = 60;
      const t = setInterval(() => { s--; resend.textContent = s > 0 ? `Resend in ${s}s` : "Resend the email"; if (s <= 0) { clearInterval(t); resend.disabled = false; } }, 1000);
      state.leave = () => clearInterval(t);
    };
  }

  function renderLogin(prefill = "") {
    setTabsVisible(false);
    paint(flowHtml({
      title: "Welcome back", sticker: "waving-hand",
      body: `<input id="email" class="input" type="email" inputmode="email" autocomplete="email" placeholder="Email" value="${esc(prefill)}">
        ${pwField("pw", "Password", "current-password")}
        <div id="err" class="error"></div>
        <button class="textbtn" id="forgot" style="align-self:flex-start">Forgot your password?</button>`,
      foot: nextBtn(true),
    }));
    wirePwToggles();
    $("#back").onclick = () => renderWelcome();
    const email = $("#email"), pw = $("#pw"), next = $("#next"), err = $("#err");
    const check = () => { const ok = EMAIL_RE.test(email.value.trim()) && pw.value.length >= 6; next.disabled = !ok; return ok; };
    email.oninput = pw.oninput = check; check();
    pw.onkeydown = (e) => { if (e.key === "Enter" && check()) next.click(); };
    next.onclick = async () => {
      err.innerHTML = "";
      busy(next, true);
      try {
        await store.signIn(email.value.trim(), pw.value);
        saveAgeCheckLocal(null);
        boot();
      } catch (e) {
        busy(next, false); check();
        err.innerHTML = esc(e.message) + (e.code === "unconfirmed" ? ` <button class="link" id="resend">Resend link</button>` : "");
        $("#resend") && ($("#resend").onclick = async () => { try { await store.resendConfirm(email.value.trim()); toast("Confirmation email sent"); } catch (x) { toast(x.message, 3200); } });
      }
    };
    $("#forgot").onclick = () => modal(`${emo("key", 76, "sheet-sticker sticker")}<h2 class="center">Reset your password</h2>
      <p class="muted small center">We'll email you a link to set a new one.</p>
      <input id="rEmail" class="input" type="email" inputmode="email" placeholder="Email" value="${esc(email.value.trim())}"><br><br>
      <div id="rErr" class="error"></div>
      <button class="btn lime" id="rGo">Send reset link</button>`, () => {
      $("#rGo").onclick = async () => {
        const v = $("#rEmail").value.trim();
        if (!EMAIL_RE.test(v)) return ($("#rErr").textContent = "Enter the email you signed up with.");
        $("#rGo").disabled = true;
        try { await store.resetPassword(v); closeModal(); toast("Check your email for the reset link", 3200); }
        catch (e) { $("#rGo").disabled = false; $("#rErr").textContent = e.message; }
      };
    });
    setTimeout(() => (prefill ? pw : email).focus(), 250);
  }

  function renderNewPassword() {
    setTabsVisible(false);
    paint(flowHtml({
      back: false, title: "Pick a new password", sticker: "lock-key",
      body: `${pwField("pw", "New password (8+ characters)", "new-password")}<div id="err" class="error"></div>`,
      foot: nextBtn(true),
    }));
    wirePwToggles();
    const pw = $("#pw"), next = $("#next");
    pw.oninput = () => { next.disabled = pw.value.length < 8; };
    next.onclick = async () => {
      busy(next, true);
      try { await store.updatePassword(pw.value); toast("Password updated"); boot(); }
      catch (e) { busy(next, false); next.disabled = pw.value.length < 8; $("#err").textContent = e.message; }
    };
  }

  // =====================================================================
  // Profile setup (after the first login)
  // =====================================================================
  function pushSupported() { return "Notification" in window && (!real || ("serviceWorker" in navigator && "PushManager" in window)) && Notification.permission === "default"; }
  function setupSteps() { return ["name", "birthday", "gender", "showMe", "photo", "interests", "about"].concat(pushSupported() ? ["notify"] : []); }
  function startSetup() { state.draft = Object.assign({}, state.me || {}); state.step = 0; renderSetup(); }

  // Turns a picked file into a 3:4 portrait JPEG, the shape cards use, big
  // enough to stay sharp full screen. Resolves null if it can't be read.
  function readPhoto(file) {
    return new Promise((resolve) => {
      const img = new Image(); const url = URL.createObjectURL(file);
      img.onload = () => {
        const W = 960, H = 1280, want = W / H;
        let sw = img.width, sh = img.height;
        if (sw / sh > want) sw = sh * want; else sh = sw / want;
        const c = document.createElement("canvas"); c.width = W; c.height = H;
        const ctx = c.getContext("2d"); ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, 0, 0, W, H);
        URL.revokeObjectURL(url); resolve(c.toDataURL("image/jpeg", 0.85));
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
      img.src = url;
    });
  }
  async function readPhotos(files, room) {
    const out = [];
    for (const f of Array.from(files).slice(0, room)) { const u = await readPhoto(f); if (u) out.push(u); else toast("One of those couldn't be opened. Try a JPEG or a screenshot.", 3200); }
    if (files.length > room) toast(`Only ${S.MAX_PHOTOS} photos fit. Kept the first ${room}.`, 3000);
    return out;
  }

  // Four photo slots: a big main one and three small. items are
  // { url, ref?, busy? }. Filled slots can be removed or made main.
  function photoGrid(items) {
    const slots = [];
    for (let i = 0; i < S.MAX_PHOTOS; i++) {
      const p = items[i];
      if (p) slots.push(`<div class="pslot filled ${i === 0 ? "main" : ""}">
          <img src="${esc(p.url)}" alt="">
          ${i === 0 ? `<span class="pbadge">MAIN</span>` : `<button class="pmain" data-main="${i}">Make main</button>`}
          ${p.busy ? `<span class="pbusy">${ICON.spin}</span>` : `<button class="prm" data-rm="${i}" aria-label="Remove">${ICON.x}</button>`}
        </div>`);
      else slots.push(`<label class="pslot empty ${i === 0 ? "main" : ""}">${i === items.length ? `<span class="pplus">${ICON.plus}</span>${i === 0 ? `<span class="phint">Add your main pic</span>` : ""}` : ""}
          <input type="file" accept="image/*" multiple class="hidden" data-add></label>`);
    }
    return `<div class="pgrid" id="pgrid">${slots.join("")}</div>`;
  }
  function wirePhotoGrid({ add, remove, main, room }) {
    const grid = $("#pgrid"); if (!grid) return;
    grid.querySelectorAll("[data-add]").forEach((inp) => inp.onchange = async () => {
      const left = room(); if (left <= 0) return toast(`You can have up to ${S.MAX_PHOTOS} photos.`);
      const urls = await readPhotos(inp.files, left); inp.value = "";
      if (urls.length) { buzz(8); add(urls); }
    });
    grid.onclick = (e) => {
      const rm = e.target.closest("[data-rm]"), mk = e.target.closest("[data-main]");
      if (rm) { e.preventDefault(); remove(Number(rm.dataset.rm)); }
      if (mk) { e.preventDefault(); buzz(6); main(Number(mk.dataset.main)); }
    };
  }

  function renderSetup(errMsg) {
    setTabsVisible(false);
    const steps = setupSteps();
    const step = steps[state.step];
    const d = state.draft;
    const ac = store.ageCheck() || state.ageCheck;
    const bar = [state.step, steps.length];
    let cfg;

    if (step === "name") cfg = {
      back: false, title: "What's your nickname?", sticker: "waving-hand",
      body: `<input id="name" class="input" maxlength="20" placeholder="Nickname" autocomplete="nickname" value="${esc(d.name || "")}">
        <p class="tiny muted" style="padding-left:6px">First name or a nickname. No last names, numbers or handles.</p>`,
    };
    if (step === "birthday") cfg = {
      title: "When's your birthday?", sticker: "cake",
      body: `<input id="bday" class="input" type="date" value="${esc(d.birthdate || "")}" max="${new Date().toISOString().slice(0, 10)}">
        <div id="info" class="note hidden"></div>
        <p class="tiny muted" style="padding-left:6px">This decides who you can meet. It can't be changed later, so make it real.</p>`,
    };
    if (step === "gender") cfg = {
      title: "I'm a…", sticker: "sparkles",
      lead: "Pick what fits you. It shows on your profile.",
      body: `<div class="opts" id="opts">${GENDERS.map((g) => `<button class="opt ${d.gender === g.id ? "on" : ""}" data-g="${g.id}">${emo(g.emoji, 34)}${esc(g.label)}<span class="check"></span></button>`).join("")}</div>`,
    };
    if (step === "showMe") {
      const cur = d.showMe || ALL_GENDERS;
      const all = ALL_GENDERS.every((g) => cur.includes(g));
      cfg = {
        title: "Who do you want to meet?", sticker: "heart-hands",
        lead: "Pick one or more. It's private, and you can change it any time in your profile.",
        body: `<div class="opts" id="opts"><button class="opt ${all ? "on" : ""}" data-s="all">${emo("people-hugging", 34)}Everyone<span class="check"></span></button>
          ${GENDERS.map((g) => `<button class="opt ${!all && cur.includes(g.id) ? "on" : ""}" data-s="${g.id}">${emo(g.emoji, 34)}${esc(g.plural)}<span class="check"></span></button>`).join("")}</div>`,
      };
    }
    if (step === "photo") {
      d.pics = d.pics || [];
      cfg = {
        title: "Add your pics", sticker: "camera-flash",
        lead: `Add 1 to ${S.MAX_PHOTOS} real photos of you. The first one is your main pic.`,
        body: `${photoGrid(d.pics)}
          <div class="note">${emo("bulb", 24)}<div>Use recent photos that clearly show your face. Each one is checked before anyone sees it, and photos of other people, group shots or anything inappropriate get rejected.</div></div>`,
      };
    }
    if (step === "interests") cfg = {
      title: "What are you into?", sticker: "video-game",
      lead: `Tap at least 3. <span class="lime" id="count">${(d.tags || []).length}/8</span>`,
      body: `<div class="tags cloud" id="tags">${E.INTERESTS.slice(0, 32).map(([t]) => E.tag(t, { button: true, data: true, on: (d.tags || []).includes(t) })).join("")}</div>`,
    };
    if (step === "about") cfg = {
      title: "A bit more about you", sticker: "globe", skip: true,
      body: `<div class="field"><label>Where you're at</label><input id="region" class="input" maxlength="30" placeholder="State or country, like Texas" value="${esc(d.region || "")}"></div>
        <div class="field"><label>Bio</label><textarea id="bio" class="input" maxlength="140" placeholder="What should people message you about?">${esc(d.bio || "")}</textarea></div>
        <p class="tiny muted" style="padding-left:6px">Region only, never your city, school or address.</p>`,
    };
    if (step === "notify") cfg = {
      back: false, title: "Stay in the loop", sticker: "megaphone", skip: true,
      lead: "Get a ping when you catch someone or get a message.",
      body: `<button class="tcard" id="pushCard">New catches and messages<span class="grow"></span><span class="switch on" id="pushSw"></span></button>
        <p class="tiny muted" style="padding-left:6px">Notifications never show what anyone said, so nothing private lands on your lock screen.</p>`,
    };

    const isSave = step === "about";
    paint(flowHtml(Object.assign({ bar, foot: `${errMsg ? `<div class="error center">${esc(errMsg)}</div>` : ""}${nextBtn(true)}` }, cfg)));
    const next = $("#next");
    const setOk = (ok) => { next.disabled = !ok; };
    $("#back") && ($("#back").onclick = () => { state.step--; renderSetup(); });

    if (step === "name") {
      const i = $("#name");
      const ok = () => { const v = i.value.trim(); const good = v.length >= 2 && !/\d{3,}|@|http|\.com/i.test(v); i.classList.toggle("good", good); setOk(good); return good; };
      i.oninput = ok; ok();
      i.onkeydown = (e) => { if (e.key === "Enter" && ok()) next.click(); };
      setTimeout(() => i.focus(), 250);
    }
    if (step === "birthday") {
      const i = $("#bday"), info = $("#info");
      const ok = () => {
        const age = S.ageFromBirthdate(i.value);
        info.classList.add("hidden"); i.classList.remove("good", "bad");
        if (age == null) return setOk(false);
        info.classList.remove("hidden");
        let good = false;
        if (age < S.MIN_AGE) { info.className = "note warn"; info.innerHTML = `${emo("hand-stop", 22)}<div>Hooky is for people ${S.MIN_AGE} and up. Come back when you're ${S.MIN_AGE}!</div>`; }
        else if (age > S.MAX_AGE) { info.className = "note warn"; info.innerHTML = `${emo("hand-stop", 22)}<div>Hooky is for ${S.MIN_AGE} to ${S.MAX_AGE} year olds.</div>`; }
        else if (ac && !S.ageFitsEstimate(age, ac.estimate)) { info.className = "note warn"; info.innerHTML = `${emo("thinking", 22)}<div>That doesn't match your age check. Use your real birthday.</div>`; }
        else { const b = S.ageBand(age); good = true; info.className = "note lime"; info.innerHTML = `${emo("sparkles", 22)}<div>You're ${age}. You'll meet people aged ${b.label}, and only they can see you.</div>`; }
        i.classList.add(good ? "good" : "bad");
        setOk(good);
      };
      i.oninput = i.onchange = ok; ok();
    }
    if (step === "gender") {
      setOk(!!d.gender);
      $("#opts").onclick = (e) => { const b = e.target.closest("[data-g]"); if (!b) return; d.gender = b.dataset.g; buzz(6); screen.querySelectorAll("[data-g]").forEach((x) => x.classList.toggle("on", x === b)); setOk(true); };
    }
    if (step === "showMe") {
      const paintOpts = () => {
        const cur = d.showMe || ALL_GENDERS; const all = ALL_GENDERS.every((g) => cur.includes(g));
        screen.querySelectorAll("[data-s]").forEach((x) => x.classList.toggle("on", x.dataset.s === "all" ? all : !all && cur.includes(x.dataset.s)));
        setOk(cur.length > 0);
      };
      $("#opts").onclick = (e) => {
        const b = e.target.closest("[data-s]"); if (!b) return; buzz(6);
        const cur = d.showMe || ALL_GENDERS; const all = ALL_GENDERS.every((g) => cur.includes(g));
        if (b.dataset.s === "all") d.showMe = ALL_GENDERS.slice();
        else if (all) d.showMe = [b.dataset.s];
        else d.showMe = cur.includes(b.dataset.s) ? cur.filter((x) => x !== b.dataset.s) : cur.concat(b.dataset.s);
        paintOpts();
      };
      paintOpts();
    }
    if (step === "photo") {
      // A real photo is required. Uploads wait until the profile exists, at
      // the end of setup, but photos already accepted keep their ref.
      setOk(d.pics.length > 0);
      wirePhotoGrid({
        add: async (urls) => { d.pics = d.pics.concat(urls.map((url) => ({ url }))).slice(0, S.MAX_PHOTOS); renderSetup(); },
        remove: async (i) => { const p = d.pics[i]; if (p.ref) { try { await store.removePhoto(p.ref); } catch (e) { return toast(e.message); } } d.pics.splice(i, 1); renderSetup(); },
        main: async (i) => { const p = d.pics.splice(i, 1)[0]; d.pics.unshift(p); if (p.ref) { try { await store.setMainPhoto(p.ref); } catch {} } renderSetup(); },
        room: () => S.MAX_PHOTOS - d.pics.length,
      });
    }
    if (step === "interests") {
      const count = () => { const n = (d.tags || []).length; $("#count").textContent = `${n}/8`; setOk(n >= 3); };
      $("#tags").onclick = (e) => {
        const b = e.target.closest("[data-t]"); if (!b) return;
        const t = b.dataset.t; d.tags = d.tags || [];
        if (d.tags.includes(t)) d.tags = d.tags.filter((x) => x !== t);
        else if (d.tags.length < 8) d.tags = d.tags.concat(t);
        else return toast("8 is the max");
        buzz(5); b.classList.toggle("on", d.tags.includes(t)); count();
      };
      count();
    }
    if (step === "about") {
      setOk(true);
      $("#skip").onclick = () => { d.region = d.region || ""; d.bio = d.bio || ""; finishSetup(next); };
    }
    if (step === "notify") {
      let want = true;
      setOk(true);
      $("#pushCard").onclick = () => { want = !want; $("#pushSw").classList.toggle("on", want); buzz(6); };
      $("#skip").onclick = () => enterApp();
      next.onclick = async () => {
        busy(next, true);
        if (want) { try { await store.enablePush(); } catch (e) { toast(e.message, 3000); } }
        enterApp();
      };
      return;
    }

    next.onclick = async () => {
      if (step === "name") d.name = $("#name").value.trim();
      if (step === "birthday") d.birthdate = $("#bday").value;
      if (step === "showMe") d.showMe = d.showMe || ALL_GENDERS.slice();
      if (step === "about") { d.region = $("#region").value.trim(); d.bio = $("#bio").value.trim(); if (/\d{3,}|@|http/i.test(d.bio)) return renderSetup("No numbers, handles or links in your bio."); }
      if (isSave) return finishSetup(next);
      state.step++; renderSetup();
    };
  }

  // Creates the profile. The server re-checks the birthday against the age
  // check here, and moderates the photo.
  async function finishSetup(btn) {
    const d = state.draft; const steps = setupSteps();
    if (!d.emoji) d.emoji = "😎"; // only ever shown if every photo is later removed
    busy(btn, true);
    try {
      state.me = await store.saveMe(d);
    } catch (e) {
      busy(btn, false);
      const m = e.message || "";
      if (/age check required/i.test(m)) return renderAgeIntro("account");
      if (/does not match age check/i.test(m)) { state.step = steps.indexOf("birthday"); return renderSetup("That birthday doesn't match your age check."); }
      if (/at least 13|13 to 25/i.test(m)) { state.step = steps.indexOf("birthday"); return renderSetup(m); }
      return renderSetup(m || "Couldn't save your profile. Try again.");
    }
    // Each photo goes through moderation on its own. Rejected ones drop out
    // with the reason; if none survive, back to the photo step.
    const pending = (d.pics || []).filter((p) => !p.ref);
    const fails = [];
    const status = document.createElement("p"); status.className = "tiny muted center";
    btn.insertAdjacentElement("afterend", status);
    for (let i = 0; i < pending.length; i++) {
      status.textContent = pending.length > 1 ? `Checking photo ${i + 1} of ${pending.length}…` : "Checking your photo…";
      try { const list = await store.addPhoto(pending[i].url); pending[i].ref = list[list.length - 1].ref; }
      catch (e) { fails.push(e.message); pending[i].bad = true; }
    }
    status.remove();
    d.pics = (d.pics || []).filter((p) => !p.bad);
    if (!d.pics.length) {
      busy(btn, false);
      state.step = steps.indexOf("photo");
      return renderSetup(fails[0] ? `That photo wasn't accepted: ${fails[0]}` : "Add at least one photo of you.");
    }
    if (fails.length) toast(`${fails.length} photo${fails.length > 1 ? "s weren't" : " wasn't"} accepted: ${fails[0]}`, 4200);
    saveAgeCheckLocal(null);
    state.me = await store.getMe();
    paintMeTab();
    if (steps.includes("notify")) { state.step = steps.indexOf("notify"); return renderSetup(); }
    enterApp();
  }
  function enterApp() { buzz([30, 40, 30]); showTab("discover"); setTimeout(() => toast("You're in! Start casting 🎣"), 350); }

  // =====================================================================
  // Tabs
  // =====================================================================
  tabs.addEventListener("click", (e) => { const b = e.target.closest("[data-tab]"); if (b) { buzz(6); showTab(b.dataset.tab); } });
  function showTab(tab) {
    closeModal();
    state.tab = tab; state.chatId = null; setTabsVisible(true);
    tabs.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
    refreshUnread();
    ({ discover: renderDiscover, live: renderLive, matches: renderMatches, rooms: renderRooms, profile: renderProfile })[tab]();
  }
  function appbar(inner) { return `<div class="appbar">${inner}</div>`; }
  function plusChip(me) {
    return `<button class="chipbtn plus" id="plusChip">${emo("crown", 22)}${me.premium ? (me.tier === "max" ? "Max" : "Plus") : "Hooky+"}</button>`;
  }

  // ---------- Catch (the deck) ----------
  function cardHtml(u, idx) {
    // Emoji people get their own little world: their interests float behind.
    let hero, bars = "";
    const pics = (u.photos && u.photos.length) ? u.photos : u.photo ? [u.photo] : [];
    if (pics.length) {
      // Every photo is in the card; tapping the left or right half flips
      // between them, and the bars at the top show which one is up.
      hero = pics.map((src, i) => `<img class="photo ${i ? "" : "on"}" src="${esc(src)}" alt="" ${i ? 'loading="lazy"' : ""}>`).join("");
      if (pics.length > 1) bars = `<div class="bars">${pics.map((_, i) => `<i class="${i ? "" : "on"}"></i>`).join("")}</div>`;
    } else {
      const bits = (u.tags || []).slice(0, 4).map((t) => E.tagSlug(t));
      const spots = [[8, 28, 54, -14], [72, 22, 46, 12], [12, 64, 44, 10], [74, 60, 58, -8], [40, 12, 36, 6], [44, 80, 40, -6]];
      const confetti = spots.map(([x, y, s, r], i) => `<span class="confetti-emo" style="left:${x}%;top:${y}%;transform:rotate(${r}deg)">${emo(bits[i % Math.max(1, bits.length)] || "sparkles", s)}</span>`).join("");
      hero = `${confetti}${E.char(u.emoji || "😎", 220, "big")}`;
    }
    return `<div class="card-hero" style="background:${u.gradient}">${hero}</div><div class="card-shade"></div>${bars}
      <div class="card-top ${bars ? "with-bars" : ""}">
        <div class="display card-name">${esc(u.name)} <span class="age">${u.age}</span><span class="verified" title="Age checked"></span></div>
        ${u.region ? `<div class="card-meta">${emo("pin", 18)} ${esc(u.region)}</div>` : `<div style="height:10px"></div>`}
        <div class="tags mini">${(u.tags || []).slice(0, 4).map((t) => E.tag(t)).join("")}</div>
      </div>
      <div class="card-rail"><button data-report="${u.id}" aria-label="Report">${emo("flag", 24)}</button></div>
      <div class="stamp like">HOOK ${emo("fishing-pole", 42)}</div><div class="stamp nope">PASS</div>
      <div class="card-bottom">${u.online ? `<div class="live-badge"><span class="dot on"></span>Online now</div>` : ""}${u.bio ? `<div class="card-bio">${esc(u.bio)}</div>` : ""}</div>`;
  }

  async function renderDiscover() {
    const me = state.me = await store.getMe();
    if (!me) return boot();
    let all = [];
    try { all = await store.candidates(); } catch (e) { toast(e.message); }
    // Every photo for everyone in this batch, in one round trip.
    try {
      const pm = await store.photosFor(all.map((u) => u.id));
      all.forEach((u) => { if (pm[u.id] && pm[u.id].length) u.photos = pm[u.id]; });
    } catch {}
    const onlineCount = all.filter((c) => c.online).length;
    let cands = state.onlineOnly ? all.filter((c) => c.online) : all;
    const left = await store.likesRemaining();
    const b = S.ageBand(me.age);
    paint(`${appbar(`<img class="brand-img" src="assets/wordmark.png" alt="hooky"><div class="grow"></div>${plusChip(me)}<button class="chipbtn round" id="meChip" aria-label="Me">${avatarHtml(me, "sm")}</button>`)}
      <div class="seg" id="seg"><button class="${state.onlineOnly ? "" : "on"}" data-f="all">For you</button><button class="${state.onlineOnly ? "on" : ""}" data-f="online">Online now${onlineCount ? `<span class="count">${onlineCount}</span>` : ""}</button></div>
      <div class="deck-wrap">
        <div class="deck" id="deck"></div>
        <div class="actions">
          <button class="act small" id="undo" aria-label="Undo">${ICON.undo}</button>
          <button class="act nope" id="nope" aria-label="Pass">${ICON.x}</button>
          <button class="act like" id="like" aria-label="Hook">${emo("fishing-pole", 50)}</button>
          <button class="act small" id="likes" aria-label="Who hooked you">${emo("eyes", 30)}<span class="pip hidden" id="likesPip"></span></button>
        </div>
        <div class="likes-left" id="left">${hooksLeftText(left)}</div>
      </div>`);
    $("#plusChip").onclick = () => renderPlus();
    $("#meChip").onclick = () => showTab("profile");
    $("#seg").onclick = (e) => { const x = e.target.closest("[data-f]"); if (!x) return; state.onlineOnly = x.dataset.f === "online"; renderDiscover(); };
    $("#likes").onclick = renderWhoLiked;
    $("#undo").onclick = async () => { if (!me.premium) return renderPlus("Undo is a Hooky+ perk"); if (await store.undo()) renderDiscover(); else toast("Nothing to undo"); };
    store.whoLikedMe().then((p) => { const pip = $("#likesPip"); if (pip && p.length) { pip.textContent = p.length > 9 ? "9+" : p.length; pip.classList.remove("hidden"); } }).catch(() => {});

    const deck = $("#deck"); let queue = [];
    function draw() {
      deck.innerHTML = "";
      if (!cands.length) {
        deck.innerHTML = `<div class="empty"><div>${emo(state.onlineOnly ? "sleeping" : "fishing-pole", 110, "sticker")}<h2 class="display">${state.onlineOnly ? "Quiet right now" : "Nothing biting"}</h2><p>${state.onlineOnly ? "Nobody new is online. Switch to For you, or check back in a bit." : `You've seen everyone aged ${b.label} for now. Cast again later.`}</p></div></div>`;
        return;
      }
      queue = cands.slice(0, 3);
      queue.slice().reverse().forEach((u, i) => {
        const idx = queue.length - 1 - i;
        const el = document.createElement("div");
        el.className = "card " + (idx === 1 ? "behind" : idx === 2 ? "behind2" : "");
        el.innerHTML = cardHtml(u, idx);
        deck.appendChild(el);
        if (idx === 0) attachDrag(el, u);
      });
    }
    deck.addEventListener("click", (e) => { const r = e.target.closest("[data-report]"); if (r) { e.stopPropagation(); openReport(cands.find((c) => c.id === r.dataset.report), () => { cands.shift(); draw(); }); } });

    function attachDrag(el, u) {
      let sx = 0, sy = 0, dx = 0, dy = 0, dragging = false, shown = 0;
      const stL = $(".stamp.like", el), stN = $(".stamp.nope", el);
      const photos = el.querySelectorAll(".card-hero img.photo"), bars = el.querySelectorAll(".bars i");
      // A tap (not a drag) on the left or right half flips through photos.
      const flip = (x) => {
        if (photos.length < 2) return;
        const r = el.getBoundingClientRect();
        const next = x < r.left + r.width / 2 ? shown - 1 : shown + 1;
        if (next < 0 || next >= photos.length) { el.animate([{ transform: "translateX(0)" }, { transform: `translateX(${next < 0 ? 8 : -8}px)` }, { transform: "translateX(0)" }], { duration: 220 }); return; }
        photos[shown].classList.remove("on"); bars[shown].classList.remove("on");
        shown = next; buzz(4);
        photos[shown].classList.add("on"); bars[shown].classList.add("on");
      };
      el.onpointerdown = (e) => { if (e.target.closest("[data-report]")) return; dragging = true; sx = e.clientX; sy = e.clientY; dx = dy = 0; el.setPointerCapture(e.pointerId); el.style.transition = "none"; };
      el.onpointermove = (e) => { if (!dragging) return; dx = e.clientX - sx; dy = e.clientY - sy; el.style.transform = `translate(${dx}px,${dy * 0.4}px) rotate(${dx / 16}deg)`; stL.style.opacity = Math.max(0, Math.min(1, dx / 90)); stN.style.opacity = Math.max(0, Math.min(1, -dx / 90)); };
      const end = (e) => {
        if (!dragging) return; dragging = false;
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8 && e && e.type === "pointerup") { el.style.transform = ""; flip(e.clientX); }
        else if (dx > 110) fly(el, u, "like"); else if (dx < -110) fly(el, u, "nope");
        else { el.style.transition = "transform .3s cubic-bezier(.2,.9,.3,1.2)"; el.style.transform = ""; stL.style.opacity = stN.style.opacity = 0; }
        dx = dy = 0;
      };
      el.onpointerup = end; el.onpointercancel = end;
    }
    async function fly(el, u, dir) {
      let res;
      try { res = await store.swipe(u.id, dir); } catch (e) { el.style.transform = ""; return toast(e.message); }
      if (res.limited) { el.style.transition = "transform .25s"; el.style.transform = ""; return renderPlus("You're out of hooks for today"); }
      buzz(dir === "like" ? [10, 30, 10] : 8);
      $(".stamp." + dir, el).style.opacity = 1;
      el.style.transition = "transform .42s ease, opacity .42s"; el.style.transform = `translate(${dir === "like" ? 620 : -620}px, -40px) rotate(${dir === "like" ? 28 : -28}deg)`; el.style.opacity = 0;
      cands.shift();
      setTimeout(async () => { draw(); const l = $("#left"); if (l) l.textContent = hooksLeftText(await store.likesRemaining()); }, 260);
      if (res.matched) { celebrate(u, res.matched); store.notify("match", store.kind === "local" ? u.name : res.matched.id); }
    }
    $("#nope").onclick = () => { const top = deck.querySelector(".card:last-child"); if (top && queue[0]) fly(top, queue[0], "nope"); };
    $("#like").onclick = () => { const top = deck.querySelector(".card:last-child"); if (top && queue[0]) fly(top, queue[0], "like"); };
    draw();
  }

  function emojiRain(slugs = ["sparkling-heart", "heart", "fishing-pole", "tropical-fish", "party", "sparkles", "star", "fish"], n = 36) {
    const app = $("#app");
    for (let i = 0; i < n; i++) {
      const s = document.createElement("span"); s.className = "rain";
      const size = 26 + Math.random() * 30;
      s.style.left = Math.random() * 92 + "%"; s.style.animationDelay = Math.random() * 0.8 + "s";
      s.style.setProperty("--spin", (Math.random() * 540 - 270) + "deg");
      s.innerHTML = emo(slugs[i % slugs.length], Math.round(size));
      app.appendChild(s); setTimeout(() => s.remove(), 3400);
    }
  }
  function celebrate(u, match) {
    buzz([40, 60, 40, 60, 120]); emojiRain();
    const online = store.isOnline(u.id);
    const el = document.createElement("div"); el.className = "boom";
    el.innerHTML = `<h1 class="display">It's a catch!</h1><p class="lead">You and ${esc(u.name)} hooked each other.${online ? " They're online right now." : ""}</p>
      <div class="pair">${avatarHtml(state.me)}${avatarHtml(u)}${emo("fishing-pole", 76, "sticker")}</div>
      ${online ? `<button class="btn grad" id="live">${emo("video-camera", 26)} Call now</button>` : ""}
      <button class="btn lime" id="say">Say hi ${emo("waving-hand", 24)}</button><button class="btn dark" id="later">Keep casting</button>`;
    $("#app").appendChild(el);
    $("#later", el).onclick = () => { el.remove(); maybeOfferPush(); };
    $("#say", el).onclick = () => { el.remove(); openChat(match.id); maybeOfferPush(); };
    $("#live", el) && ($("#live", el).onclick = async () => { el.remove(); const m = (await store.matches()).find((x) => x.id === match.id); openChat(match.id); askCallKind(m); });
  }

  async function renderWhoLiked() {
    const me = state.me; const people = await store.whoLikedMe();
    modal(`${emo("eyes", 76, "sheet-sticker sticker")}<h2 class="center">${people.length} ${people.length === 1 ? "person" : "people"} hooked you</h2>
      ${me.premium ? `<div class="list" style="padding:0">${people.map((p) => `<div class="item">${avatarHtml(p, "", store.isOnline(p.id))}<div class="meta"><div class="name">${esc(p.name)}, ${p.age}</div><div class="preview">${esc(p.tags.join(" · "))}</div></div></div>`).join("") || `<p class="muted center">Nobody yet. Keep casting.</p>`}</div>`
        : `<p class="muted center small">See who already hooked you and catch them instantly with Hooky+.</p><div class="row" style="justify-content:center;filter:blur(7px);pointer-events:none;margin:16px 0">${people.slice(0, 4).map((p) => avatarHtml(p)).join("")}</div><button class="btn lime" id="getPlus">${emo("crown", 24)} Get Hooky+</button>`}`);
    $("#getPlus") && ($("#getPlus").onclick = () => { closeModal(); renderPlus(); });
  }

  // ---------- report / block ----------
  function openReport(u, after) {
    if (!u) return;
    modal(`${emo("flag", 70, "sheet-sticker sticker")}<h2 class="center">Report ${esc(u.name)}</h2><p class="muted small center">Reports are private. ${esc(u.name)} won't know. Anything about someone's safety goes to the top of the queue.</p>
      <div class="reasons" id="reasons">${S.REPORT_REASONS.map((r) => `<button data-r="${esc(r)}">${esc(r)}</button>`).join("")}</div>
      <br><button class="btn danger" id="blockOnly">Just block</button>`);
    $("#reasons").onclick = async (e) => { const b = e.target.closest("[data-r]"); if (!b) return; await store.report(u.id, b.dataset.r, ""); await store.block(u.id); closeModal(); toast("Reported and blocked. Thank you."); after && after(); };
    $("#blockOnly").onclick = async () => { await store.block(u.id); closeModal(); toast("Blocked"); after && after(); };
  }

  // ---------- Chats ----------
  async function renderMatches() {
    let ms = [];
    try { ms = await store.matches(); } catch (e) { toast(e.message); }
    const online = ms.filter((m) => m.online);
    const fresh = ms.filter((m) => !m.last);
    const convos = ms.filter((m) => m.last);
    paint(`${appbar(`<h1 class="display title lime">Chats</h1><div class="grow"></div><button class="chipbtn" id="toRooms">${emo("couch", 22)}Rooms</button>`)}
      ${online.length ? `<div class="section">${emo("zap", 18)} Online now</div><div class="bubbles">${online.map((m) => `<button data-open="${m.id}">${avatarHtml(m.user, "", true)}<span>${esc(m.user.name)}</span></button>`).join("")}</div>` : ""}
      ${fresh.length ? `<div class="section">${emo("fishing-pole", 18)} New catches</div><div class="bubbles">${fresh.map((m) => `<button data-open="${m.id}">${avatarHtml(m.user, "", m.online)}<span>${esc(m.user.name)}</span></button>`).join("")}</div>` : ""}
      ${convos.length ? `<div class="section">${emo("speech", 18)} Messages</div>` : ""}
      <div class="list">${convos.map((m) => `<button class="item ${m.unread ? "unread" : ""}" data-open="${m.id}">${avatarHtml(m.user, "", m.online)}<div class="meta"><div class="name">${esc(m.user.name)}</div><div class="preview">${m.last.from === "me" ? "You: " : ""}${esc(m.last.text)}</div></div><div class="side"><span class="time">${timeAgo(m.last.at)}</span>${m.unread ? `<span class="count">${m.unread}</span>` : ""}</div></button>`).join("")}</div>
      ${!ms.length ? `<div class="empty"><div>${emo("speech", 110, "sticker")}<h2 class="display">No catches yet</h2><p>When you and someone hook each other, you'll chat here. When you're both online, you can call.</p><br><button class="btn lime" id="goCatch" style="width:auto">${emo("fishing-pole", 24)} Start casting</button></div></div>` : ""}`);
    screen.onclick = (e) => { const b = e.target.closest("[data-open]"); if (b) openChat(b.dataset.open); };
    $("#toRooms").onclick = () => showTab("rooms");
    $("#goCatch") && ($("#goCatch").onclick = () => showTab("discover"));
  }

  async function openChat(matchId) {
    state.chatId = matchId;
    const m = (await store.matches()).find((x) => x.id === matchId); if (!m) return showTab("matches");
    const u = m.user; const me = state.me;
    const strict = S.isMinor(me.age);
    const online = store.isOnline(u.id);
    setTabsVisible(false);
    paint(`<div class="chatbar"><button class="back" id="back" aria-label="Back">${ICON.back}</button>${avatarHtml(u, "sm", online)}<div class="who"><b>${esc(u.name)}, ${u.age}</b><small class="${online ? "on" : ""}">${online ? "Online now" : "Offline"}</small></div>
        <button class="iconbtn ${online ? "live" : "off"}" id="call" aria-label="Call">${emo("receiver", 24)}</button><button class="iconbtn" id="more" aria-label="More">${ICON.more}</button></div>
      <div class="chat"><div class="msgs" id="msgs"></div>
      <form class="composer" id="form"><input id="txt" class="input" placeholder="Message ${esc(u.name)}…" autocomplete="off" maxlength="500"><button class="send" type="submit" aria-label="Send">${ICON.send}</button></form></div>`);
    const unsub = store.subscribe(matchId, load);
    state.leave = () => { unsub && unsub(); state.chatId = null; };
    $("#back").onclick = () => showTab("matches");
    $("#call").onclick = () => askCallKind(m);
    $("#more").onclick = () => modal(`<div class="row" style="justify-content:center;margin-bottom:10px">${avatarHtml(u, "lg")}</div><h2 class="center">${esc(u.name)}</h2>
      <button class="btn dark" id="rep">${emo("flag", 22)} Report</button><button class="btn danger" id="blk">Block ${esc(u.name)}</button>`, () => {
      $("#rep").onclick = () => { closeModal(); openReport(u, () => showTab("matches")); };
      $("#blk").onclick = async () => { await store.block(u.id); closeModal(); toast("Blocked"); showTab("matches"); };
    });
    const box = $("#msgs");
    async function load() {
      if (state.chatId !== matchId) return;
      const msgs = await store.messages(matchId);
      box.innerHTML = `<div class="msg sys">${emo("shield", 18)}Real friends don't ask you to leave Hooky, send photos or keep secrets. Report anything weird.</div>` +
        msgs.map((x) => x.from === "sys" ? `<div class="msg sys">${esc(x.text)}</div>` : `<div class="msg ${x.from === "me" ? "me" : "them"}">${esc(x.text)}</div>`).join("");
      box.scrollTop = box.scrollHeight; refreshUnread();
    }
    $("#form").onsubmit = async (e) => {
      e.preventDefault(); const t = $("#txt").value.trim(); if (!t) return;
      const res = await store.send(matchId, t);
      if (res.blocked) return modal(`${emo("hand-stop", 70, "sheet-sticker sticker")}<h2 class="center">Hold up</h2><p>That message looks like it shares ${esc(res.reasons.join(", "))}. ${strict ? "To keep everyone safe, chats with anyone under 18 stay on Hooky." : "Chats stay on Hooky."}</p><p class="muted small">Want to actually talk? If ${esc(u.name)} is online, tap the phone to call instead. If someone is pushing you to leave Hooky or share personal info, that's a red flag. Report them from the ⋯ menu.</p><button class="btn lime" id="ok">Got it</button>`, () => { $("#ok").onclick = closeModal; });
      if (res.warn) toast("Careful sharing " + res.warn.join(", "));
      store.notify("message", store.kind === "local" ? me.name : matchId);
      $("#txt").value = ""; load();
    };
    load();
  }

  // ---------- Rooms ----------
  // A room is pinned to its creator's age window, so it can never become a way
  // to reach people outside the range you could already see.
  const ROOM_EMO = ["couch", "bubble-tea", "rocket", "gem", "popcorn", "headphone", "palette", "fire", "star", "moon", "pizza", "dizzy"];
  const ROOM_BG = ["#c8ff4f", "#ff7ab0", "#7dd3fc", "#c4b5fd", "#ffb199", "#5eead4", "#ffe066"];
  // Rooms wear a sticker that fits their topic when we can tell what it is.
  const ROOM_TOPICS = [
    [/stud|homework|school|exam|test|math|book|read/i, "books"], [/game|gaming|play|minecraft|fortnite|valorant|dev/i, "video-game"],
    [/music|song|band|rap|beat|playlist|k-?pop/i, "headphone"], [/art|draw|paint|design/i, "palette"], [/movie|film|show|anime|tv/i, "popcorn"],
    [/sport|ball|soccer|football|gym|run|fitness/i, "basketball"], [/food|cook|bak|eat/i, "pizza"], [/code|coding|program|tech/i, "laptop"],
    [/pet|dog|cat|animal/i, "dog"], [/space|star|astro/i, "rocket"], [/night|sleep|late/i, "moon"], [/travel|trip/i, "airplane"],
  ];
  function roomLook(r) {
    const hit = ROOM_TOPICS.find(([re]) => re.test(r.topic));
    return { slug: hit ? hit[1] : ROOM_EMO[E.hash(r.id) % ROOM_EMO.length], bg: ROOM_BG[E.hash(r.topic + r.id) % ROOM_BG.length] };
  }
  async function renderRooms() {
    const me = state.me = await store.getMe();
    const allowed = await store.roomsAllowed();
    let list = [];
    try { list = await store.browseRooms(); } catch (e) { toast(e.message); }
    const mine = list.filter((r) => r.mine);
    paint(`${appbar(`<h1 class="display title lime">Rooms</h1><div class="grow"></div>${plusChip(me)}`)}
      <div class="rooms">
        <p class="muted small" style="margin:0 4px">Group chats on one topic. You only see rooms made by people in your own age range.</p>
        ${allowed
          ? `<button class="btn lime" id="new">${ICON.plus.replace("<svg", '<svg width="22" height="22"')} New room · ${mine.length} of ${allowed} used</button>`
          : `<div class="promo">${emo("couch", 70, "sticker")}<div class="display">Start your own room</div><p>Pick any topic. Hooky+ gives you one room, Hooky Max gives you five.</p><button class="btn lime" id="getPlus">See plans</button></div>`}
        ${list.length ? list.map((r) => {
          const look = roomLook(r);
          return `<div class="room" style="--rc:${look.bg}">${emo(look.slug, 54)}
            <div class="info"><div class="topic">${esc(r.topic)}</div><div class="meta">by ${esc(r.owner_name)} · ${r.members} in here · ages ${r.age_lo}–${r.age_hi}</div></div>
            <div class="stack" style="gap:6px">
              <button class="btn sm" data-open="${r.id}">${r.joined ? "Open" : "Join"}</button>
              ${r.mine ? `<button class="btn sm alt" data-close="${r.id}">Close</button>` : r.joined ? `<button class="btn sm alt" data-leave="${r.id}">Leave</button>` : ""}
            </div></div>`;
        }).join("")
          : `<div class="empty"><div>${emo("house", 100, "sticker")}<h2 class="display">No rooms yet</h2><p>Nobody in your age range has started one.${allowed ? " You could be first." : ""}</p></div></div>`}
      </div>`);
    $("#plusChip").onclick = () => renderPlus();
    $("#getPlus") && ($("#getPlus").onclick = () => renderPlus("Private rooms come with Hooky+"));
    $("#new") && ($("#new").onclick = () => {
      modal(`${emo("couch", 72, "sheet-sticker sticker")}<h2 class="center">New room</h2>
        <p class="muted small center">Give it a topic. Anyone in your age range can find and join it.</p>
        <input id="topic" class="input" maxlength="60" placeholder="late night study group"><br><br>
        <div id="rErr" class="error"></div>
        <button class="btn lime" id="make">Create room</button>`, () => {
        $("#make").onclick = async () => {
          const topic = $("#topic").value.trim();
          if (topic.length < 3) return ($("#rErr").textContent = "Give it a topic.");
          $("#make").disabled = true;
          try { await store.createRoom(topic); closeModal(); toast("Room created"); renderRooms(); }
          catch (e) { $("#make").disabled = false; $("#rErr").textContent = e.message; }
        };
      });
    });
    screen.onclick = async (e) => {
      const open = e.target.closest("[data-open]"), leave = e.target.closest("[data-leave]"), close = e.target.closest("[data-close]");
      if (open) {
        const r = list.find((x) => x.id === open.dataset.open);
        if (!r.joined) { try { await store.joinRoom(r.id); } catch (err) { return toast(err.message); } }
        return openRoom(r.id, r.topic);
      }
      if (leave) { await store.leaveRoom(leave.dataset.leave); renderRooms(); }
      if (close) {
        modal(`<h2 class="center">Close this room?</h2><p class="muted center">Everyone is removed and the messages go with it.</p><button class="btn danger" id="yes">Close it</button><button class="btn dark" id="no">Keep it</button>`, () => {
          $("#no").onclick = closeModal;
          $("#yes").onclick = async () => { await store.closeRoom(close.dataset.close); closeModal(); renderRooms(); };
        });
      }
    };
  }

  async function openRoom(id, topic) {
    setTabsVisible(false);
    paint(`<div class="chatbar"><button class="back" id="back" aria-label="Back">${ICON.back}</button>${emo(roomLook({ id, topic }).slug, 38)}<div class="who"><b>${esc(topic)}</b><small>Private room</small></div></div>
      <div class="chat"><div class="room-msgs" id="rmsgs"></div>
      <form class="composer" id="rform"><input id="rtxt" class="input" placeholder="Message the room…" autocomplete="off" maxlength="500"><button class="send" type="submit" aria-label="Send">${ICON.send}</button></form></div>`);
    const box = $("#rmsgs");
    let alive = true;
    async function load() {
      if (!alive) return;
      const msgs = await store.roomMessages(id);
      box.innerHTML = `<div class="msg sys">${emo("shield", 18)}Same rules as anywhere on Hooky. Report anyone who breaks them.</div>` +
        msgs.map((m) => `<div class="room-msg ${m.mine ? "me" : ""}">${m.mine ? "" : `<div class="who">${esc(m.sender_name)}</div>`}<div class="bubble">${esc(m.body)}</div></div>`).join("");
      box.scrollTop = box.scrollHeight;
    }
    const unsub = store.subscribeRoom(id, load);
    state.leave = () => { alive = false; unsub && unsub(); };
    $("#back").onclick = () => showTab("rooms");
    $("#rform").onsubmit = async (e) => {
      e.preventDefault();
      const t = $("#rtxt").value.trim(); if (!t) return;
      try {
        const res = await store.roomSend(id, t);
        if (res.blocked) return modal(`${emo("hand-stop", 70, "sheet-sticker sticker")}<h2 class="center">Hold up</h2><p>That message looks like it shares ${esc(res.reasons.join(", "))}. Rooms that include anyone under 18 keep conversations on Hooky.</p><button class="btn lime" id="ok">Got it</button>`, () => { $("#ok").onclick = closeModal; });
        $("#rtxt").value = ""; load();
      } catch (err) { toast(err.message); }
    };
    load();
  }

  // =====================================================================
  // Live: random video chat
  // =====================================================================
  // Omegle-style: tap Go live, get paired with a random stranger in your own
  // age window (with mutual gender preference), talk, tap Next for someone
  // new. Engine is roulette.js; this is the screen and the flow.
  const L = { active: false, stream: null, model: null, peer: null, sid: null, partner: null, stopGuard: null, unsubMatch: null, poll: null, hooked: false };

  async function renderLive() {
    const me = state.me = await store.getMe();
    const b = S.ageBand(me.age);
    const ready = !real || (me.verification && (me.photos || []).length);
    const online = Math.max(1, store.onlineIds().size);
    const row = (slug, t, s) => `<div class="prow"><div class="ico">${emo(slug, 32)}</div><div><b>${t}</b><span>${s}</span></div></div>`;
    paint(`${appbar(`<h1 class="display title lime">Live</h1><div class="grow"></div><span class="pill live-pill"><span class="dot on"></span>${online} online</span>`)}
      <div class="live-hero">
        <div class="orbit">${["video-camera", "waving-hand", "sparkles", "star-struck", "headphone", "fire"].map((s, i) => `<span style="--i:${i}">${emo(s, 44, "sticker")}</span>`).join("")}<div class="core">${avatarHtml(me, "lg")}</div></div>
        <h2 class="display">Meet someone new, face to face</h2>
        <p>Random video chat with people aged ${b.label}. Say hi, or tap <b>Next</b> to meet someone else.</p>
        ${ready ? `<button class="btn lime" id="goLive">${emo("video-camera", 26)} Go live</button>`
          : `<button class="btn lime" id="fixLive">${emo("camera-flash", 24)} Add a photo to go live</button>`}
      </div>
      <div class="plist" style="margin:14px 16px 24px">
        ${row("sunglasses", "Face on, clothes on", "Show your face and keep it PG. That's the rule for everyone.")}
        ${row("shield", "Checked on your phone", "An automatic check watches the other person's video. Anything explicit is blurred, ended and reported.")}
        ${row("flag", "You're in control", "Skip, report or block anyone in one tap. You never owe anyone an explanation.")}
        ${row("locked", "Nothing is recorded", "Video goes straight between your phones and is never saved.")}
      </div>`);
    $("#goLive") && ($("#goLive").onclick = () => startLive());
    $("#fixLive") && ($("#fixLive").onclick = () => renderSettings());
    HookyLive.loadGuard().catch(() => {}); // warm up while they read
  }

  function liveRules(then) {
    modal(`${emo("shield", 76, "sheet-sticker sticker")}<h2 class="center">House rules</h2>
      <div class="stack small">
        <div class="note">${emo("sunglasses", 24)}<div><b>Face on, clothes on.</b> Keep it PG. Breaking this gets you removed from Hooky.</div></div>
        <div class="note">${emo("shield", 24)}<div><b>There's an automatic check.</b> It watches the other person's video on your phone. Anything explicit ends the chat and gets them reported.</div></div>
        <div class="note">${emo("hand-stop", 24)}<div><b>If anything feels off, tap Next or report.</b> Never share where you live, your school or other apps. Nobody can make you.</div></div>
      </div><br>
      <button class="btn lime" id="agree">I'm in</button><button class="btn dark" id="nah">Not now</button>`, () => {
      $("#nah").onclick = closeModal;
      $("#agree").onclick = () => { try { localStorage.setItem("hooky.liveRules", "1"); } catch {} closeModal(); then(); };
    });
  }

  function liveStageHtml() {
    return `<div class="live-stage" id="stage">
      <div class="remote" id="remote">
        <video id="rv" autoplay playsinline></video>
        <div class="cover" id="cover"></div>
        <div class="guard-label hidden" id="guardLabel"></div>
      </div>
      <video id="lv" class="pip" autoplay muted playsinline></video>
      <div class="live-top">
        <button class="lbtn" id="lStop" aria-label="Stop">${ICON.x}</button>
        <div class="who" id="who"></div>
        <button class="lbtn" id="lRep" aria-label="Report">${emo("flag", 24)}</button>
      </div>
      <div class="live-bottom">
        <div class="live-chat" id="chatlog"></div>
        <form class="live-compose" id="lform"><input id="ltxt" placeholder="Say hi…" autocomplete="off" maxlength="300"><button type="submit" aria-label="Send">${ICON.send}</button></form>
        <div class="live-controls">
          <button class="lbtn" id="lMic" aria-label="Mute">${emo("mic", 26)}</button>
          <button class="lbtn" id="lCam" aria-label="Camera">${emo("camera", 26)}</button>
          <button class="lbtn hook" id="lHook" aria-label="Hook">${emo("fishing-pole", 30)}</button>
          <button class="btn lime next-btn" id="lNext">Next ${ICON.arrow}</button>
        </div>
      </div>
    </div>`;
  }

  async function startLive() {
    try { if (!localStorage.getItem("hooky.liveRules")) return liveRules(startLive); } catch {}
    setTabsVisible(false);
    state.inCall = true; // no incoming ring interrupts a Live chat
    paint(liveStageHtml());
    state.leave = () => stopLive(true);
    wireLiveControls();
    setCover("loading");
    try {
      // The relay credentials are fetched now too, so the first pairing is quick.
      const [stream, model] = await Promise.all([HookyLive.openMedia(), HookyLive.loadGuard(), store.iceServers()]);
      if (!$("#stage")) { stream.getTracks().forEach((t) => t.stop()); return; }
      L.stream = stream; L.model = model;
    } catch (e) {
      stopLive(true); state.inCall = false;
      showTab("live");
      return modal(`${emo(e.code === "camera-denied" ? "camera" : "crying", 70, "sheet-sticker sticker")}<h2 class="center">Can't go live yet</h2><p class="muted center">${esc(e.message)}</p><button class="btn lime" id="ok">OK</button>`, () => { $("#ok").onclick = closeModal; });
    }
    $("#lv").srcObject = L.stream;
    L.active = true;
    L.unsubMatch = store.onRouletteMatch(async (sid) => {
      if (!L.active || L.sid) return;
      const partner = await store.roulettePartner(sid);
      if (partner && L.active && !L.sid) beginPairing(sid, partner);
    });
    searchLive();
  }

  async function searchLive() {
    if (!L.active || L.sid) return;
    clearTimeout(L.poll);
    L.partner = null; L.hooked = false;
    setWho(null); resetLiveChat(); setCover("searching");
    let r;
    try { r = await store.rouletteNext(); }
    catch (e) { toast(e.message, 3600); return stopLive(); }
    if (!L.active || L.sid) return;
    if (r.status === "matched") return beginPairing(r.sessionId, r.partner);
    // Nobody yet. Asking again keeps our place in the queue fresh and looks
    // for anyone who joined since.
    L.poll = setTimeout(searchLive, 5000);
  }

  async function beginPairing(sid, partner) {
    clearTimeout(L.poll);
    L.sid = sid; L.partner = partner; L.hooked = false;
    $("#lHook") && $("#lHook").classList.remove("on");
    setWho(partner); setCover("connecting", partner);
    const mine = sid;
    const iceServers = await store.iceServers(); // cached; refreshed before it expires
    if (L.sid !== mine || !L.active) return;
    L.peer = HookyLive.connect({
      store, sessionId: sid, me: state.me, partner, stream: L.stream, iceServers,
      onRemote: (ms) => {
        if (L.sid !== mine) return;
        const rv = $("#rv"); if (!rv) return;
        if (ms) { rv.srcObject = ms; setCover(null); startLiveGuard(mine); }
        else setCover("demo", partner); // demo mode: no real video on the other end
      },
      onConnected: () => { if (L.sid === mine) buzz([20, 30, 20]); },
      onChat: (t) => { if (L.sid === mine && t) addLiveChat("them", t); },
      onEnd: (reason, local) => {
        if (L.sid !== mine || local) return;
        const ended = L.sid; endLivePairing();
        store.rouletteLeave(ended, reason);
        if (!L.active) return;
        toast(reason === "left" ? "They tapped Next. Finding someone new…" : reason === "no-connect" ? "Couldn't connect. Trying someone else…" : "Connection dropped. Finding someone new…", 2200);
        setTimeout(searchLive, 900);
      },
    });
  }

  function startLiveGuard(mine) {
    if (L.stopGuard) L.stopGuard();
    const rv = $("#rv"); if (!rv || !L.model) return;
    L.stopGuard = HookyLive.watch(rv, L.model, {
      onState: (s) => setGuard(s),
      onTrip: () => tripLive(mine),
    });
  }

  function endLivePairing() {
    if (L.stopGuard) { L.stopGuard(); L.stopGuard = null; }
    const rv = $("#rv"); if (rv) rv.srcObject = null;
    setGuard("off");
    L.peer = null; L.sid = null;
  }

  function nextLive(reason = "next") {
    const sid = L.sid, peer = L.peer;
    endLivePairing(); // clears L.sid first, so the closing peer's onEnd is ignored
    if (peer) peer.close(reason);
    if (sid) store.rouletteLeave(sid, reason);
    searchLive();
  }

  // The guard saw something explicit twice in a row.
  async function tripLive(mine) {
    if (L.sid !== mine) return;
    const partner = L.partner, sid = L.sid, peer = L.peer;
    endLivePairing(); if (peer) peer.close("nsfw"); store.rouletteLeave(sid, "nsfw");
    setCover("paused");
    try { await store.report(partner.id, "Explicit video, caught automatically in Live", "", { auto: true }); await store.block(partner.id); } catch {}
    buzz([60, 40, 60]);
    modal(`${emo("shield", 76, "sheet-sticker sticker")}<h2 class="center">We ended that chat</h2>
      <p class="muted center">Something explicit showed up, so we hid it, ended the chat and reported them. You won't be paired with them again.</p>
      <p class="tiny muted center">If someone showed you something like that, it's not your fault. You can talk to an adult you trust, or text 988.</p>
      <button class="btn lime" id="goOn">Keep going</button><button class="btn dark" id="leave">Leave Live</button>`, { sticky: true, onMount: () => {
      $("#goOn").onclick = () => { closeModal(); searchLive(); };
      $("#leave").onclick = () => { closeModal(); stopLive(); };
    } });
  }

  function stopLive(fromLeave) {
    if (!L.active && !L.stream) { state.inCall = false; return; }
    L.active = false;
    clearTimeout(L.poll);
    const peer = L.peer;
    endLivePairing();
    if (peer) peer.close("stop");
    store.rouletteStop();
    if (L.unsubMatch) { L.unsubMatch(); L.unsubMatch = null; }
    if (L.stream) { L.stream.getTracks().forEach((t) => t.stop()); L.stream = null; }
    L.partner = null;
    state.inCall = false;
    if (!fromLeave) { state.leave = null; showTab("live"); }
  }

  function wireLiveControls() {
    $("#lStop").onclick = () => stopLive();
    $("#lNext").onclick = () => { if (!L.active) return; buzz(8); nextLive("next"); };
    $("#lRep").onclick = () => {
      if (!L.partner) return;
      $("#remote").classList.add("blur"); // stop showing them while you report
      openReport(L.partner, () => nextLive("report"));
      const bg = $(".modal-bg", modalRoot);
      bg && bg.addEventListener("click", (e) => { if (e.target === bg && $("#remote")) $("#remote").classList.remove("blur"); });
    };
    $("#lMic").onclick = (e) => { const t = L.stream && L.stream.getAudioTracks()[0]; if (!t) return; t.enabled = !t.enabled; e.currentTarget.classList.toggle("off", !t.enabled); };
    $("#lCam").onclick = (e) => { const t = L.stream && L.stream.getVideoTracks()[0]; if (!t) return; t.enabled = !t.enabled; e.currentTarget.classList.toggle("off", !t.enabled); $("#lv").classList.toggle("hidden", !t.enabled); };
    $("#lHook").onclick = async (e) => {
      const btn = e.currentTarget, p = L.partner; if (!p || L.hooked) return;
      L.hooked = true; btn.classList.add("on"); buzz([10, 30, 10]);
      try {
        const res = await store.swipe(p.id, "like");
        if (res.limited) { L.hooked = false; btn.classList.remove("on"); return toast("You're out of hooks for today"); }
        if (res.matched) { emojiRain(); toast(`It's a catch! You and ${p.name} are in each other's chats`, 3200); store.notify("match", store.kind === "local" ? p.name : res.matched.id); }
        else toast(`Hooked! If ${p.name} hooks you back, it's a catch.`, 2600);
      } catch (err) { toast(err.message); }
    };
    $("#lform").onsubmit = (e) => {
      e.preventDefault();
      const i = $("#ltxt"); const t = i.value.trim();
      if (!t || !L.peer || !L.partner) return;
      // Same filter as every other chat: strict whenever a minor is in it.
      const check = S.checkMessage(t, S.isMinor(state.me.age), S.isMinor(L.partner.age));
      if (check.blocked) return toast(`That looks like it shares ${check.reasons.join(", ")}. Keep it on Hooky.`, 3200);
      L.peer.sendChat(t); addLiveChat("me", t); i.value = "";
    };
  }

  function setWho(p) {
    const el = $("#who"); if (!el) return;
    el.innerHTML = p ? `${avatarHtml(p, "sm")}<div><b>${esc(p.name)}, ${p.age}</b><div class="tags mini">${(p.tags || []).slice(0, 2).map((t) => E.tag(t)).join("")}</div></div>` : "";
  }
  function setCover(kind, p) {
    const c = $("#cover"), remote = $("#remote"); if (!c) return;
    c.style.background = "";
    if (!kind) { c.className = "cover hidden"; c.innerHTML = ""; return; }
    c.className = "cover " + kind;
    const b = S.ageBand(state.me.age);
    if (kind === "loading") c.innerHTML = `<div>${emo("hourglass", 64, "bob")}<b>Getting ready…</b><span>Starting your camera and the safety check</span></div>`;
    if (kind === "searching") c.innerHTML = `<div><div class="orbit small">${["waving-hand", "sparkles", "star-struck", "fire", "headphone", "video-game"].map((s, i) => `<span style="--i:${i}">${emo(s, 34)}</span>`).join("")}<div class="core">${emo("magnifier", 50)}</div></div><b>Finding someone…</b><span>People aged ${b.label}</span></div>`;
    if (kind === "connecting") c.innerHTML = `<div>${avatarHtml(p, "lg")}<b>Connecting to ${esc(p.name)}…</b><span>Say hi when you see them</span></div>`;
    if (kind === "paused") c.innerHTML = `<div>${emo("shield", 64)}<b>Chat ended</b></div>`;
    if (kind === "demo") {
      c.style.background = p.gradient;
      c.innerHTML = `<div class="demo-remote">${p.photo ? `<img src="${esc(p.photo)}" alt="">` : E.char(p.emoji || "😎", 150, "bob")}<span>Demo mode: nobody's really on camera</span></div>`;
    }
    if (remote) remote.classList.remove("blur");
  }
  function setGuard(s) {
    const remote = $("#remote"), label = $("#guardLabel"); if (!remote || !label) return;
    remote.classList.toggle("blur", s === "checking" || s === "hidden");
    label.classList.toggle("hidden", s !== "checking" && s !== "hidden");
    label.innerHTML = s === "hidden" ? `${emo("shield", 20)} Hidden: this looked inappropriate` : `${emo("shield", 20)} Safety check…`;
  }
  function resetLiveChat() { const c = $("#chatlog"); if (c) c.innerHTML = ""; }
  function addLiveChat(who, text) {
    const c = $("#chatlog"); if (!c) return;
    const el = document.createElement("div"); el.className = "lmsg " + who; el.textContent = text;
    c.appendChild(el);
    while (c.children.length > 6) c.firstChild.remove();
  }

  // ---------- Me ----------
  function settingRow({ id, slug, label, val = "", chev = true, href, danger, sw }) {
    const inner = `<span class="ico">${emo(slug, 26)}</span><span class="label">${label}</span>${val ? `<span class="val">${val}</span>` : ""}${sw !== undefined ? `<span class="switch ${sw ? "on" : ""}" id="${id}Sw"></span>` : chev ? `<span class="chev">›</span>` : ""}`;
    if (href) return `<a class="setting" href="${href}" ${/^http|legal/.test(href) ? 'target="_blank"' : ""}>${inner}</a>`;
    return `<button class="setting ${danger ? "danger" : ""}" ${id ? `id="${id}"` : ""}>${inner}</button>`;
  }
  async function renderProfile() {
    const me = state.me = await store.getMe();
    if (!me) return boot();
    paintMeTab();
    const b = S.ageBand(me.age);
    const blocked = await store.blocked();
    const g = (GENDERS.find((x) => x.id === me.gender) || {}).label || "Not set";
    const show = me.showMe || ALL_GENDERS;
    const showLabel = ALL_GENDERS.every((x) => show.includes(x)) ? "Everyone" : show.map((x) => GENDER_PLURAL[x]).join(", ");
    const checked = me.verification ? `<span class="pill ok">${emo("check", 16)} Age checked</span>` : "";
    paint(`${appbar(`<h1 class="display title lime">Me</h1><div class="grow"></div>${plusChip(me)}`)}
      <div class="me-hero">
        <div class="bg" style="background:${me.gradient}"></div>
        ${avatarHtml(me, "xl")}
        <div class="display">${esc(me.name)}, ${me.age}</div>
        <div class="pills">${checked}<span class="pill">${emo("pin", 16)} ${esc(me.region || "Somewhere")}</span>${me.premium ? `<span class="pill plus">${emo("crown", 16)} ${me.tier === "max" ? "Hooky Max" : "Hooky+"}</span>` : ""}</div>
        ${me.bio ? `<p class="small" style="margin:0 0 12px">${esc(me.bio)}</p>` : ""}
        <div class="tags mini">${(me.tags || []).map((t) => E.tag(t)).join("")}</div>
        ${(me.photos || []).length > 1 ? `<div class="me-strip">${me.photos.map((p) => `<img src="${esc(p.url)}" alt="">`).join("")}</div>` : ""}
        <br><button class="btn white" id="edit">Edit profile</button>
      </div>
      ${(me.photos || []).length ? "" : `<div style="margin:14px 16px 0"><div class="promo">${emo("camera-flash", 70, "sticker")}<div class="display">Add your pics</div><p>Profiles with real photos get way more catches. Add up to ${S.MAX_PHOTOS}.</p><button class="btn lime" id="addPics">Add photos</button></div></div>`}
      ${me.premium ? "" : `<div style="margin:14px 16px 0"><div class="promo">${emo("crown", 70, "sticker")}<div class="display">Get Hooky+</div><p>Unlimited hooks, see who hooked you, undo passes and your own room.</p><button class="btn lime" id="plus">See plans</button></div></div>`}
      <div class="group"><h3>Safety</h3>
        ${settingRow({ slug: "shield", label: "Who you can meet", val: `Ages ${b.label}`, chev: false })}
        ${settingRow({ id: "gShow", slug: "heart-hands", label: "Show me", val: esc(showLabel) })}
        ${settingRow({ id: "gMe", slug: "sparkles", label: "I am", val: esc(g) })}
        ${settingRow({ slug: "receiver", label: "Calls", val: "Catches only, both online", chev: false })}
        ${settingRow({ id: "blockedBtn", slug: "prohibited", label: "Blocked people", val: String(blocked.length) })}
        ${settingRow({ id: "tips", slug: "bulb", label: "Safety tips and help" })}
      </div>
      <div class="group"><h3>Notifications</h3>
        ${settingRow({ id: "push", slug: "bell", label: "New catches and messages", sw: false })}
        <p class="tiny muted" style="margin:2px 14px 10px">Never shows what anyone said.</p>
      </div>
      <div class="group"><h3>Account</h3>
        ${me.email ? settingRow({ slug: "envelope", label: "Email", val: esc(me.email), chev: false }) : ""}
        ${real ? settingRow({ id: "pwBtn", slug: "key", label: "Change password" }) : ""}
        ${store.kind === "local" ? settingRow({ id: "togglePlus", slug: "crown", label: "Demo: toggle Hooky+", val: me.premium ? "on" : "off" }) : ""}
        ${settingRow({ slug: "megaphone", label: "Contact support", href: `mailto:${SUPPORT_EMAIL}` })}
        ${settingRow({ slug: "books", label: "Terms, privacy and guidelines", href: "legal.html" })}
        ${settingRow({ id: "signout", slug: "door", label: "Log out" })}
        ${settingRow({ id: "del", slug: "wastebasket", label: "Delete my account", danger: true })}
      </div>
      <div class="foot-note">Hooky ${store.kind === "local" ? "demo" : ""} · Friends, not dating · 13 to 25<br>3D emoji by Microsoft Fluent Emoji (MIT)</div>`);
    $("#edit").onclick = () => renderSettings();
    $("#addPics") && ($("#addPics").onclick = () => renderSettings());
    $("#gShow").onclick = $("#gMe").onclick = () => renderSettings();
    $("#plusChip").onclick = () => renderPlus();
    $("#plus") && ($("#plus").onclick = () => renderPlus());
    $("#togglePlus") && ($("#togglePlus").onclick = async () => { await store.setPremium(!me.premium); renderProfile(); });
    wirePushToggle();
    $("#blockedBtn").onclick = () => modal(`${emo("prohibited", 70, "sheet-sticker sticker")}<h2 class="center">Blocked</h2><div class="list" style="padding:0">${blocked.map((p) => `<div class="item">${avatarHtml(p)}<div class="meta"><div class="name">${esc(p.name)}</div></div><button class="btn sm dark" data-un="${p.id}">Unblock</button></div>`).join("") || `<p class="muted center">Nobody blocked.</p>`}</div>`, (bg) => { bg.onclick = async (e) => { const x = e.target.closest("[data-un]"); if (x) { await store.unblock(x.dataset.un); closeModal(); renderProfile(); } else if (e.target === bg) closeModal(); }; });
    $("#tips").onclick = () => modal(`${emo("shield", 76, "sheet-sticker sticker")}<h2 class="center">Stay safe on Hooky</h2><div class="stack small">
      <div class="note">${emo("fishing-pole", 24)}<div><b>Keep it on Hooky.</b> Someone pushing you to talk somewhere else right away is the number one warning sign. Everything you need is here, including calls.</div></div>
      <div class="note">${emo("video-camera", 24)}<div><b>On a call, you're in charge.</b> If anyone asks you to show or do something you don't want to, hang up and report. Nothing is recorded, and you're never in trouble for ending a call.</div></div>
      <div class="note">${emo("camera", 24)}<div><b>Never send photos you wouldn't want everyone to see.</b> If someone threatens you with a photo, that's a crime called sextortion. Tell an adult you trust and report them here.</div></div>
      <div class="note">${emo("pin", 24)}<div><b>Don't share your school, address or schedule.</b> Meeting someone from the internet means a trusted adult knows and comes along.</div></div>
      <div class="note">${emo("flag", 24)}<div><b>Trust your gut.</b> Report and block freely. You never owe anyone a reply.</div></div>
      <p class="muted">Need help now? In the US, text or call 988, or report at report.cybertip.org.</p></div>
      <button class="btn lime" id="ok">Got it</button>`, () => { $("#ok").onclick = closeModal; });
    $("#pwBtn") && ($("#pwBtn").onclick = () => modal(`${emo("key", 70, "sheet-sticker sticker")}<h2 class="center">Change password</h2>
      <input id="npw" class="input" type="password" placeholder="New password (8+ characters)" autocomplete="new-password"><br><br><div id="pErr" class="error"></div>
      <button class="btn lime" id="pGo">Save password</button>`, () => {
      $("#pGo").onclick = async () => {
        const v = $("#npw").value; if (v.length < 8) return ($("#pErr").textContent = "At least 8 characters.");
        $("#pGo").disabled = true;
        try { await store.updatePassword(v); closeModal(); toast("Password changed"); } catch (e) { $("#pGo").disabled = false; $("#pErr").textContent = e.message; }
      };
    }));
    $("#signout").onclick = async () => { await store.signOut(); boot(); };
    $("#del").onclick = () => modal(`${emo("wastebasket", 70, "sheet-sticker sticker")}<h2 class="center">Delete your account?</h2><p class="muted center">This removes your profile, catches and messages. It can't be undone.</p><button class="btn danger" id="yes">Delete everything</button><button class="btn dark" id="no">Cancel</button>`, () => { $("#no").onclick = closeModal; $("#yes").onclick = async () => { await store.deleteAccount(); closeModal(); boot(); }; });
  }

  // ---------- push notifications ----------
  async function wirePushToggle() {
    const btn = $("#push"), sw = $("#pushSw"); if (!btn) return;
    const draw = async () => {
      const st = await store.pushStatus();
      if (!st.supported) { sw.remove(); btn.insertAdjacentHTML("beforeend", `<span class="val">Not on this browser</span>`); btn.disabled = true; return; }
      if (st.permission === "denied") { sw.classList.remove("on"); btn.dataset.state = "denied"; return; }
      sw.classList.toggle("on", !!st.subscribed); btn.dataset.state = st.subscribed ? "on" : "off";
    };
    btn.onclick = async () => {
      if (btn.dataset.state === "denied") return toast("Notifications are blocked in your browser settings", 3200);
      const on = btn.dataset.state === "on";
      sw.classList.toggle("on", !on);
      try { if (on) await store.disablePush(); else await store.enablePush(); toast(on ? "Notifications off" : "Notifications on"); }
      catch (e) { toast(e.message, 3200); }
      draw();
    };
    draw();
  }
  // Offer once, right after a first catch, when the value is obvious.
  async function maybeOfferPush() {
    if (localStorage.getItem("hooky.pushAsked")) return;
    const st = await store.pushStatus();
    if (!st.supported || st.permission !== "default") return;
    localStorage.setItem("hooky.pushAsked", "1");
    modal(`${emo("bell", 76, "sheet-sticker sticker")}<h2 class="center">Get notified?</h2>
      <p class="muted small center">We'll tell you about new catches and messages. Notifications never include what anyone said.</p>
      <button class="btn lime" id="pOn">Turn on notifications</button><button class="btn dark" id="pNo">Not now</button>`, () => {
      $("#pNo").onclick = closeModal;
      $("#pOn").onclick = async () => { try { await store.enablePush(); toast("Notifications on"); } catch (e) { toast(e.message, 3200); } closeModal(); };
    });
  }
  // Tapping a notification focuses the app; take the person to their chats.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (e) => {
      if (e.data && e.data.type === "notification-click" && state.me) showTab("matches");
    });
  }

  // ---------- edit profile ----------
  // Everything editable lives here. Birthdate is deliberately absent: it is
  // write-once, in the client and in the database.
  async function renderSettings() {
    const me = state.me = await store.getMe();
    const d = Object.assign({ showMe: ALL_GENDERS.slice() }, me);
    // Photos save the moment they change (each is moderated on its own); the
    // Save button covers everything else.
    d.pics = (me.photos || []).map((p) => ({ url: p.url, ref: p.ref }));
    setTabsVisible(false);
    function draw(errMsg) {
      paint(`<div class="chatbar"><button class="back" id="back" aria-label="Back">${ICON.back}</button><div class="who"><b style="font-size:20px">Edit profile</b></div><button class="btn sm lime" id="save">Save</button></div>
        <div class="flow" style="padding-top:18px;gap:18px">
          <div class="field"><label>Your pics (up to ${S.MAX_PHOTOS}) · changes save right away</label>${photoGrid(d.pics)}</div>
          <div class="field"><label>Nickname</label><input id="name" class="input" maxlength="20" value="${esc(d.name || "")}"></div>
          <div class="field"><label>Where you're at</label><input id="region" class="input" maxlength="30" value="${esc(d.region || "")}"></div>
          <div class="field"><label>Bio</label><textarea id="bio" class="input" maxlength="140">${esc(d.bio || "")}</textarea></div>
          <div class="field"><label>Interests (3 to 8)</label><div class="tags" id="tags">${E.INTERESTS.map(([t]) => E.tag(t, { button: true, data: true, on: (d.tags || []).includes(t) })).join("")}</div></div>
          <div class="field"><label>I'm a</label><div class="tags" id="gender">${GENDERS.map((x) => `<button class="tag ${d.gender === x.id ? "on" : ""}" style="--tc:var(--lime)" data-g="${x.id}">${emo(x.emoji, 20)}${esc(x.label)}</button>`).join("")}</div></div>
          <div class="field"><label>Who I want to meet</label><div class="tags" id="showMe">${GENDERS.map((x) => `<button class="tag ${(d.showMe || []).includes(x.id) ? "on" : ""}" style="--tc:var(--lime)" data-s="${x.id}">${emo(x.emoji, 20)}${esc(x.plural)}</button>`).join("")}</div>
            <p class="tiny muted" style="margin:4px 4px 0">Matching is mutual: you both have to be in each other's "show me".</p></div>
          <div class="group" style="margin:0">
            ${settingRow({ slug: "cake", label: "Birthday", val: `${esc(me.birthdate || "")} · locked`, chev: false })}
            ${settingRow({ slug: "shield", label: "Age group", val: `${S.ageBand(me.age).label} · locked`, chev: false })}
          </div>
          <div id="err" class="error">${errMsg ? esc(errMsg) : ""}</div>
          <div style="height:10px"></div>
        </div>`);
      $("#back").onclick = () => showTab("profile");
      const fromServer = (list) => { d.pics = list.map((p) => ({ url: p.url, ref: p.ref })); };
      wirePhotoGrid({
        room: () => S.MAX_PHOTOS - d.pics.length,
        add: async (urls) => {
          grab();
          for (const url of urls) {
            d.pics.push({ url, busy: true }); draw();
            try { fromServer(await store.addPhoto(url)); toast("Photo added"); }
            catch (e) { d.pics = d.pics.filter((p) => p.url !== url); draw(); modal(`${emo("see-no-evil", 70, "sheet-sticker sticker")}<h2 class="center">Photo not added</h2><p class="muted center">${esc(e.message)}</p><button class="btn lime" id="ok">Got it</button>`, () => { $("#ok").onclick = closeModal; }); return; }
            draw();
          }
          state.me = await store.getMe(); paintMeTab();
        },
        remove: async (i) => {
          grab();
          if (d.pics.length === 1) return toast("Add another photo before removing your last one.", 3000);
          const p = d.pics[i]; p.busy = true; draw();
          try { fromServer(await store.removePhoto(p.ref)); } catch (e) { p.busy = false; toast(e.message); }
          draw(); state.me = await store.getMe(); paintMeTab();
        },
        main: async (i) => {
          grab();
          const p = d.pics[i];
          try { fromServer(await store.setMainPhoto(p.ref)); toast("Main photo updated"); } catch (e) { toast(e.message); }
          draw(); state.me = await store.getMe(); paintMeTab();
        },
      });
      $("#tags").onclick = (e) => {
        const b = e.target.closest("[data-t]"); if (!b) return;
        const t = b.dataset.t; const cur = d.tags || [];
        if (cur.includes(t)) d.tags = cur.filter((x) => x !== t); else if (cur.length < 8) d.tags = cur.concat(t); else return toast("8 is the max");
        b.classList.toggle("on", d.tags.includes(t));
      };
      $("#gender").onclick = (e) => { const b = e.target.closest("[data-g]"); if (!b) return; d.gender = b.dataset.g; screen.querySelectorAll("[data-g]").forEach((x) => x.classList.toggle("on", x === b)); };
      $("#showMe").onclick = (e) => {
        const b = e.target.closest("[data-s]"); if (!b) return;
        const g = b.dataset.s; const cur = d.showMe || [];
        d.showMe = cur.includes(g) ? cur.filter((x) => x !== g) : cur.concat(g);
        b.classList.toggle("on", d.showMe.includes(g));
      };
      // Keep typed text when the page redraws for a photo or emoji change.
      function grab() { d.name = $("#name").value.trim(); d.region = $("#region").value.trim(); d.bio = $("#bio").value.trim(); }
      $("#save").onclick = async () => {
        const err = $("#err"); err.textContent = "";
        grab();
        if (d.name.length < 2) return (err.textContent = "Add a nickname.");
        if (/\d{3,}|@|http/i.test(d.name + d.bio)) return (err.textContent = "No numbers, handles or links in your name or bio.");
        if (!d.gender) return (err.textContent = "Pick how you identify.");
        if (!(d.showMe || []).length) return (err.textContent = "Pick at least one group to meet.");
        if ((d.tags || []).length < 3) return (err.textContent = "Pick at least 3 interests.");
        const save = $("#save"); save.disabled = true; save.textContent = "Saving…";
        try {
          state.me = await store.saveMe(d);
          paintMeTab();
          toast("Saved"); showTab("profile");
        } catch (e2) {
          save.disabled = false; save.textContent = "Save";
          err.textContent = e2.message || "Couldn't save.";
        }
      };
    }
    draw();
  }

  // ---------- plans ----------
  // Two tiers, three billing periods, and under-18 accounts pay less on every
  // one of them. The age price comes from the stored birthdate.
  function renderPlus(reason) {
    if (typeof reason !== "string") reason = "";
    const me = state.me || {};
    const teen = S.isMinor(me.age);
    let tierId = me.tier === "max" ? "max" : "plus";
    let periodId = "year";
    const draw = () => {
      const tier = S.TIERS.find((t) => t.id === tierId);
      const monthly = S.priceFor(tierId, "month", me.age);
      const rows = S.PERIODS.map((p) => {
        const price = S.priceFor(tierId, p.id, me.age);
        const perMonth = price / p.months;
        const save = Math.round((1 - perMonth / monthly) * 100);
        return `<button class="plan-row ${periodId === p.id ? "on" : ""}" data-p="${p.id}">
          <div><div style="font-weight:800">${p.label}</div><div class="per">$${perMonth.toFixed(2)} a month${save > 0 ? ` · <span class="save">save ${save}%</span>` : ""}</div></div>
          <div class="price">$${price.toFixed(2)}</div></button>`;
      }).join("");
      modal(`<div class="plus-head">${emo(tierId === "max" ? "gem" : "crown", 80, "sheet-sticker sticker")}
          <h1 class="display grad-text">${esc(tier.name)}</h1>
          <p class="muted small" style="margin:6px 0 0">${esc(reason || tier.blurb)}</p>
          ${teen ? `<span class="teen-badge">UNDER 18 PRICE</span>` : ""}
        </div>
        <div class="seg" id="tiers" style="margin:6px 0 10px">${S.TIERS.map((t) => `<button class="${tierId === t.id ? "on" : ""}" data-t="${t.id}">${esc(t.name)}</button>`).join("")}</div>
        ${tier.perks.map(([slug, title, sub]) => `<div class="perk"><span class="ico">${emo(slug, 30)}</span><div><b>${esc(title)}</b><span>${esc(sub)}</span></div></div>`).join("")}
        <div class="stack" id="periods" style="margin:14px 0 16px;gap:10px">${rows}</div>
        <button class="btn lime" id="buy">Continue</button>
        <p class="tiny muted center" style="margin-top:12px">${teen ? "Under-18 pricing is applied automatically from your birthday." : "Standard pricing."} Billed through your phone's app store. Cancel anytime. Calls and every safety feature stay free.</p>`, () => {
        $("#tiers").onclick = (e) => { const b = e.target.closest("[data-t]"); if (b) { tierId = b.dataset.t; draw(); } };
        $("#periods").onclick = (e) => { const b = e.target.closest("[data-p]"); if (b) { periodId = b.dataset.p; draw(); } };
        $("#buy").onclick = async () => {
          if (store.kind === "local") {
            await store.setPremium(true, tierId);
            closeModal(); buzz([30, 30, 30]); emojiRain(["crown", "gem", "sparkles", "star"], 24);
            toast(`${tier.name} unlocked (demo)`);
            showTab(state.tab);
          } else toast("Purchases go through your phone's app store in the mobile build.", 3000);
        };
      });
    };
    draw();
  }

  boot().finally(hideSplash);
})();

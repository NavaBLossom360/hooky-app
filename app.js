// Hooky UI. Plain DOM, no build step.
// Vocabulary: a "hook" is a like, a "catch" is a match, online people are shown with a green dot,
// and Hooky+ is the paid tier.
(function () {
  const S = window.HookySafety;
  const { LocalStore, SupabaseStore, FREE_DAILY_LIKES } = window.HookyStore;
  const $ = (sel, el = document) => el.querySelector(sel);
  const screen = $("#screen"), tabs = $("#tabs"), modalRoot = $("#modal-root"), toastEl = $("#toast");
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const HOOK = `<svg viewBox="0 0 128 128" width="26" height="26" fill="none" stroke="currentColor" stroke-width="14" stroke-linecap="round" stroke-linejoin="round"><path d="M82 30v46a22 22 0 0 1-44 0v-8"/><path d="M38 68l11 9"/><circle cx="82" cy="21" r="8" stroke-width="9"/></svg>`;

  const INTERESTS = ["Gaming", "Building", "Anime", "K-pop", "Music", "Art", "Movies", "Memes", "Soccer", "Basketball", "Running", "Skating", "Books", "Baking", "Coding", "Photography", "Dance", "Science", "Theater", "Hiking", "Thrifting", "Fitness", "Board games", "Cars"];
  const EMOJIS = ["🙂", "😎", "🎨", "🎮", "🎧", "🛹", "📚", "⚽", "🎸", "🏀", "🧪", "🎬", "🏃", "🐍", "☕", "🌿", "🦊", "🐼", "🌸", "⚡"];

  const store = window.HOOKY_CONFIG && window.HOOKY_CONFIG.supabaseUrl && !/YOUR-PROJECT/.test(window.HOOKY_CONFIG.supabaseUrl)
    ? new SupabaseStore(window.HOOKY_CONFIG) : new LocalStore();

  const SUPPORT_EMAIL = "support@example.com"; // change before shipping
  const state = { me: null, tab: "discover", draft: {}, step: 0, chatId: null, onlineOnly: false, inCall: false };

  // ---------- helpers ----------
  function toast(msg, ms = 2200) { toastEl.textContent = msg; toastEl.classList.remove("hidden"); clearTimeout(toast.t); toast.t = setTimeout(() => toastEl.classList.add("hidden"), ms); }
  function buzz(p = 12) { navigator.vibrate && navigator.vibrate(p); }
  function modal(html, opts) {
    const onMount = typeof opts === "function" ? opts : opts && opts.onMount;
    modalRoot.innerHTML = `<div class="modal-bg"><div class="modal"><div class="handle"></div>${html}</div></div>`;
    const bg = $(".modal-bg", modalRoot);
    bg.addEventListener("click", (e) => { if (e.target === bg && !(opts && opts.sticky)) closeModal(); });
    onMount && onMount(bg);
  }
  function closeModal() { modalRoot.innerHTML = ""; }
  function avatarHtml(u, cls = "", online) {
    const inner = u.photo ? `<img src="${esc(u.photo)}" alt="">` : esc(u.emoji || "🙂");
    const av = `<div class="avatar ${cls}" style="background:${u.gradient || "var(--card)"}">${inner}</div>`;
    return online === undefined ? av : `<div class="avatar-wrap">${av}<span class="dot ${online ? "on" : ""}"></span></div>`;
  }
  function timeAgo(t) { const d = (Date.now() - t) / 60000; if (d < 1) return "now"; if (d < 60) return Math.floor(d) + "m"; if (d < 1440) return Math.floor(d / 60) + "h"; return Math.floor(d / 1440) + "d"; }
  function setTabsVisible(v) { tabs.classList.toggle("hidden", !v); }
  async function refreshUnread() {
    const n = await store.totalUnread();
    const b = $("#unread"); b.textContent = n; b.classList.toggle("hidden", !n);
  }
  function hooksLeftText(l) { return l === Infinity ? "Unlimited hooks · Hooky+" : `${l} of ${FREE_DAILY_LIKES} hooks left today`; }

  // ---------- boot ----------
  async function boot() {
    await store.init();
    state.me = await store.getMe();
    if (store.kind === "supabase" && !store.uid) renderAuth();
    else if (!state.me || !state.me.name) renderWelcome();
    else showTab("discover");
    const splash = $("#splash");
    if (splash) { setTimeout(() => splash.classList.add("out"), 500); setTimeout(() => splash.remove(), 900); }
  }
  if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("sw.js").catch(() => {});

  // Returning from a magic link signs the session in asynchronously, so redraw
  // the moment that flips instead of leaving the sign-in screen up.
  if (store.kind === "supabase") {
    let signedIn = !!store.uid;
    store.onChange(() => {
      const now = !!store.uid;
      if (now !== signedIn) { signedIn = now; boot(); }
    });
  }

  // Incoming live calls.
  store.subscribeCalls(async (p) => {
    if (p.type !== "ring" || state.inCall) return;
    const m = (await store.matches()).find((x) => x.id === p.matchId); if (!m) return;
    buzz([80, 60, 80]);
    modal(`<div class="ringing">${avatarHtml(m.user, "lg")}<h2>${esc(m.user.name)} wants to go live</h2><p class="muted small">Video call, right now, inside Hooky. Face on, keep it appropriate, and you can hang up any time.</p></div>
      <div class="row"><button class="btn ghost" id="decline">Not now</button><button class="btn lime" id="accept">📹 Go live</button></div>`, { sticky: true, onMount: () => {
      $("#decline").onclick = async () => { closeModal(); await store.answerCall(p.matchId, p.from, false); };
      $("#accept").onclick = async () => { closeModal(); await store.answerCall(p.matchId, p.from, true); startCall(m, false); };
    } });
  });

  function startCall(m, isCaller) {
    state.inCall = true;
    window.HookyCall.start({ store, me: state.me, other: m.user, matchId: m.id, isCaller,
      onEnd: async ({ seconds, reason }) => {
        state.inCall = false;
        if (seconds > 0) await store.addSystemMessage(m.id, `Live call · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`);
        if (reason !== "report") toast(seconds ? "Call ended" : "Couldn't connect");
        if (state.chatId === m.id) openChat(m.id);
      },
      onReport: () => openReport(m.user, () => showTab("matches")),
    });
  }

  async function ringUser(m) {
    if (!store.isOnline(m.userId)) return toast(`${m.user.name} isn't online right now`);
    modal(`<h2>Go live with ${esc(m.user.name)}?</h2>
      <p class="muted small">A video call inside Hooky. Nothing is recorded, nothing is saved.</p>
      <div class="notice">Face on. Keep it appropriate. If anyone asks you to do something on camera you don't want to, hang up and hit report. You're never in trouble for ending a call.</div><br>
      <button class="btn lime" id="ring">📹 Ring ${esc(m.user.name)}</button>`, () => {
      $("#ring").onclick = async () => {
        modal(`<div class="ringing">${avatarHtml(m.user, "lg")}<h2>Ringing ${esc(m.user.name)}…</h2><p class="muted small">They have 30 seconds to pick up.</p></div><button class="btn ghost" id="cancel">Cancel</button>`, { sticky: true, onMount: () => { $("#cancel").onclick = () => { closeModal(); state.cancelRing = true; }; } });
        state.cancelRing = false;
        const res = await store.requestCall(m.id);
        if (state.cancelRing) return;
        closeModal();
        if (res.accepted) startCall(m, true);
        else toast(res.timeout ? `${m.user.name} didn't pick up` : `${m.user.name} can't right now`);
      };
    });
  }

  // ---------- auth (real backend only) ----------
  function renderAuth() {
    setTabsVisible(false);
    screen.innerHTML = `<div class="pad stack" style="justify-content:center;flex:1">
      <img class="wordmark" src="assets/wordmark.png" alt="hooky">
      <h2>Sign in</h2>
      <p class="muted">We email you a sign-in link. No passwords to remember.</p>
      <div class="field"><label>Email</label><input id="email" class="input" type="email" inputmode="email" autocomplete="email" placeholder="you@example.com"></div>
      <div id="err" class="error"></div>
      <button id="go" class="btn primary">Email me a link</button>
      <p class="tiny muted center">By continuing you agree to the <a href="legal.html#terms" target="_blank">Terms</a> and <a href="legal.html#privacy" target="_blank">Privacy Policy</a>.</p>
    </div>`;
    $("#go").onclick = async () => {
      const email = $("#email").value.trim();
      const err = $("#err"); err.textContent = "";
      if (!/^\S+@\S+\.\S+$/.test(email)) return (err.textContent = "Enter a valid email address.");
      $("#go").disabled = true; $("#go").textContent = "Sending…";
      try {
        await store.sendCode(email);
        renderCheckEmail(email);
      } catch (e) {
        $("#go").disabled = false; $("#go").textContent = "Email me a link";
        err.textContent = /rate|limit|seconds/i.test(e.message)
          ? "Too many sign-in emails for now. Wait a few minutes and try again."
          : e.message;
      }
    };
  }

  function renderCheckEmail(email) {
    setTabsVisible(false);
    screen.innerHTML = `<div class="pad stack center" style="justify-content:center;flex:1">
      <div style="font-size:64px">📬</div>
      <h2>Check your email</h2>
      <p class="muted">We sent a sign-in link to <b>${esc(email)}</b>. Open it on this device and you'll land straight back in Hooky.</p>
      <div class="notice">The link works once and expires shortly. If it hasn't arrived in a minute, check your spam folder.</div>
      <button id="again" class="btn ghost">Use a different email</button>
    </div>`;
    $("#again").onclick = renderAuth;
  }

  // ---------- welcome + onboarding ----------
  function renderWelcome() {
    setTabsVisible(false);
    screen.innerHTML = `<div class="pad stack" style="justify-content:flex-end;flex:1;background:radial-gradient(500px 400px at 50% 20%, rgba(255,79,139,0.35), transparent)">
      <div class="center" style="margin-bottom:auto;margin-top:70px"><img class="logo" src="assets/icon-192.png" alt=""></div>
      <img class="wordmark" src="assets/wordmark.png" alt="hooky">
      <h2>Catch someone new.</h2>
      <p class="muted">Swipe, catch, and go live with people your age. Friends, not dating.</p>
      <button id="start" class="btn primary">Get started</button>
      <p class="tiny muted center">13+. By continuing you agree to the <a href="legal.html#terms" target="_blank">Terms</a>, <a href="legal.html#privacy" target="_blank">Privacy Policy</a>, and <a href="legal.html#guidelines" target="_blank">Community Guidelines</a>.</p>
    </div>`;
    $("#start").onclick = () => { state.step = 0; state.draft = state.me || {}; renderOnboarding(); };
  }

  const STEPS = ["age", "gender", "name", "photo", "interests", "verify"];
  const GENDERS = S.GENDERS;
  const ALL_GENDERS = GENDERS.map((g) => g.id);
  function renderOnboarding() {
    setTabsVisible(false);
    const step = STEPS[state.step];
    const dots = STEPS.map((_, i) => `<i class="${i <= state.step ? "on" : ""}"></i>`).join("");
    const head = `<div class="topbar">${state.step ? `<button class="iconbtn" id="back">‹</button>` : ""}<div class="dots">${dots}</div></div>`;
    let body = "";
    const d = state.draft;
    if (step === "age") body = `
      <h1>When's your birthday?</h1>
      <p class="muted">This decides who you can see. It can't be changed later, so be honest.</p>
      <div class="field"><label>Birthday</label><input id="bday" class="input" type="date" value="${esc(d.birthdate || "")}" max="${new Date().toISOString().slice(0, 10)}"></div>
      <div id="bracketInfo" class="notice hidden"></div>
      <div id="err" class="error"></div>`;
    if (step === "gender") body = `
      <h1>About you</h1>
      <p class="muted">Your gender shows on your profile. Who you want to meet stays private.</p>
      <div class="field"><label>I am</label>
        <div class="chips" id="gender">${GENDERS.map((g) => `<button class="chip ${d.gender === g.id ? "on" : ""}" data-g="${g.id}">${esc(g.label)}</button>`).join("")}</div>
      </div>
      <div class="field" style="margin-top:10px"><label>Show me</label>
        <div class="chips" id="showMe">${GENDERS.map((g) => `<button class="chip ${(d.showMe || ALL_GENDERS).includes(g.id) ? "on" : ""}" data-s="${g.id}">${esc(g.label)}</button>`).join("")}</div>
      </div>
      <p class="tiny muted">Whatever you pick, you only ever see people in your own age group. You can change this later in Settings.</p>
      <div id="err" class="error"></div>`;
    if (step === "name") body = `
      <h1>What should people call you?</h1>
      <p class="muted">First name or a nickname. No last names.</p>
      <div class="field"><label>Name</label><input id="name" class="input" maxlength="20" placeholder="Alex" value="${esc(d.name || "")}"></div>
      <div class="field"><label>Where you're at (state or country only)</label><input id="region" class="input" maxlength="30" placeholder="Texas" value="${esc(d.region || "")}"></div>
      <div class="field"><label>Bio</label><textarea id="bio" class="input" maxlength="140" placeholder="what are you into?">${esc(d.bio || "")}</textarea></div>
      <div id="err" class="error"></div>`;
    if (step === "photo") body = `
      <h1>Pick your look</h1>
      <p class="muted">Choose an emoji, or add a photo of yourself. Photos of other people, group shots, and anything inappropriate get removed.</p>
      <div class="center">${avatarHtml({ emoji: d.emoji || "🙂", photo: d.photo, gradient: "linear-gradient(135deg,#ff4f8b,#8b5cf6)" }, "lg")}</div>
      <div class="chips" id="emojis">${EMOJIS.map((e) => `<button class="chip ${d.emoji === e ? "on" : ""}" data-e="${e}">${e}</button>`).join("")}</div>
      <label class="btn ghost">📷 Add a photo<input id="photoIn" type="file" accept="image/*" class="hidden"></label>
      ${d.photo ? `<button id="rmPhoto" class="btn ghost sm">Remove photo</button>` : ""}`;
    if (step === "interests") body = `
      <h1>What are you into?</h1>
      <p class="muted">Pick at least 3. This is how people find you.</p>
      <div class="chips" id="tags">${INTERESTS.map((t) => `<button class="chip ${(d.tags || []).includes(t) ? "on" : ""}" data-t="${t}">${t}</button>`).join("")}</div>
      <div id="err" class="error"></div>`;
    if (step === "verify") body = `
      <h1>Quick selfie check</h1>
      <p class="muted">Look at the camera and hold still for a second. This confirms you're a real person and checks your age against your birthday. The frames are never stored.</p>
      <div class="selfie-box" id="selfie"><span class="muted">Camera preview</span></div>
      <div id="checkNote" class="notice">Your face should fill the circle, in decent light.</div>
      <div id="err" class="error"></div>`;

    const last = state.step === STEPS.length - 1;
    screen.innerHTML = `${head}<div class="pad stack grow">${body}<div class="grow"></div><button id="next" class="btn primary">${last ? "Finish" : "Continue"}</button></div>`;

    $("#back") && ($("#back").onclick = () => { state.step--; renderOnboarding(); });

    if (step === "age") {
      const upd = () => {
        const age = S.ageFromBirthdate($("#bday").value); const info = $("#bracketInfo");
        if (age == null) return info.classList.add("hidden");
        info.classList.remove("hidden");
        if (age < S.MIN_AGE) { info.className = "notice warn"; info.textContent = "Hooky is for people 13 and up."; return; }
        const b = S.bracketForAge(age);

        if (!b) { info.className = "notice warn"; info.textContent = "That birthday doesn't look right."; return; }

        info.className = "notice"; info.textContent = `You'll be in the ${b.label} group. You'll only see and be seen by people in that group.`;
      };
      $("#bday").oninput = upd; upd();
    }
    if (step === "photo") {
      $("#emojis").onclick = (e) => { const b = e.target.closest("[data-e]"); if (!b) return; d.emoji = b.dataset.e; renderOnboarding(); };
      $("#photoIn").onchange = (e) => {
        const f = e.target.files[0]; if (!f) return;
        const img = new Image(); const url = URL.createObjectURL(f);
        img.onload = () => {
          const c = document.createElement("canvas"); const s = 512; c.width = c.height = s; const ctx = c.getContext("2d");
          const m = Math.min(img.width, img.height); ctx.drawImage(img, (img.width - m) / 2, (img.height - m) / 2, m, m, 0, 0, s, s);
          d.photo = c.toDataURL("image/jpeg", 0.8); URL.revokeObjectURL(url); renderOnboarding();
        };
        img.src = url;
      };
      $("#rmPhoto") && ($("#rmPhoto").onclick = () => { delete d.photo; renderOnboarding(); });
    }
    if (step === "interests") {
      $("#tags").onclick = (e) => { const b = e.target.closest("[data-t]"); if (!b) return; d.tags = d.tags || []; const t = b.dataset.t; d.tags = d.tags.includes(t) ? d.tags.filter((x) => x !== t) : [...d.tags, t].slice(0, 8); b.classList.toggle("on", d.tags.includes(t)); };
    }
    if (step === "gender") {
      $("#gender").onclick = (e) => { const b = e.target.closest("[data-g]"); if (!b) return; d.gender = b.dataset.g; renderOnboarding(); };
      $("#showMe").onclick = (e) => {
        const b = e.target.closest("[data-s]"); if (!b) return;
        const cur = (d.showMe || ALL_GENDERS).slice();
        const g = b.dataset.s;
        d.showMe = cur.includes(g) ? cur.filter((x) => x !== g) : cur.concat(g);
        b.classList.toggle("on", d.showMe.includes(g));
      };
    }
    if (step === "verify") {
      state.video = null;
      navigator.mediaDevices && navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 640 } } }).then((stream) => {
        const v = document.createElement("video"); v.autoplay = true; v.muted = true; v.playsInline = true; v.srcObject = stream;
        $("#selfie").replaceChildren(v);
        state.video = v;
        state.stopCam = () => stream.getTracks().forEach((t) => t.stop());
      }).catch(() => {
        $("#selfie").innerHTML = `<span class="muted small">Camera unavailable.<br>Allow camera access to continue.</span>`;
      });
    }

    $("#next").onclick = async () => {
      const err = $("#err");
      if (step === "age") {
        const v = $("#bday").value; const age = S.ageFromBirthdate(v);
        if (age == null) return (err.textContent = "Enter your birthday.");
        if (age < S.MIN_AGE) return (err.textContent = "Sorry, you have to be 13 or older to use Hooky.");
        if (age > 100) return (err.textContent = "That doesn't look right.");
        d.birthdate = v;
      }
      if (step === "name") {
        d.name = $("#name").value.trim(); d.region = $("#region").value.trim(); d.bio = $("#bio").value.trim();
        if (d.name.length < 2) return (err.textContent = "Add a name.");
        if (/\d{3,}|@|http/i.test(d.name + d.bio)) return (err.textContent = "No numbers, handles, or links in your name or bio.");
      }
      if (step === "gender") {
        if (!d.gender) return (err.textContent = "Pick how you describe yourself.");
        if (!(d.showMe || ALL_GENDERS).length) return (err.textContent = "Pick at least one group to see.");
        d.showMe = d.showMe || ALL_GENDERS.slice();
      }
      if (step === "photo" && !d.emoji && !d.photo) d.emoji = "🙂";
      if (step === "interests" && (d.tags || []).length < 3) return (err.textContent = "Pick at least 3.");
      if (step === "verify") {
        const btn = $("#next");
        btn.disabled = true; btn.textContent = "Saving…";
        try {
          // The profile has to exist before the server can attach a verdict to it.
          state.me = await store.saveMe(d);
          btn.textContent = "Checking…";
          const frames = await captureFrames();
          state.stopCam && state.stopCam(); state.stopCam = null;
          await store.submitAgeCheck(frames);
          state.me = await store.getMe();
          buzz([30, 40, 30]); toast("You're in 🎣"); return showTab("discover");
        } catch (e) {
          btn.disabled = false; btn.textContent = "Try again";
          err.textContent = e.message || "The age check didn't go through.";
          return;
        }
      }
      state.step++; renderOnboarding();
    };
  }

  // Grabs a few frames a moment apart. Several frames let the server tell a live
  // person from a single photo held up to the lens.
  async function captureFrames(count = 3, gapMs = 400) {
    const v = state.video;
    if (!v || !v.videoWidth) throw new Error("Allow camera access to finish the check.");
    const c = document.createElement("canvas");
    const w = 320; c.width = w; c.height = Math.round((v.videoHeight / v.videoWidth) * w);
    const ctx = c.getContext("2d");
    const out = [];
    for (let i = 0; i < count; i++) {
      ctx.drawImage(v, 0, 0, c.width, c.height);
      out.push(c.toDataURL("image/jpeg", 0.75));
      if (i < count - 1) await new Promise((r) => setTimeout(r, gapMs));
    }
    return out;
  }

  // ---------- tabs ----------
  tabs.addEventListener("click", (e) => { const b = e.target.closest("[data-tab]"); if (b) { buzz(6); showTab(b.dataset.tab); } });
  function showTab(tab) {
    state.tab = tab; state.chatId = null; setTabsVisible(true);
    tabs.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
    refreshUnread();
    ({ discover: renderDiscover, matches: renderMatches, profile: renderProfile })[tab]();
  }

  // ---------- discover ("Catch") ----------
  async function renderDiscover() {
    const me = state.me = await store.getMe();
    let cands = await store.candidates();
    const onlineCount = cands.filter((c) => c.online).length;
    if (state.onlineOnly) cands = cands.filter((c) => c.online);
    const left = await store.likesRemaining();
    const b = S.bracketForAge(me.age);
    screen.innerHTML = `<div class="topbar"><img class="brand-img" src="assets/wordmark.png" alt="hooky"><span class="pill">${b.label}</span><div class="grow"></div>
        <button class="toggle ${state.onlineOnly ? "on" : ""}" id="onlineOnly"><span class="dot on"></span>${onlineCount} online</button>
        ${me.premium ? `<span class="pill plus">PLUS</span>` : ""}</div>
      <div class="deck-wrap">
        <div class="deck" id="deck"></div>
        <div class="actions">
          <button class="act undo" id="undo" title="Undo">↶</button>
          <button class="act nope" id="nope" title="Pass">✕</button>
          <button class="act like hook" id="like" title="Hook">${HOOK}</button>
          <button class="act undo" id="likes" title="Who hooked you">👀</button>
        </div>
        <div class="likes-left">${hooksLeftText(left)}</div>
      </div>`;
    $("#onlineOnly").onclick = () => { state.onlineOnly = !state.onlineOnly; renderDiscover(); };
    $("#likes").onclick = renderWhoLiked;
    $("#undo").onclick = async () => { if (!me.premium) return renderPlus("Undo is a Hooky+ perk"); if (await store.undo()) renderDiscover(); else toast("Nothing to undo"); };

    const deck = $("#deck"); let queue = [];
    function paint() {
      deck.innerHTML = "";
      if (!cands.length) {
        deck.innerHTML = `<div class="empty"><div><div class="big">🎣</div><h3>Nothing biting</h3><p class="small">${state.onlineOnly ? "Nobody new is online right now. Turn off the filter or check back in a bit." : `You've seen everyone in the ${b.label} group. Cast again later.`}</p></div></div>`; return;
      }
      queue = cands.slice(0, 3);
      queue.slice().reverse().forEach((u, i) => {
        const idx = queue.length - 1 - i;
        const el = document.createElement("div");
        el.className = "card " + (idx === 1 ? "behind" : idx === 2 ? "behind2" : "");
        el.innerHTML = `<div class="card-hero" style="background:${u.gradient}">${u.photo ? `<img src="${esc(u.photo)}">` : esc(u.emoji)}</div><div class="card-shade"></div>
          ${u.online ? `<span class="live-badge"><span class="dot on"></span>Online now</span>` : ""}
          <button class="card-report" data-report="${u.id}">⚑</button>
          <div class="stamp like">HOOK</div><div class="stamp nope">PASS</div>
          <div class="card-body"><div class="card-name">${esc(u.name)}, ${u.age}</div><div class="card-meta">📍 ${esc(u.region)}</div>
          <div class="card-bio">${esc(u.bio)}</div><div class="card-tags">${u.tags.map((t) => `<span>${esc(t)}</span>`).join("")}</div></div>`;
        deck.appendChild(el);
        if (idx === 0) attachDrag(el, u);
      });
    }
    deck.addEventListener("click", (e) => { const r = e.target.closest("[data-report]"); if (r) { e.stopPropagation(); openReport(cands.find((c) => c.id === r.dataset.report), () => { cands.shift(); paint(); }); } });

    function attachDrag(el, u) {
      let sx = 0, sy = 0, dx = 0, dragging = false;
      const stL = $(".stamp.like", el), stN = $(".stamp.nope", el);
      el.onpointerdown = (e) => { if (e.target.closest("[data-report]")) return; dragging = true; sx = e.clientX; sy = e.clientY; el.setPointerCapture(e.pointerId); el.style.transition = "none"; };
      el.onpointermove = (e) => { if (!dragging) return; dx = e.clientX - sx; const dy = e.clientY - sy; el.style.transform = `translate(${dx}px,${dy}px) rotate(${dx / 14}deg)`; stL.style.opacity = Math.max(0, dx / 90); stN.style.opacity = Math.max(0, -dx / 90); };
      const end = () => { if (!dragging) return; dragging = false; if (dx > 110) fly(el, u, "like"); else if (dx < -110) fly(el, u, "nope"); else { el.style.transition = "transform .25s"; el.style.transform = ""; stL.style.opacity = stN.style.opacity = 0; } dx = 0; };
      el.onpointerup = end; el.onpointercancel = end;
    }
    async function fly(el, u, dir) {
      const res = await store.swipe(u.id, dir);
      if (res.limited) { el.style.transition = "transform .25s"; el.style.transform = ""; return renderPlus("You're out of hooks for today"); }
      buzz(8);
      el.style.transition = "transform .4s ease, opacity .4s"; el.style.transform = `translate(${dir === "like" ? 600 : -600}px, -40px) rotate(${dir === "like" ? 30 : -30}deg)`; el.style.opacity = 0;
      cands.shift();
      setTimeout(async () => { paint(); $(".likes-left").textContent = hooksLeftText(await store.likesRemaining()); }, 250);
      if (res.matched) celebrate(u, res.matched);
    }
    $("#nope").onclick = () => { const top = deck.querySelector(".card:last-child"); if (top && queue[0]) fly(top, queue[0], "nope"); };
    $("#like").onclick = () => { const top = deck.querySelector(".card:last-child"); if (top && queue[0]) fly(top, queue[0], "like"); };
    paint();
  }

  function confetti() {
    const colors = ["#ff4f8b", "#ff7a59", "#c8ff4f", "#8b5cf6", "#fff"];
    for (let i = 0; i < 70; i++) {
      const s = document.createElement("i"); s.className = "confetti";
      s.style.left = Math.random() * 100 + "%"; s.style.background = colors[i % colors.length];
      s.style.animationDelay = Math.random() * 0.6 + "s"; s.style.transform = `rotate(${Math.random() * 360}deg)`;
      $("#app").appendChild(s); setTimeout(() => s.remove(), 2600);
    }
  }
  function celebrate(u, match) {
    buzz([40, 60, 40, 60, 120]); confetti();
    const online = store.isOnline(u.id);
    const el = document.createElement("div"); el.className = "boom";
    el.innerHTML = `<div><h1>It's a catch!</h1><p class="muted">You and ${esc(u.name)} hooked each other.${online ? ` They're online right now.` : ""}</p>
      <div class="pair">${avatarHtml(state.me)}${avatarHtml(u)}</div>
      ${online ? `<button class="btn lime" id="live">📹 Go live now</button><br><br>` : ""}
      <button class="btn primary" id="say">Say hi 👋</button><br><br><button class="btn ghost" id="later">Keep casting</button></div>`;
    $("#app").appendChild(el);
    $("#later", el).onclick = () => el.remove();
    $("#say", el).onclick = () => { el.remove(); openChat(match.id); };
    $("#live", el) && ($("#live", el).onclick = async () => { el.remove(); const m = (await store.matches()).find((x) => x.id === match.id); openChat(match.id); ringUser(m); });
  }

  async function renderWhoLiked() {
    const me = state.me; const people = await store.whoLikedMe();
    modal(`<h2>${people.length} ${people.length === 1 ? "person" : "people"} hooked you</h2>
      ${me.premium ? `<div class="list">${people.map((p) => `<div class="item">${avatarHtml(p, "", store.isOnline(p.id))}<div><div class="name">${esc(p.name)}, ${p.age}</div><div class="preview">${esc(p.tags.join(" · "))}</div></div></div>`).join("") || `<p class="muted">Nobody yet. Keep casting.</p>`}</div>`
        : `<p class="muted">See who already hooked you and catch them instantly with Hooky+.</p><div class="row" style="filter:blur(6px);pointer-events:none">${people.slice(0, 4).map((p) => avatarHtml(p)).join("")}</div><br><button class="btn lime" id="getPlus">Get Hooky+</button>`}`);
    $("#getPlus") && ($("#getPlus").onclick = () => { closeModal(); renderPlus(); });
  }

  // ---------- report / block ----------
  function openReport(u, after) {
    if (!u) return;
    modal(`<h2>Report ${esc(u.name)}</h2><p class="muted small">Reports are private. ${esc(u.name)} won't know. Our team reviews every report, and anything involving someone's safety goes to the top of the queue.</p>
      <div class="stack" id="reasons">${S.REPORT_REASONS.map((r) => `<button class="btn ghost" style="justify-content:flex-start" data-r="${esc(r)}">${esc(r)}</button>`).join("")}</div>
      <br><button class="btn danger" id="blockOnly">Just block</button>`);
    $("#reasons").onclick = async (e) => { const b = e.target.closest("[data-r]"); if (!b) return; await store.report(u.id, b.dataset.r, ""); await store.block(u.id); closeModal(); toast("Reported and blocked. Thank you."); after && after(); };
    $("#blockOnly").onclick = async () => { await store.block(u.id); closeModal(); toast("Blocked"); after && after(); };
  }

  // ---------- matches + chat ----------
  async function renderMatches() {
    const ms = await store.matches();
    const online = ms.filter((m) => m.online);
    const fresh = ms.filter((m) => !m.last);
    screen.innerHTML = `<div class="topbar"><h2 style="margin:0">Chats</h2></div>
      ${online.length ? `<div class="section">Online now</div><div class="online-row">${online.map((m) => `<button data-open="${m.id}">${avatarHtml(m.user, "", true)}<span>${esc(m.user.name)}</span></button>`).join("")}</div>` : ""}
      ${fresh.length ? `<div class="section">New catches</div><div class="new-matches">${fresh.map((m) => `<button data-open="${m.id}">${avatarHtml(m.user)}<span>${esc(m.user.name)}</span></button>`).join("")}</div>` : ""}
      <div class="list">${ms.filter((m) => m.last).map((m) => `<button class="item" data-open="${m.id}">${avatarHtml(m.user, "", m.online)}<div><div class="name">${esc(m.user.name)}</div><div class="preview">${m.last.from === "me" ? "You: " : ""}${esc(m.last.text)}</div></div>${m.unread ? `<span class="badge" style="position:static">${m.unread}</span>` : ""}<span class="time">${timeAgo(m.last.at)}</span></button>`).join("")}</div>
      ${!ms.length ? `<div class="empty"><div><div class="big">💬</div><h3>No catches yet</h3><p class="small">When you and someone hook each other, you'll chat here. When you're both online, you can go live.</p></div></div>` : ""}`;
    screen.onclick = (e) => { const b = e.target.closest("[data-open]"); if (b) openChat(b.dataset.open); };
  }

  async function openChat(matchId) {
    screen.onclick = null; state.chatId = matchId;
    const m = (await store.matches()).find((x) => x.id === matchId); if (!m) return showTab("matches");
    const u = m.user; const me = state.me;
    const strict = S.bracketForAge(me.age).minor;
    const online = store.isOnline(u.id);
    screen.innerHTML = `<div class="topbar"><button class="iconbtn" id="back">‹</button>${avatarHtml(u, "", online)}<div class="who"><div style="font-weight:700">${esc(u.name)}, ${u.age}</div><div class="tiny ${online ? "" : "muted"}" style="${online ? "color:var(--ok)" : ""}">${online ? "Online now" : "Offline"}</div></div><div class="grow"></div>
        <button class="iconbtn" id="video" title="Go live" style="${online ? "background:rgba(74,222,128,0.15)" : "opacity:.45"}">📹</button><button class="iconbtn" id="more">⋯</button></div>
      <div class="chat"><div class="msgs" id="msgs"></div>
      <form class="composer" id="form"><input id="txt" class="input" placeholder="Message ${esc(u.name)}…" autocomplete="off" maxlength="500"><button class="send" type="submit">➤</button></form></div>`;
    $("#back").onclick = () => { unsub(); showTab("matches"); };
    $("#video").onclick = () => ringUser(m);
    $("#more").onclick = () => modal(`<h2>${esc(u.name)}</h2><div class="stack"><button class="btn ghost" id="rep">⚑ Report</button><button class="btn danger" id="blk">Block ${esc(u.name)}</button></div>`, () => {
      $("#rep").onclick = () => { closeModal(); openReport(u, () => { unsub(); showTab("matches"); }); };
      $("#blk").onclick = async () => { await store.block(u.id); closeModal(); unsub(); toast("Blocked"); showTab("matches"); };
    });
    const box = $("#msgs");
    async function load() {
      if (state.chatId !== matchId) return;
      const msgs = await store.messages(matchId);
      box.innerHTML = `<div class="msg sys">🎣 Real friends don't ask you to leave Hooky, send photos, or keep secrets. Report anything weird.</div>` +
        msgs.map((x) => `<div class="msg ${x.from === "me" ? "me" : x.from === "sys" ? "sys" : "them"}">${esc(x.text)}</div>`).join("");
      box.scrollTop = box.scrollHeight; refreshUnread();
    }
    const unsub = store.subscribe(matchId, load);
    $("#form").onsubmit = async (e) => {
      e.preventDefault(); const t = $("#txt").value.trim(); if (!t) return;
      const res = await store.send(matchId, t);
      if (res.blocked) return modal(`<h2>Hold up</h2><p>That message looks like it shares ${esc(res.reasons.join(", "))}. ${strict ? "To keep everyone safe, chats in teen groups stay on Hooky." : "Chats stay on Hooky."}</p><p class="muted small">Want to actually talk? If ${esc(u.name)} is online, tap 📹 to go live instead. If someone is pressuring you to leave Hooky or share personal info, that's a red flag. Report them from the ⋯ menu.</p><button class="btn primary" id="ok">Got it</button>`, () => { $("#ok").onclick = closeModal; });
      if (res.warn) toast("Careful sharing " + res.warn.join(", "));
      $("#txt").value = ""; load();
    };
    load();
  }

  // ---------- profile ----------
  async function renderProfile() {
    const me = state.me = await store.getMe();
    const b = S.bracketForAge(me.age);
    const blocked = await store.blocked();
    screen.innerHTML = `<div class="topbar"><h2 style="margin:0">Me</h2><div class="grow"></div>${me.premium ? `<span class="pill plus">PLUS</span>` : ""}</div>
      <div class="pad stack">
        <div class="row">${avatarHtml(me, "lg")}<div><h2 style="margin:0">${esc(me.name)}, ${me.age}</h2><div class="muted small">📍 ${esc(me.region || "")}</div><div class="row" style="margin-top:6px"><span class="pill">${b.label}</span><span class="pill ${me.verification ? "ok" : "pending"}">${me.verification ? "✓ age checked" : "not checked"}</span></div></div></div>
        <p class="small">${esc(me.bio || "")}</p>
        <div class="chips">${(me.tags || []).map((t) => `<span class="chip on">${esc(t)}</span>`).join("")}</div>
        <button class="btn ghost" id="edit">Edit profile</button>
        ${me.premium ? "" : `<div class="plus-hero"><h3>Hooky+</h3><p class="small muted">Unlimited hooks, see who hooked you, undo passes.</p><button class="btn lime" id="plus">See plans</button></div>`}
        <div class="card-box">
          <h3>Safety</h3>
          <div class="setting"><span>Age group</span><span class="muted small">${b.label} (locked)</span></div>
          <div class="setting"><span>Who can see me</span><span class="muted small">Only my age group</span></div>
          <div class="setting"><span>I am</span><span class="muted small">${esc((GENDERS.find((g) => g.id === me.gender) || {}).label || "not set")}</span></div>
          <div class="setting"><span>Show me</span><span class="muted small">${esc((me.showMe || ALL_GENDERS).map((g) => (GENDERS.find((x) => x.id === g) || {}).label).filter(Boolean).join(", ") || "everyone")}</span></div>
          <div class="setting"><span>Live calls</span><span class="muted small">Catches only, both online</span></div>
          <div class="setting"><span>Location shown</span><span class="muted small">Region only</span></div>
          <button class="setting" id="blockedBtn"><span>Blocked people</span><span class="muted small">${blocked.length} ›</span></button>
          <button class="setting" id="tips"><span>Safety tips &amp; help</span><span class="muted small">›</span></button>
          <a class="setting" href="mailto:${SUPPORT_EMAIL}" style="text-decoration:none;color:inherit"><span>Contact support</span><span class="muted small">›</span></a>
          <a class="setting" href="legal.html" target="_blank" style="text-decoration:none;color:inherit"><span>Terms, privacy &amp; guidelines</span><span class="muted small">›</span></a>
        </div>
        <div class="card-box">
          <h3>Account</h3>
          ${store.kind === "local" ? `<button class="setting" id="togglePlus"><span>Demo: toggle Hooky+</span><span class="muted small">${me.premium ? "on" : "off"}</span></button>` : ""}
          <button class="setting" id="signout"><span>Sign out</span><span class="muted small">›</span></button>
          <button class="setting" id="del"><span style="color:var(--danger)">Delete my account</span><span class="muted small">›</span></button>
        </div>
        <p class="tiny muted center">Hooky ${store.kind === "local" ? "demo build" : ""} · Not a dating app · 13+</p>
      </div>`;
    $("#edit").onclick = () => renderSettings();
    $("#plus") && ($("#plus").onclick = () => renderPlus());
    $("#togglePlus") && ($("#togglePlus").onclick = async () => { await store.setPremium(!me.premium); renderProfile(); });
    $("#blockedBtn").onclick = () => modal(`<h2>Blocked</h2><div class="list">${blocked.map((p) => `<div class="item">${avatarHtml(p)}<div class="name">${esc(p.name)}</div><button class="btn ghost sm" data-un="${p.id}" style="margin-left:auto">Unblock</button></div>`).join("") || `<p class="muted">Nobody blocked.</p>`}</div>`, (bg) => { bg.onclick = async (e) => { const b = e.target.closest("[data-un]"); if (b) { await store.unblock(b.dataset.un); closeModal(); renderProfile(); } else if (e.target === bg) closeModal(); }; });
    $("#tips").onclick = () => modal(`<h2>Stay safe on Hooky</h2><div class="stack small">
      <p>🎣 <b>Keep it on Hooky.</b> Someone pushing you to leave and talk somewhere else right away is the number one warning sign. Everything you need is here, including live calls.</p>
      <p>📹 <b>On a live call, you're in charge.</b> Face on, keep it appropriate. If anyone asks you to show or do something you don't want to, hang up and report. Nothing is recorded, and you're never in trouble for ending a call.</p>
      <p>📸 <b>Never send photos you wouldn't want everyone to see.</b> If someone threatens you with a photo, that's a crime called sextortion. Tell an adult you trust and report them here.</p>
      <p>📍 <b>Don't share your school, address, or schedule.</b> Meeting someone from the internet in person means a trusted adult knows and comes along.</p>
      <p>🚩 <b>Trust your gut.</b> Report and block freely. You never owe anyone a reply.</p>
      <p class="muted">Need help now? In the US, text or call 988, or contact the CyberTipline at report.cybertip.org.</p></div>
      <button class="btn primary" id="ok">Got it</button>`, () => { $("#ok").onclick = closeModal; });
    $("#signout").onclick = async () => { await store.signOut(); boot(); };
    $("#del").onclick = () => modal(`<h2>Delete account?</h2><p class="muted">This removes your profile, catches, and messages. It can't be undone.</p><button class="btn danger" id="yes">Delete everything</button><br><br><button class="btn ghost" id="no">Cancel</button>`, () => { $("#no").onclick = closeModal; $("#yes").onclick = async () => { await store.deleteAccount(); closeModal(); boot(); }; });
  }

  // ---------- settings ----------
  // Everything editable lives here. Birthdate is deliberately absent: it is
  // write-once, in the client and in the database.
  async function renderSettings() {
    const me = state.me = await store.getMe();
    const d = Object.assign({ showMe: ALL_GENDERS.slice() }, me);
    setTabsVisible(false);

    function paint() {
      screen.innerHTML = `<div class="topbar"><button class="iconbtn" id="back">‹</button><h2 style="margin:0">Settings</h2></div>
        <div class="pad stack">
          <div class="center">${avatarHtml({ emoji: d.emoji, photo: d.photo, gradient: me.gradient }, "lg")}</div>
          <div class="chips center" id="emojis" style="justify-content:center">${EMOJIS.map((e) => `<button class="chip ${d.emoji === e && !d.photo ? "on" : ""}" data-e="${e}">${e}</button>`).join("")}</div>
          <div class="row">
            <label class="btn ghost sm">📷 Photo<input id="photoIn" type="file" accept="image/*" class="hidden"></label>
            ${d.photo ? `<button id="rmPhoto" class="btn ghost sm">Remove photo</button>` : ""}
          </div>

          <div class="card-box stack">
            <h3>Profile</h3>
            <div class="field"><label>Name</label><input id="name" class="input" maxlength="20" value="${esc(d.name || "")}"></div>
            <div class="field"><label>Region</label><input id="region" class="input" maxlength="30" value="${esc(d.region || "")}"></div>
            <div class="field"><label>Bio</label><textarea id="bio" class="input" maxlength="140">${esc(d.bio || "")}</textarea></div>
            <div class="field"><label>Interests (pick up to 8)</label>
              <div class="chips" id="tags">${INTERESTS.map((t) => `<button class="chip ${(d.tags || []).includes(t) ? "on" : ""}" data-t="${t}">${t}</button>`).join("")}</div>
            </div>
          </div>

          <div class="card-box stack">
            <h3>You and who you meet</h3>
            <div class="field"><label>I am</label>
              <div class="chips" id="gender">${GENDERS.map((g) => `<button class="chip ${d.gender === g.id ? "on" : ""}" data-g="${g.id}">${esc(g.label)}</button>`).join("")}</div>
            </div>
            <div class="field"><label>Show me</label>
              <div class="chips" id="showMe">${GENDERS.map((g) => `<button class="chip ${(d.showMe || []).includes(g.id) ? "on" : ""}" data-s="${g.id}">${esc(g.label)}</button>`).join("")}</div>
            </div>
            <p class="tiny muted">Matching is mutual: you both have to be in each other's "show me" to appear.</p>
            <div class="setting"><span>Age group</span><span class="muted small">${S.bracketForAge(me.age).label} · locked</span></div>
            <div class="setting"><span>Birthday</span><span class="muted small">${esc(me.birthdate || "")} · can't change</span></div>
          </div>

          <div id="err" class="error"></div>
          <button id="save" class="btn primary">Save changes</button>
        </div>`;

      $("#back").onclick = () => showTab("profile");
      $("#emojis").onclick = (e) => { const b = e.target.closest("[data-e]"); if (!b) return; d.emoji = b.dataset.e; delete d.photo; paint(); };
      $("#rmPhoto") && ($("#rmPhoto").onclick = () => { delete d.photo; paint(); });
      $("#photoIn").onchange = (e) => {
        const f = e.target.files[0]; if (!f) return;
        const img = new Image(); const url = URL.createObjectURL(f);
        img.onload = () => {
          const c = document.createElement("canvas"); const s = 512; c.width = c.height = s;
          const ctx = c.getContext("2d"); const m = Math.min(img.width, img.height);
          ctx.drawImage(img, (img.width - m) / 2, (img.height - m) / 2, m, m, 0, 0, s, s);
          d.photo = c.toDataURL("image/jpeg", 0.8); URL.revokeObjectURL(url); paint();
        };
        img.src = url;
      };
      $("#tags").onclick = (e) => {
        const b = e.target.closest("[data-t]"); if (!b) return;
        const t = b.dataset.t; const cur = d.tags || [];
        d.tags = cur.includes(t) ? cur.filter((x) => x !== t) : cur.concat(t).slice(0, 8);
        b.classList.toggle("on", d.tags.includes(t));
      };
      $("#gender").onclick = (e) => { const b = e.target.closest("[data-g]"); if (!b) return; d.gender = b.dataset.g; paint(); };
      $("#showMe").onclick = (e) => {
        const b = e.target.closest("[data-s]"); if (!b) return;
        const g = b.dataset.s; const cur = d.showMe || [];
        d.showMe = cur.includes(g) ? cur.filter((x) => x !== g) : cur.concat(g);
        b.classList.toggle("on", d.showMe.includes(g));
      };

      $("#save").onclick = async () => {
        const err = $("#err"); err.textContent = "";
        d.name = $("#name").value.trim(); d.region = $("#region").value.trim(); d.bio = $("#bio").value.trim();
        if (d.name.length < 2) return (err.textContent = "Add a name.");
        if (/\d{3,}|@|http/i.test(d.name + d.bio)) return (err.textContent = "No numbers, handles, or links in your name or bio.");
        if (!d.gender) return (err.textContent = "Pick how you describe yourself.");
        if (!(d.showMe || []).length) return (err.textContent = "Pick at least one group to see.");
        if ((d.tags || []).length < 3) return (err.textContent = "Pick at least 3 interests.");
        $("#save").disabled = true; $("#save").textContent = "Saving…";
        try {
          state.me = await store.saveMe(d);
          toast("Saved"); showTab("profile");
        } catch (e2) {
          $("#save").disabled = false; $("#save").textContent = "Save changes";
          err.textContent = e2.message || "Couldn't save.";
        }
      };
    }
    paint();
  }

  // ---------- Hooky+ (paid tier) ----------
  function renderPlus(reason) {
    if (typeof reason !== "string") reason = "";
    let plan = "year";
    const paint = () => modal(`<div class="plus-hero"><h2>Hooky+</h2><p class="muted small">${esc(reason || "More ways to meet people your age.")}</p></div><br>
      <div class="perk"><span class="ico">♾️</span><div><b>Unlimited hooks</b><div class="muted small">Free accounts get ${FREE_DAILY_LIKES} a day.</div></div></div>
      <div class="perk"><span class="ico">👀</span><div><b>See who hooked you</b><div class="muted small">Catch them instantly instead of waiting.</div></div></div>
      <div class="perk"><span class="ico">↶</span><div><b>Undo a pass</b><div class="muted small">Swiped too fast? Bring them back.</div></div></div>
      <div class="perk"><span class="ico">🎨</span><div><b>Profile flair</b><div class="muted small">Animated borders and more emoji.</div></div></div><br>
      <div class="plans">
        <button class="plan ${plan === "month" ? "on" : ""}" data-p="month"><div class="muted tiny">Monthly</div><div class="price">$4.99</div><div class="tiny muted">per month</div></button>
        <button class="plan ${plan === "year" ? "on" : ""}" data-p="year"><div class="muted tiny">Yearly</div><div class="price">$29.99</div><div class="save">save 50%</div></button>
      </div><br>
      <button class="btn lime" id="buy">Continue</button>
      <p class="tiny muted center" style="margin-top:10px">Billed through your phone's app store. Cancel anytime. Live calls and safety features are always free.</p>`, () => {
      modalRoot.querySelectorAll("[data-p]").forEach((b) => (b.onclick = () => { plan = b.dataset.p; paint(); }));
      $("#buy").onclick = async () => {
        if (store.kind === "local") { await store.setPremium(true); closeModal(); buzz([30, 30, 30]); toast("Hooky+ unlocked (demo)"); showTab(state.tab); }
        else toast("Purchases go through your phone's app store in the mobile build.");
      };
    });
    paint();
  }

  boot();
})();

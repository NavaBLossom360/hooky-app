// Data layer. Two implementations with the same interface:
//   LocalStore    - demo mode, everything in localStorage with seeded fake users
//   SupabaseStore - real backend, used when config.js defines window.HOOKY_CONFIG
(function () {
  const S = window.HookySafety;
  const FREE_DAILY_LIKES = 25;
  // Used when the TURN function is unreachable or not configured.
  const FALLBACK_ICE = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];
  const DAY = 86400000;

  const GRADIENTS = [
    "linear-gradient(135deg,#ff4f8b,#8b5cf6)", "linear-gradient(135deg,#c8ff4f,#22c55e)",
    "linear-gradient(135deg,#38bdf8,#6366f1)", "linear-gradient(135deg,#f59e0b,#ef4444)",
    "linear-gradient(135deg,#a855f7,#ec4899)", "linear-gradient(135deg,#14b8a6,#3b82f6)",
  ];
  function hash(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; }
  function gradientFor(id) { return GRADIENTS[hash(id) % GRADIENTS.length]; }

  // Seeded demo users. Real photos are never bundled; avatars are emoji.
  const P = (id, name, age, emoji, region, bio, tags, likedYou) => ({ id, name, age, emoji, region, bio, tags, likedYou: !!likedYou });
  const DEMO = [
    P("d1", "Maya", 14, "🎨", "Texas", "art kid. i draw during math. trade sketchbook pages?", ["Art", "Anime", "Music"], true),
    P("d2", "Jordan", 15, "🎮", "Ohio", "builder in blocky games, i will judge your base", ["Gaming", "Building", "Memes"], false),
    P("d3", "Sofia", 13, "🎧", "California", "new in town, need people to nerd out about kpop with", ["K-pop", "Dance", "Gaming"], true),
    P("d4", "Eli", 15, "🛹", "Florida", "skate + film. send me your fav indie movie", ["Skating", "Movies", "Photography"], false),
    P("d5", "Priya", 14, "📚", "New Jersey", "reads 3 books a week, has opinions about all of them", ["Books", "Debate", "Baking"], true),
    P("d6", "Noah", 13, "⚽", "Georgia", "soccer goalie. also unironically into chess", ["Soccer", "Chess", "Gaming"], false),
    P("d7", "Zoe", 16, "🎸", "Washington", "learning guitar badly. band recs pls", ["Music", "Guitar", "Thrifting"], true),
    P("d8", "Luca", 17, "🏀", "Illinois", "varsity hooper, plays too many basketball games", ["Basketball", "Gaming", "Memes"], false),
    P("d9", "Aisha", 16, "🧪", "Michigan", "science olympiad + i bake when stressed, so, a lot", ["Science", "Baking", "Anime"], true),
    P("d10", "Theo", 17, "🎬", "Oregon", "making short films with my friends, always need actors", ["Movies", "Photography", "Theater"], false),
    P("d11", "Harper", 16, "🏃", "Colorado", "cross country. i will talk about running shoes for hours", ["Running", "Hiking", "Music"], true),
    P("d12", "Sam", 17, "🐍", "Arizona", "coding my own game, it is cursed but fun", ["Coding", "Gaming", "Building"], false),
    P("d13", "Riley", 18, "☕", "New York", "college freshman, running on iced coffee", ["Coffee", "Music", "Hiking"], true),
    P("d14", "Diego", 20, "🎶", "Texas", "producing beats in my dorm", ["Music", "Coding", "Basketball"], false),
    P("d15", "Nina", 23, "🌿", "California", "plant mom, marathon training, terrible at cooking", ["Running", "Plants", "Movies"], true),
    P("d16", "Marcus", 25, "🏋️", "Illinois", "gym, board games, and a very needy cat", ["Fitness", "Board games", "Cats"], false),
  ];
  const REPLIES = [
    "heyy! wait your profile is so cool", "omg finally someone who likes that too",
    "haha what are you up to rn", "what are you into outside of this app", "ok that's actually fire", "same honestly", "lmaooo", "wait tell me more", "bet. what else are you into?",
    "wanna go live for a sec?",
  ];

  // Demo-only gender assignment, kept out of the P() rows to avoid a 9th arg.
  const DEMO_GENDER = { d1: "woman", d2: "man", d3: "woman", d4: "man", d5: "woman", d6: "man", d7: "woman", d8: "man", d9: "woman", d10: "man", d11: "nonbinary", d12: "man", d13: "woman", d14: "man", d15: "woman", d16: "man" };
  const ALL_GENDERS = S.GENDERS.map((g) => g.id);

  // Supabase auth errors, reworded for people rather than developers.
  function friendlyAuth(err) {
    const m = (err && err.message) || "";
    let msg = m;
    if (/invalid login credentials/i.test(m)) msg = "That email and password don't match.";
    else if (/email not confirmed/i.test(m)) msg = "Confirm your email first. Check your inbox for the link.";
    else if (/rate limit|too many|seconds/i.test(m)) msg = "Too many emails for now. Wait a few minutes and try again.";
    else if (/password should be at least|weak password/i.test(m)) msg = "Pick a longer password: at least 8 characters.";
    else if (/already registered|already been registered/i.test(m)) msg = "There's already an account with that email. Log in instead.";
    else if (/invalid email|unable to validate email/i.test(m)) msg = "That email address doesn't look right.";
    const e = new Error(msg); e.code = /email not confirmed/i.test(m) ? "unconfirmed" : /already/i.test(m) ? "exists" : err.code;
    return e;
  }

  function withBracket(u) {
    const b = S.ageBand(u.age);
    return Object.assign({}, u, { band: b ? b.label : null, minor: S.isMinor(u.age), gradient: gradientFor(u.id) });
  }

  // ---------------- Local demo store ----------------
  class LocalStore {
    constructor() { this.kind = "local"; this.key = "hooky.v1"; this.load(); this.listeners = new Set(); this.callListeners = new Set(); }
    load() {
      try { this.db = JSON.parse(localStorage.getItem(this.key)) || null; } catch { this.db = null; }
      if (!this.db) this.db = { me: null, swipes: {}, matches: [], messages: {}, reports: [], blocks: [], likesLog: [], premium: false, tier: null, unread: {}, rang: {}, rooms: [], roomMsgs: {} };
      this.db.rang = this.db.rang || {};
      this.db.rooms = this.db.rooms || [];
      this.db.roomMsgs = this.db.roomMsgs || {};
    }
    persist() { try { localStorage.setItem(this.key, JSON.stringify(this.db)); } catch {} }
    save() { this.persist(); this.emit(); }
    onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    emit() { this.listeners.forEach((fn) => fn()); }
    async init() { return true; }
    async reset() { localStorage.removeItem(this.key); this.load(); this.emit(); }

    async getMe() {
      if (!this.db.me) return null;
      const photos = this.photoRefs();
      // Age comes from the birthday every time, so it moves on after a birthday.
      return withBracket(Object.assign({ premium: this.db.premium, tier: this.db.tier }, this.db.me, { age: S.ageFromBirthdate(this.db.me.birthdate), photos, photo: photos.length ? photos[0].url : null }));
    }
    // Mirrors the server: a profile can only be created after the age check,
    // with a birthday that fits what the camera saw. Photos are never saved
    // here, only through addPhoto and friends, like the real backend.
    async saveMe(input) {
      const { photos, photo, pics, ...profile } = input;
      profile.age = S.ageFromBirthdate(profile.birthdate);
      if (!this.db.me) {
        const ac = this.db.ageCheck;
        if (!ac) throw new Error("age check required");
        if (!S.ageFitsEstimate(profile.age, ac.estimate)) throw new Error("birthday does not match age check");
        profile.verification = "estimated"; profile.verificationProvider = "on-device";
      }
      this.db.me = Object.assign({}, this.db.me || { id: "me" }, profile);
      this.save();
      return this.getMe();
    }
    ageCheck() { return this.db.ageCheck || null; }
    async saveAgeCheck(ac) { this.db.ageCheck = ac; this.save(); }
    async claimAgeCheck() {
      const me = this.db.me, ac = this.db.ageCheck;
      if (!me || !ac) throw new Error("age check required");
      if (!S.ageFitsEstimate(S.ageFromBirthdate(me.birthdate), ac.estimate)) throw new Error("birthday does not match age check");
      me.verification = "estimated"; me.verificationProvider = "on-device"; this.save();
    }
    async setPremium(on, tier) { this.db.premium = !!on; this.db.tier = on ? (tier || "plus") : null; this.save(); }
    // ----- photos (demo stand-in for the photo-check function) -----
    // Up to four, stored as data URLs. The ref IS the URL here; on the real
    // backend it is a storage path.
    photoRefs() { return ((this.db.me && this.db.me.pics) || []).map((u) => ({ ref: u, url: u })); }
    async addPhoto(dataUrl) {
      const me = this.db.me; if (!me) throw new Error("set up your profile first");
      me.pics = me.pics || [];
      if (me.pics.length >= S.MAX_PHOTOS) { const e = new Error(`You can have up to ${S.MAX_PHOTOS} photos. Remove one first.`); e.rejected = true; throw e; }
      me.pics.push(dataUrl); this.save();
      return this.photoRefs();
    }
    async removePhoto(ref) { const me = this.db.me; me.pics = (me.pics || []).filter((u) => u !== ref); this.save(); return this.photoRefs(); }
    async setMainPhoto(ref) { const me = this.db.me; me.pics = [ref].concat((me.pics || []).filter((u) => u !== ref)); this.save(); return this.photoRefs(); }
    async photosFor() { return {}; }
    async signOut() { await this.reset(); }
    async deleteAccount() { await this.reset(); }

    people() { return DEMO.map((p) => withBracket(Object.assign({ gender: DEMO_GENDER[p.id] || "other" }, p))); }
    // Presence. In the demo about two thirds of people are online, rotating every 90s.
    onlineIds() { const slot = Math.floor(Date.now() / 90000); return new Set(this.people().filter((p) => hash(p.id + slot) % 3 !== 0).map((p) => p.id)); }
    isOnline(id) { return this.onlineIds().has(id); }

    async candidates() {
      const me = await this.getMe();
      if (!me) return [];
      const online = this.onlineIds();
      const showMe = me.showMe || ALL_GENDERS;
      return this.people()
        .filter((p) => S.canSee(me.age, p.age) && showMe.includes(p.gender) && !this.db.swipes[p.id] && !this.db.blocks.includes(p.id))
        .map((p) => Object.assign(p, { online: online.has(p.id) }))
        .sort((a, b) => Number(b.online) - Number(a.online));
    }
    async likesRemaining() {
      if (this.db.premium) return Infinity;
      const since = Date.now() - DAY;
      this.db.likesLog = this.db.likesLog.filter((t) => t > since);
      return Math.max(0, FREE_DAILY_LIKES - this.db.likesLog.length);
    }
    async swipe(id, dir) {
      const me = await this.getMe();
      const target = this.people().find((p) => p.id === id);
      if (!target || !S.canSee(me.age, target.age)) throw new Error("Not allowed");
      if (dir === "like") {
        if ((await this.likesRemaining()) <= 0) return { limited: true };
        this.db.likesLog.push(Date.now());
      }
      this.db.swipes[id] = { dir, at: Date.now() };
      this.lastSwipe = id;
      let matched = null;
      if (dir === "like" && target.likedYou) {
        matched = { id: "m_" + id, userId: id, at: Date.now() };
        this.db.matches.unshift(matched);
        this.db.messages[matched.id] = [{ id: "sys", from: "sys", text: "You caught each other. Keep it on Hooky, and hit report if anything feels off.", at: Date.now() }];
      }
      this.save();
      return { matched };
    }
    async undo() {
      if (!this.lastSwipe) return false;
      delete this.db.swipes[this.lastSwipe];
      this.db.matches = this.db.matches.filter((m) => m.userId !== this.lastSwipe);
      this.lastSwipe = null; this.save(); return true;
    }
    async whoLikedMe() {
      const me = await this.getMe();
      const showMe = me.showMe || ALL_GENDERS;
      return this.people().filter((p) => p.likedYou && S.canSee(me.age, p.age) && showMe.includes(p.gender) && !this.db.swipes[p.id] && !this.db.blocks.includes(p.id));
    }
    async matches() {
      const online = this.onlineIds();
      return this.db.matches
        .filter((m) => !this.db.blocks.includes(m.userId))
        .map((m) => {
          const msgs = this.db.messages[m.id] || [];
          const last = msgs.filter((x) => x.from !== "sys").slice(-1)[0] || null;
          const user = this.people().find((p) => p.id === m.userId);
          return Object.assign({}, m, { user, online: online.has(m.userId), last, unread: this.db.unread[m.id] || 0 });
        });
    }
    async messages(matchId) { this.db.unread[matchId] = 0; this.persist(); return this.db.messages[matchId] || []; }
    async addSystemMessage(matchId, text) { (this.db.messages[matchId] ||= []).push({ id: "s" + Date.now(), from: "sys", text, at: Date.now() }); this.save(); }
    async send(matchId, text) {
      const me = await this.getMe();
      const m = this.db.matches.find((x) => x.id === matchId);
      const other = this.people().find((p) => p.id === m.userId);
      const meMinor = S.isMinor(me.age), otherMinor = S.isMinor(other.age);
      const check = S.checkMessage(text, meMinor, otherMinor);
      if (check.blocked) return { blocked: true, reasons: check.reasons };
      const msg = { id: "x" + Date.now(), from: "me", text, at: Date.now() };
      (this.db.messages[matchId] ||= []).push(msg);
      this.save();
      // Fake reply so the demo feels alive. Sometimes the other person rings you afterwards.
      setTimeout(() => {
        if (this.db.blocks.includes(m.userId)) return;
        const reply = { id: "y" + Date.now(), from: m.userId, text: REPLIES[Math.floor(Math.random() * REPLIES.length)], at: Date.now() };
        (this.db.messages[matchId] ||= []).push(reply);
        this.db.unread[matchId] = (this.db.unread[matchId] || 0) + 1;
        this.save();
        if (!this.db.rang[matchId] && this.isOnline(m.userId) && Math.random() < 0.5) {
          this.db.rang[matchId] = true; this.persist();
          setTimeout(() => this.callListeners.forEach((fn) => fn({ type: "ring", matchId, from: m.userId, mode: Math.random() < 0.5 ? "voice" : "video" })), 2500);
        }
      }, 1200 + Math.random() * 2000);
      return { ok: true, msg, warn: check.warn ? check.reasons : null };
    }
    subscribe(matchId, fn) { return this.onChange(fn); }
    async report(userId, reason, details) { this.db.reports.push({ userId, reason, details, at: Date.now() }); this.db.swipes[userId] = { dir: "nope", at: Date.now() }; this.save(); }
    async block(userId) { if (!this.db.blocks.includes(userId)) this.db.blocks.push(userId); this.db.swipes[userId] = { dir: "nope", at: Date.now() }; this.save(); }
    async unblock(userId) { this.db.blocks = this.db.blocks.filter((x) => x !== userId); this.save(); }
    async blocked() { return this.db.blocks.map((id) => this.people().find((p) => p.id === id)).filter(Boolean); }
    async totalUnread() { return Object.values(this.db.unread).reduce((a, b) => a + b, 0); }

    // ----- push (demo) -----
    // No server here, so the demo fires a real local notification instead. It
    // exercises the permission flow and the notification itself, not delivery.
    async pushStatus() {
      if (!("Notification" in window)) return { supported: false };
      return { supported: true, permission: Notification.permission, subscribed: !!this.db.pushOn };
    }
    async enablePush() {
      if (!("Notification" in window)) throw new Error("This browser doesn't support notifications.");
      const perm = await Notification.requestPermission();
      if (perm !== "granted") throw new Error("Notifications are blocked. Turn them back on in your browser settings.");
      this.db.pushOn = true; this.save();
      return true;
    }
    async disablePush() { this.db.pushOn = false; this.save(); }
    async notify(kind, name) {
      if (!this.db.pushOn || !("Notification" in window) || Notification.permission !== "granted") return;
      const title = kind === "match" ? "It's a catch!" : name;
      const body = kind === "match" ? `You and ${name} hooked each other.` : "sent you a message";
      const opts = { body, icon: "assets/icon-192.png", tag: "hooky-demo", renotify: true };
      const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
      if (reg) await reg.showNotification(title, opts); else new Notification(title, opts);
    }

    // ----- private rooms (demo) -----
    async roomsAllowed() { return this.db.premium ? S.roomsAllowed(this.db.tier || "plus") : 0; }
    async browseRooms() {
      const me = await this.getMe();
      const band = S.ageBand(me.age);
      const seeded = [
        { id: "r_seed1", topic: "late night study group", owner_name: "Priya", mine: false, joined: false, members: 4, age_lo: band.lo, age_hi: band.hi },
        { id: "r_seed2", topic: "indie game devs", owner_name: "Sam", mine: false, joined: false, members: 7, age_lo: band.lo, age_hi: band.hi },
      ];
      return seeded.concat(this.db.rooms.map((r) => Object.assign({}, r, { members: (this.db.roomMsgs[r.id] || []).length ? 2 : 1 })));
    }
    async createRoom(topic) {
      const me = await this.getMe();
      if (!this.db.premium) throw new Error("Rooms need Hooky+");
      const allowed = S.roomsAllowed(this.db.tier || "plus");
      if (this.db.rooms.length >= allowed) throw new Error("You've used all your rooms");
      const check = S.checkMessage(topic, true, true);
      if (check.blocked) throw new Error("That topic isn't allowed here");
      const band = S.ageBand(me.age);
      const r = { id: "r" + Date.now(), topic: topic.trim(), owner_name: me.name, mine: true, joined: true, age_lo: band.lo, age_hi: band.hi };
      this.db.rooms.unshift(r); this.db.roomMsgs[r.id] = []; this.save();
      return r.id;
    }
    async closeRoom(id) { this.db.rooms = this.db.rooms.filter((r) => r.id !== id); delete this.db.roomMsgs[id]; this.save(); }
    async joinRoom(id) { const r = this.db.rooms.find((x) => x.id === id); if (r) r.joined = true; this.db.roomMsgs[id] = this.db.roomMsgs[id] || []; this.save(); }
    async leaveRoom(id) { const r = this.db.rooms.find((x) => x.id === id); if (r) r.joined = false; this.save(); }
    async roomMessages(id) { return this.db.roomMsgs[id] || []; }
    async roomSend(id, body) {
      const me = await this.getMe();
      const check = S.checkMessage(body, S.isMinor(me.age), true);
      if (check.blocked) return { blocked: true, reasons: check.reasons };
      (this.db.roomMsgs[id] = this.db.roomMsgs[id] || []).push({ id: "rm" + Date.now(), sender_name: me.name, mine: true, body, at: Date.now() });
      this.save();
      return { ok: true };
    }
    subscribeRoom(id, fn) { return this.onChange(fn); }

    // Live calls (demo): the other person answers after a moment, most of the time.
    async requestCall(matchId, mode) {
      const m = this.db.matches.find((x) => x.id === matchId);
      await new Promise((r) => setTimeout(r, 1800 + Math.random() * 1500));
      const accepted = hash(matchId + Math.floor(Date.now() / 30000)) % 4 !== 0;
      return { accepted, userId: m.userId };
    }
    subscribeCalls(fn) { this.callListeners.add(fn); return () => this.callListeners.delete(fn); }
    async answerCall() {}
    callChannel() { return { send() {}, on() {}, close() {} }; }
    async iceServers() { return FALLBACK_ICE; }

    // Live (demo): pairs you with a random demo person in your window after a
    // moment. There is no real video on the other end.
    async rouletteNext() {
      await new Promise((r) => setTimeout(r, 1200 + Math.random() * 1600));
      const me = await this.getMe(); const showMe = me.showMe || ALL_GENDERS;
      const pool = this.people().filter((p) => S.canSee(me.age, p.age) && showMe.includes(p.gender) && !this.db.blocks.includes(p.id));
      this.liveSeen = this.liveSeen || [];
      let fresh = pool.filter((p) => !this.liveSeen.includes(p.id));
      if (!fresh.length) { this.liveSeen = []; fresh = pool; }
      const pick = fresh[Math.floor(Math.random() * fresh.length)];
      if (!pick) return { status: "waiting" };
      this.liveSeen.push(pick.id);
      return { status: "matched", sessionId: "demo-" + Date.now(), partner: Object.assign(pick, { online: true }) };
    }
    async rouletteLeave() {}
    async rouletteStop() {}
    onRouletteMatch() { return () => {}; }
    rouletteChannel() { return { ready: Promise.resolve(), send() {}, on() {}, close() {} }; }
    demoReply() { return REPLIES[Math.floor(Math.random() * REPLIES.length)]; }
  }

  // ---------------- Supabase store ----------------
  // Expects the schema in supabase/schema.sql. Auth is email and password,
  // with the email confirmed before the first login.
  class SupabaseStore {
    constructor(cfg) { this.kind = "supabase"; this.cfg = cfg; this.listeners = new Set(); this.callListeners = new Set(); this.online = new Set(); }
    async init() {
      if (this.sb) return true; // idempotent: boot() runs again after sign-in
      this.sb = window.supabase.createClient(this.cfg.supabaseUrl, this.cfg.supabaseAnonKey);
      // A password reset link lands here with a recovery session; remember it
      // so the app asks for a new password instead of opening normally.
      this.sb.auth.onAuthStateChange((event, s) => {
        if (event === "PASSWORD_RECOVERY") this.recovery = true;
        this.session = s;
        if (s && !this.presence) this.joinPresence();
        if (!s && this.presence) { this.sb.removeChannel(this.presence); this.sb.removeChannel(this.inbox); this.presence = this.inbox = null; }
        this.emit();
      });
      const { data } = await this.sb.auth.getSession();
      this.session = data.session;
      if (this.uid && !this.presence) this.joinPresence();
      return true;
    }
    onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    emit() { this.listeners.forEach((fn) => fn()); }
    get uid() { return this.session && this.session.user.id; }

    // Presence: everyone with the app open is tracked on one channel, keyed by user id.
    joinPresence() {
      this.presence = this.sb.channel("online", { config: { presence: { key: this.uid } } });
      this.presence
        .on("presence", { event: "sync" }, () => { this.online = new Set(Object.keys(this.presence.presenceState())); this.emit(); })
        .subscribe(async (status) => { if (status === "SUBSCRIBED") await this.presence.track({ at: Date.now() }); });
      this.inbox = this.sb.channel("user:" + this.uid);
      this.inbox.on("broadcast", { event: "call" }, ({ payload }) => this.callListeners.forEach((fn) => fn(payload))).subscribe();
    }
    onlineIds() { return this.online; }
    isOnline(id) { return this.online.has(id); }

    // ----- accounts -----
    // Sign up carries the on-device age check result into the account's
    // metadata. That number is all that's kept from the check; the server
    // compares it to the birthday when the profile is created.
    get redirect() { return location.origin + location.pathname; }
    async signUp(email, password, ageCheck) {
      const { data, error } = await this.sb.auth.signUp({ email, password, options: { emailRedirectTo: this.redirect, data: { age_check: ageCheck } } });
      if (error) throw friendlyAuth(error);
      // With email confirmation on, an address that already has an account
      // comes back as a user with no identities instead of an error.
      if (data.user && Array.isArray(data.user.identities) && !data.user.identities.length) {
        const e = new Error("There's already an account with that email. Log in instead."); e.code = "exists"; throw e;
      }
      return { needsConfirm: !data.session };
    }
    async resendConfirm(email) {
      const { error } = await this.sb.auth.resend({ type: "signup", email, options: { emailRedirectTo: this.redirect } });
      if (error) throw friendlyAuth(error);
    }
    async signIn(email, password) {
      const { error } = await this.sb.auth.signInWithPassword({ email, password });
      if (error) throw friendlyAuth(error);
    }
    async resetPassword(email) {
      const { error } = await this.sb.auth.resetPasswordForEmail(email, { redirectTo: this.redirect });
      if (error) throw friendlyAuth(error);
    }
    async updatePassword(password) {
      const { error } = await this.sb.auth.updateUser({ password });
      if (error) throw friendlyAuth(error);
      this.recovery = false;
    }
    ageCheck() { return (this.session && this.session.user.user_metadata && this.session.user.user_metadata.age_check) || null; }
    // For accounts that exist but never did the check (made before it existed).
    async saveAgeCheck(ac) {
      const { data, error } = await this.sb.auth.updateUser({ data: { age_check: ac } });
      if (error) throw friendlyAuth(error);
      if (data && data.user && this.session) this.session = Object.assign({}, this.session, { user: data.user });
    }
    // Applies a fresh age check to a profile made before the check existed.
    async claimAgeCheck() {
      const { error } = await this.sb.rpc("claim_age_check");
      if (error) throw new Error(error.message);
    }
    async signOut() { await this.sb.auth.signOut(); }

    async getMe() {
      if (!this.uid) return null;
      const { data } = await this.sb.from("profiles").select("*").eq("id", this.uid).maybeSingle();
      if (!data) return null;
      const paths = (data.photos || []).slice();
      await this.signPaths(paths);
      const photos = paths.map((p) => ({ ref: p, url: this.url(p) })).filter((x) => x.url);
      return withBracket({ id: data.id, name: data.display_name, age: S.ageFromBirthdate(data.birthdate), birthdate: data.birthdate, emoji: data.emoji, region: data.region, bio: data.bio, tags: data.interests || [], photos, photo: photos.length ? photos[0].url : null, gender: data.gender, showMe: data.show_me || S.GENDERS.map((g) => g.id), premium: data.premium_until && new Date(data.premium_until) > new Date(), tier: data.premium_tier, photoStatus: data.photo_status, verification: data.verification && data.verification !== "none" ? data.verification : null, verificationProvider: data.verification_provider, email: this.session.user.email });
    }
    async saveMe(p) {
      // photo_url is deliberately absent: only photo-check may write it, so a
      // client cannot publish a photo that skipped moderation.
      const row = { id: this.uid, display_name: p.name, birthdate: p.birthdate, emoji: p.emoji, region: p.region, bio: p.bio, interests: p.tags };
      if (p.gender) row.gender = p.gender;
      if (p.showMe) row.show_me = p.showMe;
      const { error } = await this.sb.from("profiles").upsert(row);
      if (error) throw error;
      return this.getMe();
    }
    async setPremium() { throw new Error("Hooky+ is granted server-side after a store purchase webhook."); }
    // Photo files go first: once the account is gone nothing could remove them.
    async deleteAccount() {
      try { await this.photoOp({ remove: true }); } catch {}
      const { error } = await this.sb.rpc("delete_my_account"); if (error) throw error; await this.signOut();
    }

    // ----- photos -----
    // Photos live in a private storage bucket. The database hands out paths,
    // and the client swaps them for signed URLs that expire after an hour.
    // Storage only signs a path for someone allowed to see that person.
    async signPaths(paths) {
      this.signed = this.signed || new Map();
      const soon = Date.now() + 5 * 60000;
      const need = [...new Set(paths.filter((p) => p && !p.startsWith("data:") && !((this.signed.get(p) || {}).exp > soon)))];
      if (!need.length) return;
      const { data } = await this.sb.storage.from("photos").createSignedUrls(need, 3600);
      const exp = Date.now() + 3600000;
      (data || []).forEach((d) => { if (d.signedUrl && !d.error) this.signed.set(d.path, { url: d.signedUrl, exp }); });
    }
    url(p) { if (!p) return null; if (p.startsWith("data:")) return p; const s = this.signed && this.signed.get(p); return s ? s.url : null; }
    // Everything the moderation function returns comes back as fresh refs.
    async photoOp(body) {
      const { data, error } = await this.sb.functions.invoke("photo-check", { body });
      if (error) {
        let detail = "";
        try { const j = await error.context.json(); detail = j.error || (j.code === "WORKER_RESOURCE_LIMIT" ? "The photo checker is overloaded right now. Try again in a minute." : j.message) || ""; } catch {}
        throw new Error(detail || error.message);
      }
      if (data.photos) await this.signPaths(data.photos);
      if (data.ok === false) { const e = new Error(data.reason || "That photo wasn't accepted."); e.rejected = true; throw e; }
      return (data.photos || []).map((p) => ({ ref: p, url: this.url(p) }));
    }
    addPhoto(dataUrl) { return this.photoOp({ image: dataUrl }); }
    removePhoto(ref) { return this.photoOp({ remove: ref }); }
    setMainPhoto(ref) { return this.photoOp({ main: ref }); }
    // All photos for a set of people, as { id: [url, ...] }, for the deck.
    async photosFor(ids) {
      if (!ids.length) return {};
      const { data, error } = await this.sb.rpc("photos_of", { ids });
      if (error || !data) return {};
      await this.signPaths(data.flatMap((r) => r.photos || []));
      return Object.fromEntries(data.map((r) => [r.id, (r.photos || []).map((p) => this.url(p)).filter(Boolean)]));
    }
    async signRows(rows) { await this.signPaths((rows || []).map((r) => r.photo_url)); return rows || []; }

    map(r) { return withBracket({ id: r.id, name: r.display_name, age: r.age, emoji: r.emoji, region: r.region, bio: r.bio, tags: r.interests || [], photo: this.url(r.photo_url), gender: r.gender, online: this.online.has(r.id) }); }
    async candidates() { const { data, error } = await this.sb.rpc("discover_candidates", { lim: 20 }); if (error) throw error; return (await this.signRows(data)).map((r) => this.map(r)).sort((a, b) => Number(b.online) - Number(a.online)); }
    async likesRemaining() { const { data } = await this.sb.rpc("likes_remaining"); return data === -1 ? Infinity : data; }
    async swipe(id, dir) {
      const { data, error } = await this.sb.rpc("swipe", { target: id, direction: dir });
      if (error) { if (/limit/i.test(error.message)) return { limited: true }; throw error; }
      this.lastSwipe = id;
      return { matched: data ? { id: data, userId: id } : null };
    }
    async undo() { if (!this.lastSwipe) return false; const { error } = await this.sb.rpc("undo_swipe", { target: this.lastSwipe }); this.lastSwipe = null; return !error; }
    async whoLikedMe() { const { data, error } = await this.sb.rpc("who_liked_me"); if (error) throw error; return (await this.signRows(data)).map((r) => this.map(r)); }
    async matches() {
      const { data, error } = await this.sb.rpc("my_matches"); if (error) throw error;
      return (await this.signRows(data)).map((r) => ({ id: r.match_id, userId: r.other_id, at: r.created_at, user: this.map(Object.assign({}, r, { id: r.other_id })), online: this.online.has(r.other_id), last: r.last_text ? { text: r.last_text, at: new Date(r.last_at).getTime(), from: r.last_from } : null, unread: r.unread }));
    }
    async messages(matchId) {
      await this.sb.rpc("mark_read", { mid: matchId });
      const { data } = await this.sb.from("messages").select("*").eq("match_id", matchId).order("created_at");
      return (data || []).map((m) => ({ id: m.id, from: m.sender_id === this.uid ? "me" : m.sender_id, text: m.body, at: new Date(m.created_at).getTime() }));
    }
    async addSystemMessage() {}
    async send(matchId, text) {
      const { data, error } = await this.sb.rpc("send_message", { mid: matchId, body: text });
      if (error) { if (/blocked/i.test(error.message)) return { blocked: true, reasons: [error.message.replace(/^.*blocked:?\s*/i, "")] }; throw error; }
      return { ok: true, msg: { id: data, from: "me", text, at: Date.now() } };
    }
    subscribe(matchId, fn) {
      const ch = this.sb.channel("m:" + matchId).on("postgres_changes", { event: "INSERT", schema: "public", table: "messages", filter: "match_id=eq." + matchId }, fn).subscribe();
      return () => this.sb.removeChannel(ch);
    }
    // opts.auto marks a report filed by the Live safety check rather than a
    // person. Those wait for a human (status 'auto') instead of counting toward
    // the three-report auto-hide, so a model mistake can't hide someone.
    async report(userId, reason, details, opts = {}) {
      const row = { reported_id: userId, reason, details };
      if (opts.auto) row.status = "auto";
      await this.sb.from("reports").insert(row);
      await this.sb.rpc("swipe", { target: userId, direction: "nope" });
    }
    async block(userId) { await this.sb.from("blocks").insert({ blocked_id: userId }); }
    async unblock(userId) { await this.sb.from("blocks").delete().eq("blocker_id", this.uid).eq("blocked_id", userId); }
    async blocked() { const { data } = await this.sb.rpc("my_blocked"); return (await this.signRows(data)).map((r) => this.map(r)); }
    async totalUnread() { const { data } = await this.sb.rpc("total_unread"); return data || 0; }

    // ----- push -----
    async pushStatus() {
      if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
        return { supported: false };
      }
      const reg = await navigator.serviceWorker.ready.catch(() => null);
      const sub = reg && await reg.pushManager.getSubscription();
      return { supported: true, permission: Notification.permission, subscribed: !!sub };
    }
    async enablePush() {
      const cfg = this.cfg;
      if (!cfg.vapidPublicKey) throw new Error("Push isn't configured for this build.");
      if (!("Notification" in window) || !("PushManager" in window)) {
        throw new Error("This browser doesn't support push notifications.");
      }
      const perm = await Notification.requestPermission();
      if (perm !== "granted") throw new Error("Notifications are blocked. Turn them back on in your browser settings.");

      const reg = await navigator.serviceWorker.ready;
      // The VAPID key has to be raw bytes, not the base64url string.
      const raw = cfg.vapidPublicKey.replace(/-/g, "+").replace(/_/g, "/");
      const padded = raw + "=".repeat((4 - (raw.length % 4)) % 4);
      const bin = atob(padded);
      const key = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) key[i] = bin.charCodeAt(i);

      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      const j = sub.toJSON();
      const { error } = await this.sb.from("push_subscriptions").upsert({
        endpoint: sub.endpoint, user_id: this.uid, p256dh: j.keys.p256dh, auth: j.keys.auth,
      }, { onConflict: "endpoint" });
      if (error) throw error;
      return true;
    }
    async disablePush() {
      const reg = await navigator.serviceWorker.ready.catch(() => null);
      const sub = reg && await reg.pushManager.getSubscription();
      if (sub) {
        await this.sb.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
        await sub.unsubscribe();
      }
    }
    // Fire and forget: a failed notification must never break sending a message.
    async notify(kind, matchId) {
      try { await this.sb.functions.invoke("push-send", { body: { match_id: matchId, kind } }); } catch {}
    }


    // ----- private rooms -----
    async roomsAllowed() { const { data } = await this.sb.rpc("rooms_allowed"); return data || 0; }
    async browseRooms() {
      const { data, error } = await this.sb.rpc("browse_rooms", { lim: 30 });
      if (error) throw error;
      return (data || []).map((r) => ({ id: r.id, topic: r.topic, owner_name: r.owner_name, members: r.members, joined: r.joined, mine: r.mine, age_lo: r.age_lo, age_hi: r.age_hi }));
    }
    async createRoom(topic) {
      const { data, error } = await this.sb.rpc("create_room", { topic });
      if (error) throw new Error(error.message.replace(/^.*?:\s*/, ""));
      return data;
    }
    async closeRoom(id) { const { error } = await this.sb.rpc("close_room", { rid: id }); if (error) throw error; }
    async joinRoom(id) { const { error } = await this.sb.rpc("join_room", { rid: id }); if (error) throw new Error(error.message.replace(/^.*?:\s*/, "")); }
    async leaveRoom(id) { const { error } = await this.sb.rpc("leave_room", { rid: id }); if (error) throw error; }
    async roomMessages(id) {
      const { data, error } = await this.sb.rpc("room_messages_list", { rid: id, lim: 100 });
      if (error) throw error;
      return (data || []).map((m) => ({ id: m.id, sender_name: m.sender_name, mine: m.sender_id === this.uid, body: m.body, at: new Date(m.created_at).getTime() }));
    }
    async roomSend(id, body) {
      const { error } = await this.sb.rpc("room_send", { rid: id, body });
      if (error) {
        if (/blocked/i.test(error.message)) return { blocked: true, reasons: [error.message.replace(/^.*blocked:?\s*/i, "")] };
        throw error;
      }
      return { ok: true };
    }
    subscribeRoom(id, fn) {
      const ch = this.sb.channel("room:" + id).on("postgres_changes", { event: "INSERT", schema: "public", table: "room_messages", filter: "room_id=eq." + id }, fn).subscribe();
      return () => this.sb.removeChannel(ch);
    }

    // Live calls: ring the other person on their inbox channel, then signal WebRTC on a per-match channel.
    async sendTo(uid, payload) {
      const ch = this.sb.channel("user:" + uid);
      await new Promise((r) => ch.subscribe((s) => s === "SUBSCRIBED" && r()));
      await ch.send({ type: "broadcast", event: "call", payload });
      this.sb.removeChannel(ch);
    }
    async requestCall(matchId, mode) {
      const m = (await this.matches()).find((x) => x.id === matchId);
      if (!m) throw new Error("not your match");
      return new Promise((resolve) => {
        const off = this.subscribeCalls((p) => {
          if (p.matchId === matchId && (p.type === "accept" || p.type === "decline")) { off(); clearTimeout(t); resolve({ accepted: p.type === "accept", userId: m.userId }); }
        });
        const t = setTimeout(() => { off(); resolve({ accepted: false, timeout: true, userId: m.userId }); }, 30000);
        this.sendTo(m.userId, { type: "ring", matchId, from: this.uid, mode: mode || "video" });
      });
    }
    subscribeCalls(fn) { this.callListeners.add(fn); return () => this.callListeners.delete(fn); }
    async answerCall(matchId, toUid, accepted) { await this.sendTo(toUid, { type: accepted ? "accept" : "decline", matchId, from: this.uid }); }
    // STUN and TURN servers for WebRTC, from the turn-credentials function.
    // They expire, so they're cached and fetched again well before that.
    async iceServers() {
      const now = Date.now();
      if (this.ice && this.ice.until > now) return this.ice.servers;
      try {
        const { data, error } = await this.sb.functions.invoke("turn-credentials", { body: {} });
        if (error || !data || !Array.isArray(data.iceServers)) throw error || new Error("no ice servers");
        this.ice = { servers: data.iceServers, until: now + Math.max(60, (data.ttl || 300) - 600) * 1000, relay: !!data.relay };
      } catch {
        this.ice = { servers: FALLBACK_ICE, until: now + 60000, relay: false };
      }
      return this.ice.servers;
    }
    callChannel(matchId) { return this.signalChannel("call:" + matchId); }
    // A realtime broadcast channel for WebRTC signalling between two people.
    signalChannel(topic) {
      const ch = this.sb.channel(topic); const handlers = [];
      ch.on("broadcast", { event: "sig" }, ({ payload }) => { if (payload.from !== this.uid) handlers.forEach((fn) => fn(payload)); });
      const ready = new Promise((r) => ch.subscribe((s) => s === "SUBSCRIBED" && r()));
      return {
        ready,
        on: (fn) => handlers.push(fn),
        send: async (type, data) => { await ready; ch.send({ type: "broadcast", event: "sig", payload: { type, data, from: this.uid } }); },
        close: () => this.sb.removeChannel(ch),
      };
    }

    // ----- Live (random video chat) -----
    // Pairing happens in the database (roulette_next), with the same rules as
    // the deck. Video is peer to peer; the session id is the signalling topic.
    async rouletteNext() {
      const { data, error } = await this.sb.rpc("roulette_next");
      if (error) throw new Error(/finish your profile/i.test(error.message) ? "Add a photo and finish your profile to go live." : error.message);
      const r = (data || [])[0];
      if (!r || r.status !== "matched") return { status: "waiting" };
      const partner = await this.roulettePartner(r.session_id);
      return partner ? { status: "matched", sessionId: r.session_id, partner } : { status: "waiting" };
    }
    async roulettePartner(sid) {
      const { data } = await this.sb.rpc("roulette_partner", { sid });
      const rows = await this.signRows(data);
      return rows[0] ? this.map(rows[0]) : null;
    }
    async rouletteLeave(sid, reason) { try { await this.sb.rpc("roulette_leave", { sid, reason }); } catch {} }
    async rouletteStop() { try { await this.sb.rpc("roulette_stop"); } catch {} }
    // Tells the person who was waiting that someone just paired with them.
    onRouletteMatch(fn) {
      const ch = this.sb.channel("rq:" + this.uid)
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "roulette_sessions", filter: "a=eq." + this.uid }, (p) => p.new && fn(p.new.id))
        .subscribe();
      return () => this.sb.removeChannel(ch);
    }
    rouletteChannel(sid) { return this.signalChannel("rr:" + sid); }
  }

  window.HookyStore = { LocalStore, SupabaseStore, FREE_DAILY_LIKES, gradientFor };
})();

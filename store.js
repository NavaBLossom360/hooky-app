// Data layer. Two implementations with the same interface:
//   LocalStore    - demo mode, everything in localStorage with seeded fake users
//   SupabaseStore - real backend, used when config.js defines window.HOOKY_CONFIG
(function () {
  const S = window.HookySafety;
  const FREE_DAILY_LIKES = 25;
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
    P("d13", "Riley", 19, "☕", "New York", "college freshman, running on iced coffee", ["Coffee", "Music", "Hiking"], true),
    P("d14", "Diego", 20, "🎶", "Texas", "producing beats in my dorm", ["Music", "Coding", "Basketball"], false),
    P("d15", "Nina", 23, "🌿", "California", "plant mom, marathon training, terrible at cooking", ["Running", "Plants", "Movies"], true),
    P("d16", "Marcus", 25, "🏋️", "Illinois", "gym, board games, and a very needy cat", ["Fitness", "Board games", "Cats"], false),
  ];
  const REPLIES = [
    "heyy! wait your profile is so cool", "omg finally someone who likes that too",
    "haha what are you up to rn", "what are you into outside of this app", "ok that's actually fire", "same honestly", "lmaooo", "wait tell me more", "bet. what else are you into?",
    "wanna go live for a sec?",
  ];

  function withBracket(u) {
    const b = S.bracketForAge(u.age);
    return Object.assign({}, u, { bracket: b ? b.id : null, gradient: gradientFor(u.id) });
  }

  // ---------------- Local demo store ----------------
  class LocalStore {
    constructor() { this.kind = "local"; this.key = "hooky.v1"; this.load(); this.listeners = new Set(); this.callListeners = new Set(); }
    load() {
      try { this.db = JSON.parse(localStorage.getItem(this.key)) || null; } catch { this.db = null; }
      if (!this.db) this.db = { me: null, swipes: {}, matches: [], messages: {}, reports: [], blocks: [], likesLog: [], premium: false, unread: {}, rang: {} };
      this.db.rang ||= {};
    }
    persist() { try { localStorage.setItem(this.key, JSON.stringify(this.db)); } catch {} }
    save() { this.persist(); this.emit(); }
    onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    emit() { this.listeners.forEach((fn) => fn()); }
    async init() { return true; }
    async reset() { localStorage.removeItem(this.key); this.load(); this.emit(); }

    async getMe() { return this.db.me ? withBracket(Object.assign({ premium: this.db.premium }, this.db.me)) : null; }
    async saveMe(profile) {
      profile.age = S.ageFromBirthdate(profile.birthdate);
      this.db.me = Object.assign({}, this.db.me || { id: "me" }, profile);
      this.save();
      return this.getMe();
    }
    async setPremium(on) { this.db.premium = !!on; this.save(); }
    async signOut() { await this.reset(); }
    async deleteAccount() { await this.reset(); }

    people() { return DEMO.map(withBracket); }
    // Presence. In the demo about two thirds of people are online, rotating every 90s.
    onlineIds() { const slot = Math.floor(Date.now() / 90000); return new Set(this.people().filter((p) => hash(p.id + slot) % 3 !== 0).map((p) => p.id)); }
    isOnline(id) { return this.onlineIds().has(id); }

    async candidates() {
      const me = await this.getMe();
      if (!me) return [];
      const online = this.onlineIds();
      return this.people()
        .filter((p) => S.canSee(me.bracket, p.bracket) && !this.db.swipes[p.id] && !this.db.blocks.includes(p.id))
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
      if (!target || !S.canSee(me.bracket, target.bracket)) throw new Error("Not allowed");
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
      return this.people().filter((p) => p.likedYou && S.canSee(me.bracket, p.bracket) && !this.db.swipes[p.id] && !this.db.blocks.includes(p.id));
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
      const meMinor = S.bracketForAge(me.age).minor, otherMinor = S.bracketForAge(other.age).minor;
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
          setTimeout(() => this.callListeners.forEach((fn) => fn({ type: "ring", matchId, from: m.userId })), 2500);
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

    // Live calls (demo): the other person answers after a moment, most of the time.
    async requestCall(matchId) {
      const m = this.db.matches.find((x) => x.id === matchId);
      await new Promise((r) => setTimeout(r, 1800 + Math.random() * 1500));
      const accepted = hash(matchId + Math.floor(Date.now() / 30000)) % 4 !== 0;
      return { accepted, userId: m.userId };
    }
    subscribeCalls(fn) { this.callListeners.add(fn); return () => this.callListeners.delete(fn); }
    async answerCall() {}
    callChannel() { return { send() {}, on() {}, close() {} }; }
  }

  // ---------------- Supabase store ----------------
  // Expects the schema in supabase/schema.sql. Auth is email one-time-code.
  class SupabaseStore {
    constructor(cfg) { this.kind = "supabase"; this.cfg = cfg; this.listeners = new Set(); this.callListeners = new Set(); this.online = new Set(); }
    async init() {
      this.sb = window.supabase.createClient(this.cfg.supabaseUrl, this.cfg.supabaseAnonKey);
      const { data } = await this.sb.auth.getSession();
      this.session = data.session;
      if (this.uid) this.joinPresence();
      this.sb.auth.onAuthStateChange((_e, s) => { this.session = s; if (s && !this.presence) this.joinPresence(); this.emit(); });
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

    async sendCode(email) { const { error } = await this.sb.auth.signInWithOtp({ email }); if (error) throw error; }
    async verifyCode(email, token) { const { error } = await this.sb.auth.verifyOtp({ email, token, type: "email" }); if (error) throw error; }
    async signOut() { await this.sb.auth.signOut(); }

    async getMe() {
      if (!this.uid) return null;
      const { data } = await this.sb.from("profiles").select("*").eq("id", this.uid).maybeSingle();
      if (!data) return null;
      return withBracket({ id: data.id, name: data.display_name, age: S.ageFromBirthdate(data.birthdate), birthdate: data.birthdate, emoji: data.emoji, region: data.region, bio: data.bio, tags: data.interests || [], photo: data.photo_url, premium: data.premium_until && new Date(data.premium_until) > new Date(), verification: data.verification && data.verification !== "none" ? data.verification : null });
    }
    async saveMe(p) {
      const row = { id: this.uid, display_name: p.name, birthdate: p.birthdate, emoji: p.emoji, region: p.region, bio: p.bio, interests: p.tags, photo_url: p.photo || null };
      const { error } = await this.sb.from("profiles").upsert(row);
      if (error) throw error;
      // The server decides verification; the client can only say the check ran.
      // Replace complete_age_check with a real vendor callback before launch.
      if (p.verification) await this.sb.rpc("complete_age_check");
      return this.getMe();
    }
    async setPremium() { throw new Error("Hooky+ is granted server-side after a store purchase webhook."); }
    async deleteAccount() { const { error } = await this.sb.rpc("delete_my_account"); if (error) throw error; await this.signOut(); }

    map(r) { return withBracket({ id: r.id, name: r.display_name, age: r.age, emoji: r.emoji, region: r.region, bio: r.bio, tags: r.interests || [], photo: r.photo_url, online: this.online.has(r.id) }); }
    async candidates() { const { data, error } = await this.sb.rpc("discover_candidates", { lim: 20 }); if (error) throw error; return data.map((r) => this.map(r)).sort((a, b) => Number(b.online) - Number(a.online)); }
    async likesRemaining() { const { data } = await this.sb.rpc("likes_remaining"); return data === -1 ? Infinity : data; }
    async swipe(id, dir) {
      const { data, error } = await this.sb.rpc("swipe", { target: id, direction: dir });
      if (error) { if (/limit/i.test(error.message)) return { limited: true }; throw error; }
      this.lastSwipe = id;
      return { matched: data ? { id: data, userId: id } : null };
    }
    async undo() { if (!this.lastSwipe) return false; const { error } = await this.sb.rpc("undo_swipe", { target: this.lastSwipe }); this.lastSwipe = null; return !error; }
    async whoLikedMe() { const { data, error } = await this.sb.rpc("who_liked_me"); if (error) throw error; return data.map((r) => this.map(r)); }
    async matches() {
      const { data, error } = await this.sb.rpc("my_matches"); if (error) throw error;
      return data.map((r) => ({ id: r.match_id, userId: r.other_id, at: r.created_at, user: this.map(Object.assign({}, r, { id: r.other_id })), online: this.online.has(r.other_id), last: r.last_text ? { text: r.last_text, at: new Date(r.last_at).getTime(), from: r.last_from } : null, unread: r.unread }));
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
    async report(userId, reason, details) { await this.sb.from("reports").insert({ reported_id: userId, reason, details }); await this.sb.rpc("swipe", { target: userId, direction: "nope" }); }
    async block(userId) { await this.sb.from("blocks").insert({ blocked_id: userId }); }
    async unblock(userId) { await this.sb.from("blocks").delete().eq("blocker_id", this.uid).eq("blocked_id", userId); }
    async blocked() { const { data } = await this.sb.rpc("my_blocked"); return (data || []).map((r) => this.map(r)); }
    async totalUnread() { const { data } = await this.sb.rpc("total_unread"); return data || 0; }

    // Live calls: ring the other person on their inbox channel, then signal WebRTC on a per-match channel.
    async sendTo(uid, payload) {
      const ch = this.sb.channel("user:" + uid);
      await new Promise((r) => ch.subscribe((s) => s === "SUBSCRIBED" && r()));
      await ch.send({ type: "broadcast", event: "call", payload });
      this.sb.removeChannel(ch);
    }
    async requestCall(matchId) {
      const m = (await this.matches()).find((x) => x.id === matchId);
      if (!m) throw new Error("not your match");
      return new Promise((resolve) => {
        const off = this.subscribeCalls((p) => {
          if (p.matchId === matchId && (p.type === "accept" || p.type === "decline")) { off(); clearTimeout(t); resolve({ accepted: p.type === "accept", userId: m.userId }); }
        });
        const t = setTimeout(() => { off(); resolve({ accepted: false, timeout: true, userId: m.userId }); }, 30000);
        this.sendTo(m.userId, { type: "ring", matchId, from: this.uid });
      });
    }
    subscribeCalls(fn) { this.callListeners.add(fn); return () => this.callListeners.delete(fn); }
    async answerCall(matchId, toUid, accepted) { await this.sendTo(toUid, { type: accepted ? "accept" : "decline", matchId, from: this.uid }); }
    callChannel(matchId) {
      const ch = this.sb.channel("call:" + matchId); const handlers = [];
      ch.on("broadcast", { event: "sig" }, ({ payload }) => { if (payload.from !== this.uid) handlers.forEach((fn) => fn(payload)); });
      const ready = new Promise((r) => ch.subscribe((s) => s === "SUBSCRIBED" && r()));
      return {
        on: (fn) => handlers.push(fn),
        send: async (type, data) => { await ready; ch.send({ type: "broadcast", event: "sig", payload: { type, data, from: this.uid } }); },
        close: () => this.sb.removeChannel(ch),
      };
    }
  }

  window.HookyStore = { LocalStore, SupabaseStore, FREE_DAILY_LIKES, gradientFor };
})();

// Live chat for each game, over Supabase Realtime broadcast.
// No database: messages go straight from browser to browser through one channel per game.
// A newcomer asks the room for recent messages and one person already there answers,
// so the room isn't empty on arrival. Only the publishable (browser) key is used here.

const SUPABASE_URL = "https://ddgcesjnfmkuptprukmj.supabase.co";
const SUPABASE_KEY = "sb_publishable_b_EiU_XpNl08O0SXMfMY_Q_jVFO6TQ-";
const LIB = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";

const MAX_LEN = 200;
const KEEP = 60;          // messages kept per room
const SEND_GAP_MS = 1200; // one message per 1.2 s per person
const NAME_MAX = 16;

const ADJ = ["Lucky", "Quick", "Bold", "Sharp", "Steady", "Clutch", "Hot", "Cool", "Late", "Early", "Swift", "Calm"];
const NOUN = ["Fox", "Hawk", "Bull", "Bear", "Wolf", "Owl", "Lynx", "Otter", "Shark", "Tiger", "Comet", "Rook"];

const clean = (s, n) => String(s ?? "").replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);

export function createChat({ store, onMessage, onPeople, onStatus }) {
  let name = clean(store.get("tapline.name"), NAME_MAX);
  if (!name) {
    name = ADJ[Math.floor(Math.random() * ADJ.length)] + NOUN[Math.floor(Math.random() * NOUN.length)] + Math.floor(10 + Math.random() * 90);
    store.set("tapline.name", name);
  }
  const me = crypto.randomUUID().slice(0, 12);
  let client = null, channel = null, room = null, lastSent = 0, answerTimer = null;
  const log = [];
  const seen = new Set();

  const status = (s) => onStatus?.(s);

  function add(m, fromHistory = false) {
    if (!m || typeof m !== "object" || seen.has(m.id)) return;
    const msg = {
      id: clean(m.id, 40), from: clean(m.from, 20), name: clean(m.name, NAME_MAX) || "Someone",
      text: clean(m.text, MAX_LEN), kind: m.kind === "hit" ? "hit" : "chat",
      t: Number.isFinite(m.t) ? Math.min(m.t, Date.now()) : Date.now(),
    };
    if (!msg.id || !msg.text) return;
    seen.add(msg.id);
    log.push(msg);
    log.sort((a, b) => a.t - b.t);
    if (log.length > KEEP) log.splice(0, log.length - KEEP);
    onMessage?.(msg, { mine: msg.from === me, fromHistory });
  }

  async function lib() {
    const { createClient } = await import(LIB);
    client ??= createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
    return client;
  }

  async function join(roomId) {
    if (room === roomId) return;
    await leave();
    room = roomId;
    log.length = 0; seen.clear();
    onMessage?.(null, { reset: true });
    status("connecting");
    let sb;
    try { sb = await lib(); } catch { status("offline"); return; }
    if (room !== roomId) return;
    const ch = sb.channel("tapline:" + roomId, { config: { broadcast: { self: false }, presence: { key: me } } });
    channel = ch;
    ch.on("broadcast", { event: "msg" }, ({ payload }) => add(payload));
    // Someone new asked for recent messages: wait a moment, and answer unless another person did first.
    ch.on("broadcast", { event: "history?" }, () => {
      if (!log.length) return;
      clearTimeout(answerTimer);
      answerTimer = setTimeout(() => {
        answerTimer = null;
        ch.send({ type: "broadcast", event: "history", payload: { msgs: log.slice(-30) } });
      }, 150 + Math.random() * 600);
    });
    ch.on("broadcast", { event: "history" }, ({ payload }) => {
      clearTimeout(answerTimer); answerTimer = null;
      const msgs = Array.isArray(payload?.msgs) ? payload.msgs.slice(-30) : [];
      for (const m of msgs) add(m, true);
    });
    ch.on("presence", { event: "sync" }, () => {
      const people = Object.values(ch.presenceState()).map((v) => clean(v[0]?.name, NAME_MAX)).filter(Boolean);
      onPeople?.(people);
    });
    ch.subscribe(async (s) => {
      if (channel !== ch) return;
      if (s === "SUBSCRIBED") {
        status("live");
        await ch.track({ name });
        ch.send({ type: "broadcast", event: "history?", payload: {} });
      } else if (s === "CHANNEL_ERROR" || s === "TIMED_OUT") status("offline");
      else if (s === "CLOSED") status("closed");
    });
  }

  async function leave() {
    clearTimeout(answerTimer); answerTimer = null;
    const ch = channel; channel = null; room = null;
    if (ch && client) { try { await client.removeChannel(ch); } catch {} }
    onPeople?.([]);
  }

  /** Returns an error string, or "" when sent. */
  function send(text, kind = "chat") {
    text = clean(text, MAX_LEN);
    if (!text) return "";
    if (!channel) return "Chat isn't connected yet.";
    const t = Date.now();
    if (kind === "chat" && t - lastSent < SEND_GAP_MS) return "Slow down a little.";
    if (kind === "chat") lastSent = t;
    const msg = { id: me + "-" + t.toString(36) + Math.random().toString(36).slice(2, 6), from: me, name, text, kind, t };
    add(msg);
    channel.send({ type: "broadcast", event: "msg", payload: msg });
    return "";
  }

  function setName(n) {
    n = clean(n, NAME_MAX).replace(/[^\p{L}\p{N} _.-]/gu, "");
    if (!n) return name;
    name = n; store.set("tapline.name", n);
    channel?.track({ name });
    return name;
  }

  return { join, leave, send, setName, get name() { return name; }, get room() { return room; }, messages: () => log.slice() };
}

// TapLine client: a live odds line on a grid of tappable squares.
// A square is a 1-cent price range and a deadline (its column's right edge).
// Tap above the line to back the odds rising into that square; below, falling.
//
// Hit rule (matches the server): a square above the line is hit when the YES bid
// (bottom of the band) reaches it; a square below when the YES ask (top of the
// band) falls to it. The band is drawn so what you see is what counts.

const $ = (id) => document.getElementById(id);
const money2 = (n) => Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtMoney = (n) => (n < 0 ? "-" : "") + "$" + money2(n);
const fmtSigned = (n) => (n >= 0 ? "+" : "-") + "$" + money2(n);
const cents = (p) => Math.round(p * 100) + "¢";
/** Whole dollars when that is exact or the amount is large, cents otherwise. */
const fmtAmt = (n) => "$" + (Math.abs(n - Math.round(n)) < 0.005 || n >= 100 ? Math.round(n).toLocaleString() : n.toFixed(2));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rand = (a, b) => a + Math.random() * (b - a);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

let sid = store.get("tapline.sid");
if (!sid) { sid = crypto.randomUUID().replaceAll("-", ""); store.set("tapline.sid", sid); }

const WINS = [1, 5, 10, 25];
const COLS = [5, 10, 30, 60];
const COL_LABEL = { 5: "5s", 10: "10s", 30: "30s", 60: "1m" };
const MAX_SPREAD = 0.1;
const FONT = '"Barlow Semi Condensed", ui-sans-serif, system-ui, sans-serif';
// Gemini's palette: near-black, the orange of their developer platform mark, their green and red.
const ACCENT = "249,94,1", GREEN = "74,222,128", RED = "252,72,72";
// Line colour when a team has no usable colour: near-white, so it never blends into the orange tiles.
const LINE_FALLBACK = "255,244,234";
const C = {
  grid: "rgba(255,255,255,0.075)", dot: [255, 214, 190],
  mult: [255, 176, 128], label: "rgba(154,163,166,0.95)",
  band: `rgba(${ACCENT},`, win: "#4ade80", loss: "#fc4848",
};
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

let CELL_W = 108, CELL_H = 96, NOW_AT = 0.3;

const state = {
  games: [], game: null, market: null, contract: null,
  ticks: [], quote: null, shownMid: null, lastMid: null,
  positions: [], balance: 0, balanceShown: 0, limits: null,
  win: clamp(Number(store.get("tapline.win")) || 5, 0.5, 500), colSec: 10,
  mode: store.get("tapline.mode") === "size" ? "size" : "win",
  maxCost: clamp(Number(store.get("tapline.max")) || 250, 10, 2500),
  sessionPnl: 0, joinedAt: 0,
  view: "lobby", pick: null, gamesError: null, gamesLoaded: false,
  clockSkew: 0, center: null,
  thin: false, lite: false, slow: 0, lastFrame: 0, spreadHold: 0, spreadAt: 0, tickTimes: [], lastFlare: 0, lastBlip: 0,
  hover: null, press: null, zoom: clamp(Number(store.get("tapline.zoom")) || 1, 0.25, 1.5), pinch: null, ghosts: new Map(), stars: [], sizes: null,
  fx: [], over: [], marks: [], trail: [], ripples: [],
  shake: 0, flash: 0, flashColor: GREEN, headKick: 0,
  streak: 0, lastTick: 0, lastBeat: 0,
  source: null, sound: store.get("tapline.sound") !== "off",
};
const now = () => Date.now() + state.clockSkew;
const drawable = (q) => q && q.bid != null && q.ask != null && q.bid > 0 && q.ask < 1 && q.bid < q.ask && q.ask - q.bid <= MAX_SPREAD;

// ---------- sound: synthesized cues, no audio files ----------
let audio = null, noiseBuf = null;
function ac() {
  if (!state.sound || state.view !== "game") return null; // no trading sounds from behind the lobby
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === "suspended") audio.resume();
    if (!noiseBuf) {
      noiseBuf = audio.createBuffer(1, audio.sampleRate * 0.5, audio.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    return audio;
  } catch { return null; }
}
function tone(freq, to, dur, type = "sine", gain = 0.08, delay = 0) {
  const a = ac(); if (!a) return;
  const t0 = a.currentTime + delay;
  const o = a.createOscillator(), g = a.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t0);
  if (to) o.frequency.exponentialRampToValueAtTime(to, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(a.destination); o.start(t0); o.stop(t0 + dur + 0.03);
}
function noise(dur, gain, freq, delay = 0, type = "bandpass") {
  const a = ac(); if (!a) return;
  const t0 = a.currentTime + delay;
  const src = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain();
  src.buffer = noiseBuf; f.type = type; f.frequency.value = freq;
  g.gain.setValueAtTime(gain, t0); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(f).connect(g).connect(a.destination); src.start(t0); src.stop(t0 + dur + 0.02);
}
const NOTES = [523.25, 659.25, 783.99, 1046.5, 1318.5, 1568];
const sfx = {
  tap(mult = 1.05) {
    const f = clamp(420 + (mult - 1) * 2600, 420, 1400);
    tone(f, f * 1.7, 0.08, "triangle", 0.08); noise(0.04, 0.05, 3500);
  },
  priceUp: () => tone(880, 1180, 0.07, "sine", 0.03),
  priceDown: () => tone(620, 470, 0.07, "sine", 0.03),
  tick: () => { tone(1500, 0, 0.03, "square", 0.018); },
  beat: () => { tone(68, 50, 0.12, "sine", 0.16); tone(62, 46, 0.14, "sine", 0.12, 0.14); },
  win(streak = 1, big = false) {
    const lift = Math.pow(2, Math.min(streak - 1, 6) / 12);
    NOTES.slice(0, big ? 6 : 4).forEach((n, i) => tone(n * lift, 0, 0.22, "triangle", 0.07, i * 0.06));
    tone(2093 * lift, 0, 0.5, "sine", 0.03, 0.26);
    noise(0.35, 0.05, 6000, 0.05, "highpass");
    if (big) tone(200, 1600, 0.45, "sawtooth", 0.025);
  },
  coin: (i = 0) => tone(1760 + i * 90, 2640 + i * 90, 0.05, "square", 0.022),
  miss: () => { tone(160, 70, 0.25, "sine", 0.12); noise(0.18, 0.05, 400, 0, "lowpass"); },
  deny: () => tone(190, 150, 0.09, "square", 0.025),
};
const buzz = (p) => { try { navigator.vibrate?.(p); } catch {} };

// ---------- backend ----------
// Two ways to run: against the TapLine server (src/server), or with no server at all, where the
// browser talks to Gemini directly and runs the paper engine itself (local.js). The second is what
// a static host serves. Both expose the same five calls.
async function api(path, body) {
  const res = await fetch(path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sid, ...body }) } : undefined);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "request failed");
  return data;
}

const serverBackend = {
  mode: "server",
  games: () => api("/api/games"),
  account: () => api(`/api/account?sid=${sid}`),
  tap: (req) => api("/api/tap", req),
  close: (id) => api("/api/close", { id }),
  stream(symbol, gameId, on) {
    const es = new EventSource(`/api/stream?sid=${sid}&symbol=${encodeURIComponent(symbol)}&game=${encodeURIComponent(gameId ?? "")}`);
    for (const name of ["history", "quote", "move", "position", "ping"]) {
      es.addEventListener(name, (e) => on[name]?.(JSON.parse(e.data)));
    }
    return { close: () => es.close() };
  },
};

let backend = serverBackend;
async function pickBackend() {
  try {
    const res = await fetch("/api/account?sid=" + sid);
    if (res.ok && (res.headers.get("content-type") ?? "").includes("json")) return;
  } catch {}
  backend = (await import("./local.js")).createLocalBackend();
}

function toast(text, kind = "") {
  const el = document.createElement("div");
  el.className = "toast " + kind;
  el.textContent = text;
  $("toasts").prepend(el);
  while ($("toasts").children.length > 2) $("toasts").lastChild.remove();
  setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 320); }, 2800);
}

function showDelta(amount) {
  const el = $("delta");
  el.textContent = fmtSigned(amount);
  el.className = "delta " + (amount >= 0 ? "up" : "down");
  void el.offsetWidth; // restart the animation
  el.classList.add("show");
}

function setStreak(n) {
  state.streak = n;
  const el = $("streak");
  if (n >= 2) {
    el.textContent = n + "x STREAK";
    el.classList.add("on"); el.classList.remove("pop"); void el.offsetWidth; el.classList.add("pop");
  } else el.classList.remove("on");
}

// ---------- tap maths (mirrors planTap on the server) ----------
function planBox(lo, hi) {
  const q = state.quote;
  if (!q || state.thin) return null; // thin market: the server would refuse, so offer nothing
  const EPS = 1e-9;
  let side, entry, target;
  if (lo >= q.ask + 0.01 - EPS) { side = "yes"; entry = q.ask; target = lo; }
  else if (hi <= q.bid - 0.01 + EPS) { side = "no"; entry = 1 - q.bid; target = 1 - hi; }
  else return null;
  if (!(entry > 0 && entry < 1 && target > entry && target < 1)) return null;
  return { side, entry, target, multiple: target / entry };
}
/**
 * What a tap on this square would be, for the chosen amount and mode (mirrors planTap's sizing):
 * "win" sizes the order so a hit pays the amount; "size" puts the amount in.
 */
function sizeFor(plan) {
  const raw = state.mode === "win" ? state.win / (plan.target - plan.entry) : state.win / plan.entry;
  const qty = Math.floor(raw * 100) / 100;
  const cost = qty * plan.entry;
  return { qty, cost, win: qty * (plan.target - plan.entry), ok: cost <= state.maxCost + 1e-9 && cost <= state.balance + 1e-9 && qty >= 0.01 };
}
const winOf = (p) => Math.round(p.quantity * (p.target - p.entry) * 100) / 100;

/** The price this position could sell at right now, in its own side's terms. */
const sellNow = (p, q) => (p.side === "yes" ? q.bid : 1 - q.ask);

// ---------- canvases ----------
const canvas = $("grid"), ctx = canvas.getContext("2d");
const fxc = $("fx"), fctx = fxc.getContext("2d");
let W = 0, H = 0, FW = 0, FH = 0;

let DPR = 1;
function resize() {
  const dpr = (DPR = Math.min(window.devicePixelRatio || 1, 2));
  const r = canvas.getBoundingClientRect();
  W = r.width; H = r.height;
  const narrow = W < 560;
  CELL_W = narrow ? 78 : 108; NOW_AT = narrow ? 0.2 : 0.3;
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  FW = innerWidth; FH = innerHeight;
  fxc.width = Math.round(FW * dpr); fxc.height = Math.round(FH * dpr);
  fctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
new ResizeObserver(resize).observe(canvas);
addEventListener("resize", resize);

const colMs = () => state.colSec * 1000;
const xOf = (t) => W * NOW_AT + ((t - now()) / colMs()) * CELL_W;
const tOf = (x) => now() + ((x - W * NOW_AT) / CELL_W) * colMs();
const yOf = (p) => H / 2 - ((p - state.center) / 0.01) * CELL_H;
const pOf = (y) => state.center + ((H / 2 - y) / CELL_H) * 0.01;
const easeOutBack = (t) => 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2;
const easeOut = (t) => 1 - (1 - t) ** 3;

const clockLabels = new Map();
function clockLabel(ts) {
  const key = ts + ":" + state.colSec;
  let s = clockLabels.get(key);
  if (!s) {
    if (clockLabels.size > 300) clockLabels.clear();
    s = new Date(ts - state.clockSkew).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: state.colSec < 60 ? "2-digit" : undefined });
    clockLabels.set(key, s);
  }
  return s;
}

/** A specific square, or null if it isn't a future, tradable one right now. */
function boxFor(col, row) {
  if (state.center === null) return null;
  const start = col * colMs();
  const minLead = state.limits?.minLeadMs ?? 3000;
  if (start < now() || start + colMs() < now() + minLead) return null;
  if (row < 1 || row > 98) return null;
  const lo = row / 100, hi = (row + 1) / 100;
  const plan = planBox(lo, hi);
  return plan ? { col, row, lo, hi, deadline: start + colMs(), plan } : null;
}

/** The square under a canvas point, or null if it isn't a future, tradable one. */
function boxAt(x, y) {
  if (state.center === null) return null;
  const col = Math.floor(tOf(x) / colMs());
  const row = Math.floor(pOf(y) * 100 + 1e-6);
  const start = col * colMs();
  const minLead = state.limits?.minLeadMs ?? 3000;
  if (start < now() || start + colMs() < now() + minLead) return null;
  if (row < 1 || row > 98) return null;
  const lo = row / 100, hi = (row + 1) / 100;
  const plan = planBox(lo, hi);
  return plan ? { col, row, lo, hi, deadline: start + colMs(), plan } : null;
}

function rr(c, x, y, w, h, r) {
  c.beginPath();
  if (c.roundRect) c.roundRect(x, y, w, h, r); else c.rect(x, y, w, h);
}

/**
 * A glass tile centred on (cx, cy): cast shadow, tinted translucent body, lit top edge, bright outline.
 * o: { scale, alpha, tint, bright, line1, line2, charge, fromTop, timeLeft, near }
 */
function tile(cx, cy, w, h, o) {
  const alpha = o.alpha ?? 1;
  if (alpha <= 0) return;
  const tint = o.tint ?? ACCENT, r = Math.min(16, h * 0.24);
  ctx.save();
  ctx.translate(cx, cy); ctx.scale(o.scale ?? 1, o.scale ?? 1); ctx.globalAlpha = alpha;
  // cast shadow, offset down as if lit from above
  if (!state.lite) { ctx.shadowColor = "rgba(0,0,0,0.7)"; ctx.shadowBlur = 22; ctx.shadowOffsetY = 12; }
  ctx.fillStyle = "rgba(1,8,10,0.55)"; rr(ctx, -w / 2, -h / 2, w, h, r); ctx.fill();
  ctx.shadowOffsetY = 0;
  // glow and tinted glass body
  const g = ctx.createLinearGradient(0, -h / 2, 0, h / 2);
  g.addColorStop(0, `rgba(${o.bright ? "255,255,255" : tint},${o.bright ? 0.95 : 0.6})`);
  g.addColorStop(1, `rgba(${tint},${o.bright ? 0.75 : 0.24})`);
  if (!state.lite) { ctx.shadowColor = `rgba(${tint},0.8)`; ctx.shadowBlur = o.near ? 30 : 14; } else ctx.shadowBlur = 0;
  ctx.fillStyle = g; rr(ctx, -w / 2, -h / 2, w, h, r); ctx.fill();
  ctx.shadowBlur = 0;
  // charge: fills toward the side the price has to come from
  if (o.charge > 0) {
    ctx.save(); rr(ctx, -w / 2, -h / 2, w, h, r); ctx.clip();
    const ch = h * o.charge;
    const cg = ctx.createLinearGradient(0, o.fromTop ? -h / 2 : h / 2, 0, o.fromTop ? -h / 2 + ch : h / 2 - ch);
    cg.addColorStop(0, "rgba(255,255,255,0.8)"); cg.addColorStop(1, `rgba(${tint},0.35)`);
    ctx.fillStyle = cg; ctx.fillRect(-w / 2, o.fromTop ? -h / 2 : h / 2 - ch, w, ch);
    ctx.restore();
  }
  // specular highlight across the top, then the outline
  const hl = ctx.createLinearGradient(0, -h / 2, 0, 0);
  hl.addColorStop(0, "rgba(255,255,255,0.5)"); hl.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = hl; rr(ctx, -w / 2 + 2, -h / 2 + 2, w - 4, h * 0.5, Math.max(r - 2, 2)); ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.9)"; ctx.lineWidth = 1.5; rr(ctx, -w / 2 + 0.75, -h / 2 + 0.75, w - 1.5, h - 1.5, r); ctx.stroke();
  ctx.strokeStyle = `rgba(${tint},0.9)`; ctx.lineWidth = 1; rr(ctx, -w / 2 - 2, -h / 2 - 2, w + 4, h + 4, r + 2); ctx.stroke();
  // text and countdown scale with the tile
  const bar = o.timeLeft != null, room = h - (bar ? 9 : 0);
  const f1 = clamp(Math.round(room * (room < 36 ? 0.55 : 0.34)), 8, 26), f2 = clamp(Math.round(room * 0.22), 10, 16);
  const two = o.line2 && room >= 36;
  const top = -h / 2 + (room - (two ? f1 + f2 + 3 : f1)) / 2;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  if (!state.lite) { ctx.shadowColor = "rgba(0,20,26,0.75)"; ctx.shadowBlur = 6; ctx.shadowOffsetY = 1; }
  ctx.fillStyle = "#fff"; ctx.font = `700 ${f1}px ${FONT}`; ctx.fillText(o.line1 ?? "", 0, top + f1 / 2);
  if (two) { ctx.font = `600 ${f2}px ${FONT}`; ctx.fillStyle = "rgba(255,255,255,0.86)"; ctx.fillText(o.line2, 0, top + f1 + 3 + f2 / 2); }
  ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
  if (bar) {
    const bw = (w - 20) * clamp(o.timeLeft, 0, 1);
    ctx.fillStyle = "rgba(0,0,0,0.35)"; rr(ctx, -w / 2 + 10, h / 2 - 9, w - 20, 3.5, 2); ctx.fill();
    ctx.fillStyle = o.timeLeft < 0.3 ? "#fc4848" : "#fff"; rr(ctx, -w / 2 + 10, h / 2 - 9, bw, 3.5, 2); ctx.fill();
  }
  ctx.restore();
}

/** The line takes the team's colour, as Gemini's own charts do; dark colours are lifted to read on black. */
function teamRgb() {
  const hex = /^#([0-9a-f]{6})$/i.exec(state.contract?.color ?? "");
  if (!hex) return LINE_FALLBACK;
  let c = [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16));
  const lum = (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
  // Near-black or grey team colours would lift to a dull grey; use the accent for those.
  if (lum < 0.14 || Math.max(...c) - Math.min(...c) < 40) return LINE_FALLBACK;
  if (lum < 0.5) { const k = (0.5 - lum) / (1 - lum); c = c.map((v) => Math.round(v + (255 - v) * k)); }
  return c.join(",");
}

/** Quotes that were replaced within a second are flicker, not a price level; leave them off the chart. */
function settled(pts) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    if (i + 1 < pts.length && pts[i + 1].t - pts[i].t < 1000) continue;
    out.push(pts[i]);
  }
  return out.length ? out : pts.slice(-1);
}

/** Only the part of the history that is on screen, with sub-second flicker removed. */
function visibleTicks() {
  const all = state.ticks;
  if (!all.length) return all;
  const tMin = tOf(-80);
  let lo = 0, hi = all.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (all[m].t < tMin) lo = m + 1; else hi = m; }
  return settled(all.slice(Math.max(0, lo - 1)));
}

function drawBand(pts, nowX, q, frame) {
  if (!pts.length) return;
  // Band: bid to ask over time. Hits are judged on its edges, not the middle line.
  ctx.beginPath();
  for (let i = 0; i < pts.length; i++) {
    const x0 = xOf(pts[i].t), x1 = i + 1 < pts.length ? xOf(pts[i + 1].t) : nowX;
    if (x1 < -40) continue;
    ctx.rect(x0, yOf(pts[i].ask), x1 - x0, yOf(pts[i].bid) - yOf(pts[i].ask));
  }
  ctx.fillStyle = C.band + "0.09)"; ctx.fill();

  // Project today's bid and ask across the future so each square shows how far it is.
  ctx.setLineDash([3, 7]); ctx.lineWidth = 1.4; ctx.lineDashOffset = reduceMotion ? 0 : -frame / 40;
  for (const p of [q.ask, q.bid]) {
    const y = yOf(p);
    ctx.strokeStyle = C.band + "0.7)";
    ctx.beginPath(); ctx.moveTo(nowX, y); ctx.lineTo(W - 44, y); ctx.stroke();
  }
  ctx.setLineDash([]);
}

function drawLine(pts, nowX, headY, frame, busy) {
  if (!pts.length) return;
  // Mid line, with each 1-cent step eased into an S-curve so it flows.
  ctx.beginPath();
  let started = false, prevY = 0;
  for (let i = 0; i < pts.length; i++) {
    const x = xOf(pts[i].t), y = yOf((pts[i].bid + pts[i].ask) / 2);
    const nextX = i + 1 < pts.length ? xOf(pts[i + 1].t) : nowX;
    if (nextX < -40) { prevY = y; continue; }
    if (!started) { ctx.moveTo(Math.max(x, -40), y); started = true; }
    else ctx.bezierCurveTo(x, prevY, x, y, x + Math.max(Math.min(14, (nextX - x) / 2), 0.01), y);
    if (i + 1 < pts.length) ctx.lineTo(Math.max(nextX - Math.min(14, (nextX - x) / 2), x), y);
    else { ctx.lineTo(Math.max(nowX - 16, x), y); ctx.bezierCurveTo(nowX - 7, y, nowX - 7, headY, nowX, headY); }
    prevY = y;
  }
  const team = teamRgb();
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  // dark casing first: keeps the line readable over tiles, rings and sparks
  ctx.strokeStyle = "rgba(2,4,6,0.8)"; ctx.lineWidth = 8.5; ctx.stroke();
  if (!state.lite) { ctx.strokeStyle = `rgba(${team},0.9)`; ctx.lineWidth = 11; ctx.globalAlpha = 0.18; ctx.stroke(); ctx.globalAlpha = 1; }
  ctx.strokeStyle = `rgb(${team})`; ctx.lineWidth = 3.6;
  if (!state.lite) { ctx.shadowColor = `rgba(${team},0.95)`; ctx.shadowBlur = 14; }
  ctx.stroke(); ctx.shadowBlur = 0;
  if (!reduceMotion && !busy && !state.lite) {
    // Light running along the line toward the head: motion without touching the price.
    ctx.setLineDash([22, 320]); ctx.lineDashOffset = -frame / 11;
    ctx.strokeStyle = "rgba(255,255,255,0.7)"; ctx.lineWidth = 3;
    ctx.stroke(); ctx.setLineDash([]);
  }
}

function draw(frame) {
  requestAnimationFrame(draw);
  if (!W || !H) return;
  drawOverlay(frame);
  if (state.view !== "game") return; // nothing to draw behind the lobby or summary
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.clearRect(0, 0, W, H);

  // If this device can't keep up, drop the expensive blurs for the rest of the session.
  const dt = frame - state.lastFrame; state.lastFrame = frame;
  if (!state.lite && dt > 0 && dt < 500) {
    state.slow = dt > 28 ? state.slow + 1 : Math.max(0, state.slow - 0.25);
    if (state.slow > 45) state.lite = true;
  }
  const q = state.quote;
  if (!q) return;

  // Camera shake after a win.
  if (state.shake > 0.3 && !reduceMotion && !state.lite) ctx.translate(rand(-state.shake, state.shake), rand(-state.shake, state.shake));
  state.shake *= 0.8;

  // Zoom to the spread: as close as possible while keeping ~4 tappable rows each side on screen.
  // Zoomed in: about three tappable rows each side of the spread, as large as the screen allows.
  // state.zoom then scales that: below 1 shows more rows (further, higher-paying squares).
  const maxH = W < 560 ? 86 : 104;
  // The spread flickers by a cent or two; follow it wider at once but narrower only after it has
  // stayed narrower for a few seconds, so the grid doesn't pump in and out.
  const spreadRows = Math.round((q.ask - q.bid) * 100);
  if (spreadRows >= state.spreadHold) { state.spreadHold = spreadRows; state.spreadAt = frame; }
  else if (frame - state.spreadAt > 5000) { state.spreadHold = spreadRows; state.spreadAt = frame; }
  const fitH = clamp(clamp(H / (state.spreadHold + 6.4), 34, maxH) * state.zoom, 13, maxH * 1.5);
  CELL_H = state.center === null || reduceMotion ? fitH : CELL_H + (fitH - CELL_H) * 0.06;

  const mid = (q.bid + q.ask) / 2;
  if (state.center === null) { state.center = mid; state.shownMid = mid; }
  // Follow gently when the price drifts, quickly when it runs, so the line never leaves the screen.
  const rowsOff = Math.abs(mid - state.center) / 0.01;
  state.center += (mid - state.center) * (rowsOff > 2.5 ? 0.16 : rowsOff > 1.2 ? 0.07 : 0.03);
  // "Busy" = the price has changed several times in the last few seconds; decoration backs off then.
  while (state.tickTimes.length && frame - state.tickTimes[0] > 3000) state.tickTimes.shift();
  const busy = state.tickTimes.length >= 4;
  state.shownMid += (mid - state.shownMid) * (reduceMotion ? 1 : 0.18);
  state.headKick *= 0.9;

  const t = now(), nowX = W * NOW_AT;
  const col0 = Math.floor(tOf(0) / colMs()), col1 = Math.floor(tOf(W) / colMs());
  const row0 = Math.max(1, Math.floor(pOf(H) * 100)), row1 = Math.min(98, Math.floor(pOf(0) * 100));
  const minLead = state.limits?.minLeadMs ?? 3000;
  const headY = yOf(state.shownMid);

  // ambient motion (decoration only): a few faint motes drifting with the grid
  if (!reduceMotion && !state.lite) {
    if (state.stars.length !== 18) state.stars = Array.from({ length: 18 }, () => ({ x: rand(0, 1), y: rand(0, 1), s: rand(0.6, 1.6), v: rand(0.3, 1), a: rand(0.1, 0.3) }));
    for (const st of state.stars) {
      st.x -= (st.v * 0.00042 * 1280) / Math.max(W, 320);
      if (st.x < -0.02) { st.x = 1.02; st.y = rand(0, 1); }
      ctx.fillStyle = `rgba(255,225,205,${st.a})`;
      ctx.beginPath(); ctx.arc(st.x * W, st.y * H, st.s, 0, Math.PI * 2); ctx.fill();
    }
  }

  // spread zone ahead of the line: squares here can't be tapped
  const zg = ctx.createLinearGradient(nowX, 0, W, 0);
  zg.addColorStop(0, C.band + "0.10)"); zg.addColorStop(1, C.band + "0.02)");
  ctx.fillStyle = zg; ctx.fillRect(nowX, yOf(q.ask), W - nowX, yOf(q.bid) - yOf(q.ask));

  // grid lines
  ctx.strokeStyle = C.grid; ctx.lineWidth = 1; ctx.beginPath();
  for (let r = row0; r <= row1 + 1; r++) { const y = Math.round(yOf(r / 100)) + 0.5; ctx.moveTo(0, y); ctx.lineTo(W, y); }
  for (let c = col0; c <= col1 + 1; c++) { const x = Math.round(xOf(c * colMs())) + 0.5; ctx.moveTo(x, 0); ctx.lineTo(x, H); }
  ctx.stroke();

  // intersection dots: twinkle, and light up as ripples pass through them
  state.ripples = state.ripples.filter((r) => frame - r.t0 < r.life);
  const [dr, dg, db] = C.dot;
  for (let c = col0; c <= col1 + 1; c++) {
    const x = xOf(c * colMs());
    for (let r = row0; r <= row1 + 1; r++) {
      const y = yOf(r / 100);
      let a = 0.32 + (reduceMotion ? 0 : 0.18 * Math.sin(frame / 700 + c * 1.7 + r * 2.3));
      let s = 3;
      for (const rp of state.ripples) {
        const k = (frame - rp.t0) / rp.life, rad = easeOut(k) * rp.size;
        const d = Math.abs(Math.hypot(x - rp.x, y - rp.y) - rad);
        if (d < 26) { const boost = (1 - d / 26) * (1 - k); a += boost * 0.9; s += boost * 3; }
      }
      ctx.fillStyle = `rgba(${dr},${dg},${db},${clamp(a, 0, 1)})`;
      ctx.fillRect(x - s / 2, y - s / 2, s, s);
    }
  }

  // hover crosshair
  const hv = state.hover;
  if (hv) {
    const hx = xOf(hv.col * colMs()), hy = yOf(hv.hi);
    ctx.fillStyle = `rgba(${ACCENT},0.05)`;
    ctx.fillRect(hx, 0, CELL_W, H); ctx.fillRect(0, hy, W, CELL_H);
  }

  // payout multiples on tradable squares
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  const occupied = new Set();
  for (const p of state.positions) if (p.status === "open" && p.symbol === state.contract?.symbol) occupied.add(Math.floor((p.deadline - 1) / colMs()) + ":" + Math.round(p.lo * 100));
  for (let c = col0; c <= col1; c++) {
    const start = c * colMs();
    if (start < t || start + colMs() < t + minLead) continue;
    const x = xOf(start);
    if (x + CELL_W / 2 > W - 40) continue; // leave the price scale clear
    const fadeIn = clamp((x - nowX) / CELL_W, 0, 1);
    for (let r = row0; r <= row1; r++) {
      if (occupied.has(c + ":" + r) || state.ghosts.has(c + ":" + r)) continue;
      const plan = planBox(r / 100, (r + 1) / 100);
      if (!plan) continue;
      const cx = x + CELL_W / 2, cy = yOf((r + 1) / 100) + CELL_H / 2;
      if (cy < 12 || cy > H - 30) continue;
      const pressed = state.press && state.press.col === c && state.press.row === r;
      const hot = pressed || (hv && hv.col === c && hv.row === r);
      if (hot) {
        // Hover lifts a glass square off the grid; pressing pushes it in with a heavy outline.
        const inset = Math.min(pressed ? 8 : 4, CELL_H * 0.12), rad = Math.min(16, CELL_H * 0.24);
        ctx.save();
        ctx.shadowColor = "rgba(0,0,0,0.7)"; ctx.shadowBlur = pressed ? 8 : 20; ctx.shadowOffsetY = pressed ? 3 : 11;
        ctx.fillStyle = `rgba(${ACCENT},${pressed ? 0.34 : 0.16})`;
        rr(ctx, cx - CELL_W / 2 + inset, cy - CELL_H / 2 + inset, CELL_W - inset * 2, CELL_H - inset * 2, rad); ctx.fill();
        ctx.shadowOffsetY = 0; ctx.shadowColor = `rgba(${ACCENT},0.95)`; ctx.shadowBlur = pressed ? 30 : 20;
        ctx.strokeStyle = "rgba(255,255,255,0.95)"; ctx.lineWidth = pressed ? 3 : 1.5; ctx.stroke();
        ctx.shadowBlur = 0;
        const hl = ctx.createLinearGradient(0, cy - CELL_H / 2, 0, cy);
        hl.addColorStop(0, "rgba(255,255,255,0.28)"); hl.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = hl; rr(ctx, cx - CELL_W / 2 + inset + 2, cy - CELL_H / 2 + inset + 2, CELL_W - inset * 2 - 4, CELL_H * 0.42, Math.max(rad - 2, 1)); ctx.fill();
        if (pressed) { ctx.strokeStyle = `rgba(${ACCENT},0.8)`; ctx.lineWidth = 1.5; rr(ctx, cx - CELL_W / 2 + 1.5, cy - CELL_H / 2 + 1.5, CELL_W - 3, CELL_H - 3, rad + 4); ctx.stroke(); }
        ctx.restore();
        const sz = sizeFor(plan);
        const over = sz.cost > state.maxCost + 1e-9;
        const gain = sz.ok ? "Win " + fmtAmt(Math.round(sz.win * 100) / 100) : over ? "Over max" : "Too much";
        const costTxt = (state.mode === "win" ? "costs " : "puts in ") + fmtAmt(Math.round(sz.cost * 100) / 100);
        const cost = sz.cost;
        if (CELL_H >= 40) {
          let fs = clamp(Math.round(CELL_H * 0.26), 14, 24);
          ctx.font = `700 ${fs}px ${FONT}`;
          // Shrink the label so it stays inside a narrow square.
          const room = CELL_W - 18, need = ctx.measureText(gain).width;
          if (need > room) fs = Math.max(10, Math.floor(fs * room / need));
          ctx.fillStyle = sz.ok ? C.win : "#ffd166"; ctx.font = `700 ${fs}px ${FONT}`;
          ctx.fillText(gain, cx, cy - fs * 0.42);
          ctx.fillStyle = "rgba(255,255,255,0.9)"; ctx.font = `600 ${Math.max(12, Math.round(fs * 0.66))}px ${FONT}`;
          ctx.fillText(costTxt, cx, cy + fs * 0.6);
        } else {
          // Row too short for two lines: show it in a tag above the square.
          ctx.font = `700 ${clamp(Math.round(CELL_H * 0.5), 9, 15)}px ${FONT}`; ctx.fillStyle = "#fff";
          ctx.fillText(fmtAmt(cost), cx, cy);
          const tag = `${gain} · ${costTxt}`;
          ctx.font = `700 14px ${FONT}`;
          const tw = ctx.measureText(tag).width + 18, ty = Math.max(14, cy - CELL_H / 2 - 16);
          ctx.fillStyle = "rgba(18,12,9,0.94)"; ctx.strokeStyle = "rgba(255,255,255,0.3)"; ctx.lineWidth = 1;
          rr(ctx, cx - tw / 2, ty - 12, tw, 24, 12); ctx.fill(); ctx.stroke();
          ctx.fillStyle = sz.ok ? C.win : "#ffd166"; ctx.fillText(tag, cx, ty + 0.5);
        }
      } else {
        // Bigger payouts read brighter; squares near the price shimmer.
        const sz = sizeFor(plan);
        const afford = sz.ok;
        const heat = afford ? clamp((plan.multiple - 1) / 0.4, 0, 1) : 0;
        const near = clamp(1 - Math.abs((r + 0.5) / 100 - mid) / 0.06, 0, 1);
        const shimmer = reduceMotion ? 0 : near * 0.25 * (0.5 + 0.5 * Math.sin(frame / 260 + c * 0.9));
        const [cr, cg, cb] = C.mult;
        ctx.fillStyle = `rgba(${cr + (255 - cr) * heat * 0.6},${cg + (255 - cg) * heat * 0.6},${cb},${clamp((afford ? 0.45 + 0.5 * heat + shimmer : 0.16) * fadeIn, 0, 1)})`;
        ctx.font = `${heat > 0.5 ? 700 : 600} ${clamp(Math.round(CELL_H * 0.46), 10, 19)}px ${FONT}`;
        ctx.fillText(state.mode === "win" ? fmtAmt(Math.round(sz.cost)) : "+" + fmtAmt(Math.round(sz.win * 100) / 100), cx, cy);
      }
    }
  }

  if (state.thin) {
    const msg = "Thin market: waiting for a two-sided price";
    ctx.font = `600 14px ${FONT}`; ctx.textAlign = "center";
    const mw = ctx.measureText(msg).width + 36, mx = nowX + (W - nowX) / 2, my = Math.max(40, H * 0.2);
    ctx.fillStyle = "rgba(18,12,9,0.9)"; ctx.strokeStyle = "rgba(255,209,102,0.6)"; ctx.lineWidth = 1;
    rr(ctx, mx - mw / 2, my - 18, mw, 36, 18); ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#ffd166"; ctx.fillText(msg, mx, my + 1);
  }

  // price scale and time labels
  ctx.font = `600 13px ${FONT}`; ctx.textAlign = "right";
  const rowStep = CELL_H >= 22 ? 1 : CELL_H >= 15 ? 2 : 5; // thin the price scale when zoomed out
  for (let r = row0; r <= row1 + 1; r++) { if (r % rowStep) continue; ctx.fillStyle = C.label; ctx.fillText(cents(r / 100), W - 6, yOf(r / 100) - Math.min(10, CELL_H / 2)); }
  ctx.textAlign = "center";
  const every = Math.max(1, Math.ceil(90 / CELL_W));
  for (let c = col0; c <= col1 + 1; c++) {
    const ts = c * colMs();
    if (ts <= t || c % every) continue;
    ctx.fillStyle = C.label;
    ctx.fillText(clockLabel(ts), xOf(ts), H - 9);
  }

  // band and projected bid/ask go under everything; the line itself is drawn last
  const pts = visibleTicks();
  drawBand(pts, nowX, q, frame);

  // open positions: charge toward the hit, countdown, heartbeat when one cent away
  let tension = null;
  for (const p of state.positions) {
    if (p.status !== "open" || p.symbol !== state.contract?.symbol) continue;
    const span = p.colMs ?? colMs();
    const w = (span / colMs()) * CELL_W, x = xOf(p.deadline - span), y = yOf(p.hi);
    if (x + w < -20 || x > W + 20) continue;
    const gap = Math.max(0, p.target - sellNow(p, q));
    p.gap0 ??= Math.max(gap, 0.01);
    const charge = clamp(1 - gap / p.gap0, 0, 1);
    const near = gap <= 0.01 + 1e-9;
    const left = clamp((p.deadline - t) / span, 0, 1);
    if (near && (!tension || p.deadline < tension.deadline)) tension = p;
    if (left < 0.4 && (!tension || p.deadline < tension.deadline)) tension ??= p;
    const age = p.bornAt ? (frame - p.bornAt) / 260 : 1;
    const s = reduceMotion ? 1 : age < 1 ? 0.6 + 0.4 * easeOutBack(clamp(age, 0, 1)) : 1;
    const jx = near && !reduceMotion ? Math.sin(frame / 25) * 1.6 : 0, jy = near && !reduceMotion ? Math.cos(frame / 31) * 1.2 : 0;
    const flick = left < 0.3 && !reduceMotion ? 0.85 + 0.15 * Math.sin(frame / 60) : 1;
    tile(x + w / 2 + jx, y + CELL_H / 2 + jy, w - 10, CELL_H - Math.min(10, CELL_H * 0.2), {
      scale: s, alpha: flick, charge, fromTop: p.side === "no", timeLeft: left, near,
      line1: "+" + fmtAmt(winOf(p)), line2: near ? "1¢ AWAY" : fmtAmt(p.cost) + " in",
    });
  }
  for (const [key, g] of state.ghosts) {
    const [c, r] = key.split(":").map(Number);
    const age = clamp((frame - g.bornAt) / 220, 0, 1);
    tile(xOf(c * colMs()) + CELL_W / 2, yOf((r + 1) / 100) + CELL_H / 2, CELL_W - 10, CELL_H - Math.min(10, CELL_H * 0.2), {
      scale: reduceMotion ? 1 : 1.35 - 0.35 * easeOutBack(age), alpha: 0.85, line1: "+" + fmtAmt(g.win), line2: fmtAmt(g.cost) + " in",
    });
  }
  // Heartbeat and countdown ticks for the most urgent tile only, so it never turns to noise.
  if (tension) {
    const left = tension.deadline - t;
    const gap = Math.max(0, tension.target - sellNow(tension, q));
    if (gap <= 0.01 + 1e-9 && frame - state.lastBeat > 950 && (tension.beats ?? 0) < 5) {
      state.lastBeat = frame; tension.beats = (tension.beats ?? 0) + 1; sfx.beat(); buzz([18, 90, 18]);
    }
    const sec = Math.ceil(left / 1000);
    if (sec <= 3 && sec >= 1 && sec !== state.lastTick) { state.lastTick = sec; sfx.tick(); }
  }

  // effects on the grid: bursts, rings, sparks, shards, floating amounts
  state.fx = state.fx.filter((f) => frame - f.t0 < f.life);
  for (const f of state.fx) {
    if (frame < f.t0) continue; // staggered effects that haven't started yet
    const k = (frame - f.t0) / f.life;
    const x = xOf(f.time) + (f.dx ?? 0), y = yOf(f.price) + (f.dy ?? 0);
    if (f.kind === "burst") {
      tile(x, y, f.w, f.h, { scale: 1 + easeOut(k) * 0.6, alpha: 1 - k, tint: f.win ? GREEN : RED, bright: true });
    } else if (f.kind === "ring") {
      ctx.strokeStyle = `rgba(${f.rgb},${(1 - k) * (f.a ?? 1)})`; ctx.lineWidth = (f.width ?? 3) * (1 - k) + 0.5;
      ctx.beginPath(); ctx.arc(x, y, (f.r0 ?? 20) + easeOut(k) * f.size, 0, Math.PI * 2); ctx.stroke();
    } else if (f.kind === "spark") {
      const d = easeOut(k) * f.dist;
      ctx.fillStyle = `rgba(${f.rgb},${1 - k})`;
      ctx.beginPath(); ctx.arc(x + Math.cos(f.a) * d, y + Math.sin(f.a) * d + k * k * (f.g ?? 30), (f.s ?? 2.6) * (1 - k) + 0.6, 0, Math.PI * 2); ctx.fill();
    } else if (f.kind === "shard") {
      const px = x + f.vx * k * 60, py = y + f.vy * k * 60 + k * k * 160;
      ctx.save(); ctx.translate(px, py); ctx.rotate(f.rot * k); ctx.globalAlpha = 1 - k;
      ctx.fillStyle = f.color; ctx.fillRect(-f.s / 2, -f.s / 2, f.s, f.s * 0.7); ctx.restore();
    } else if (f.kind === "text") {
      ctx.save();
      ctx.globalAlpha = k < 0.12 ? k / 0.12 : 1 - clamp((k - 0.6) / 0.4, 0, 1);
      ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.font = `700 ${f.size}px ${FONT}`;
      ctx.shadowColor = f.color; ctx.shadowBlur = 20; ctx.fillStyle = f.color;
      const pop = reduceMotion ? 1 : k < 0.18 ? 0.6 + 0.4 * easeOutBack(k / 0.18) : 1;
      ctx.translate(x, y - easeOut(k) * (f.rise ?? 50)); ctx.scale(pop, pop);
      ctx.fillText(f.text, 0, 0);
      ctx.restore();
    }
  }

  // the line, over the tiles and effects
  drawLine(pts, nowX, headY, frame, busy);

  // comet trail off the head
  if (!reduceMotion && !state.lite && (state.headKick > 0.2 || Math.random() < 0.18)) {
    state.trail.push({ t: t, p: state.shownMid + rand(-0.0012, 0.0012), born: frame, life: rand(700, 1300), s: rand(1, 2.6) });
    if (state.trail.length > 60) state.trail.splice(0, state.trail.length - 60);
  }
  state.trail = state.trail.filter((d) => frame - d.born < d.life);
  for (const d of state.trail) {
    const k = (frame - d.born) / d.life;
    ctx.fillStyle = `rgba(255,255,255,${(1 - k) * 0.5})`;
    ctx.beginPath(); ctx.arc(xOf(d.t), yOf(d.p) + k * rand(-3, 3), d.s * (1 - k * 0.6), 0, Math.PI * 2); ctx.fill();
  }

  // head: pulse ring, kick on each price change
  const pulse = reduceMotion ? 0.5 : (Math.sin(frame / 300) + 1) / 2;
  const kick = state.headKick;
  ctx.strokeStyle = `rgba(255,255,255,${0.55 - pulse * 0.4})`; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(nowX, headY, 8 + pulse * 10 + kick * 14, 0, Math.PI * 2); ctx.stroke();
  const team = teamRgb();
  ctx.fillStyle = "#fff"; ctx.shadowColor = `rgba(${team},1)`; ctx.shadowBlur = 22 + kick * 30;
  ctx.beginPath(); ctx.arc(nowX, headY, 6 + kick * 4, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;

  // win markers pinned to the line where each hit happened
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  for (const m of state.marks) {
    if (m.symbol !== state.contract?.symbol) continue;
    const x = xOf(m.t), y = yOf(m.price);
    if (x < -60) continue;
    ctx.fillStyle = C.win; ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill();
    ctx.font = `700 11px ${FONT}`;
    const tw = ctx.measureText(m.text).width + 14;
    ctx.fillStyle = "rgba(74,222,128,0.18)"; ctx.strokeStyle = "rgba(74,222,128,0.75)"; ctx.lineWidth = 1;
    rr(ctx, x - tw / 2, y - 30, tw, 19, 10); ctx.fill(); ctx.stroke();
    ctx.fillStyle = C.win; ctx.fillText(m.text, x, y - 20.5);
  }
  state.marks = state.marks.filter((m) => xOf(m.t) > -80);

  // readout beside the head: who and what chance (as Gemini's charts label it), bid/ask, buyers vs sellers
  {
    const name = (state.contract?.label ?? "").slice(0, 16), pct = Math.round(mid * 100) + "%";
    const quoteTxt = cents(q.bid) + " / " + cents(q.ask);
    ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.font = `700 17px ${FONT}`; const w1 = ctx.measureText(name + "  " + pct).width;
    ctx.font = `600 14px ${FONT}`; const w2 = ctx.measureText(quoteTxt).width;
    const bw = Math.max(w1, w2, 96) + 24, bh = state.sizes ? 58 : 46, bx = nowX + 20, by = headY - bh / 2;
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.6)"; ctx.shadowBlur = 16; ctx.shadowOffsetY = 8;
    ctx.fillStyle = "rgba(18,12,9,0.88)"; rr(ctx, bx, by, bw, bh, 13); ctx.fill();
    ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    ctx.strokeStyle = "rgba(255,255,255,0.2)"; ctx.lineWidth = 1; ctx.stroke();
    ctx.restore();
    ctx.font = `700 17px ${FONT}`; ctx.fillStyle = `rgb(${teamRgb()})`; ctx.fillText(name, bx + 12, by + 15);
    ctx.fillStyle = "#fff"; ctx.fillText(pct, bx + 12 + ctx.measureText(name + "  ").width, by + 15);
    ctx.font = `600 14px ${FONT}`; ctx.fillStyle = C.label; ctx.fillText(quoteTxt, bx + 12, by + 33);
    if (state.sizes) {
      // Resting orders at the best bid and ask: real order-book data, eased so it glides.
      const sz = state.sizes; sz.shown += (sz.share - sz.shown) * 0.08;
      const full = bw - 24, gw = full * clamp(sz.shown, 0.04, 0.96);
      ctx.fillStyle = `rgba(${GREEN},0.9)`; rr(ctx, bx + 12, by + 45, gw - 1, 4, 2); ctx.fill();
      ctx.fillStyle = `rgba(${RED},0.9)`; rr(ctx, bx + 12 + gw + 1, by + 45, full - gw - 1, 4, 2); ctx.fill();
    }
  }
}

/** Full-screen layer: flash, coins flying to the balance, confetti. */
let overlayPainted = false;
function drawOverlay(frame) {
  const active = state.flash > 0.01 || state.over.length > 0;
  if (active || overlayPainted) fctx.clearRect(0, 0, FW, FH);
  overlayPainted = active;
  if (state.flash > 0.01) {
    fctx.fillStyle = `rgba(${state.flashColor},${state.flash})`;
    fctx.fillRect(0, 0, FW, FH);
    state.flash *= 0.86;
  }
  state.over = state.over.filter((o) => frame - o.t0 < o.life || (o.kind === "coin" && !o.done));
  for (const o of state.over) {
    const k = clamp((frame - o.t0) / o.life, 0, 1);
    if (o.kind === "coin") {
      if (frame < o.t0) continue;
      const e = easeOut(k);
      const x = (1 - e) * (1 - e) * o.x0 + 2 * (1 - e) * e * o.cx + e * e * o.x1;
      const y = (1 - e) * (1 - e) * o.y0 + 2 * (1 - e) * e * o.cy + e * e * o.y1;
      fctx.save(); fctx.translate(x, y); fctx.scale(1 - k * 0.4, 1 - k * 0.4);
      fctx.shadowColor = "rgba(74,222,128,1)"; fctx.shadowBlur = 16;
      fctx.fillStyle = "#d6ffe4"; fctx.beginPath(); fctx.arc(0, 0, 6, 0, Math.PI * 2); fctx.fill();
      fctx.fillStyle = "#4ade80"; fctx.beginPath(); fctx.arc(0, 0, 3.5, 0, Math.PI * 2); fctx.fill();
      fctx.restore();
      if (k >= 1 && !o.done) { o.done = true; sfx.coin(o.i); bumpWallet(); }
    } else if (o.kind === "confetti") {
      const x = o.x + o.vx * k * 300, y = o.y + o.vy * k * 300 + k * k * 420;
      fctx.save(); fctx.translate(x, y); fctx.rotate(o.rot + k * o.spin); fctx.globalAlpha = 1 - k * k;
      fctx.fillStyle = o.color; fctx.fillRect(-4, -2, 8, 4); fctx.restore();
    }
  }
  // Roll the balance toward its real value.
  if (Math.abs(state.balance - state.balanceShown) > 0.004) {
    state.balanceShown += (state.balance - state.balanceShown) * 0.12;
    $("balance").textContent = fmtMoney(state.balanceShown);
  } else if (state.balanceShown !== state.balance) {
    state.balanceShown = state.balance; $("balance").textContent = fmtMoney(state.balance);
  }
}

function bumpWallet() {
  const el = $("wallet");
  el.classList.remove("bump"); void el.offsetWidth; el.classList.add("bump");
}

// ---------- effect builders ----------
function ripple(x, y, size = 260, life = 900) {
  if (!reduceMotion) state.ripples.push({ x, y, t0: performance.now(), size, life });
}

function tapFx(box) {
  const t0 = performance.now(), time = box.deadline - colMs() / 2, price = (box.lo + box.hi) / 2;
  state.fx.push({ kind: "ring", t0, life: 450, time, price, rgb: ACCENT, size: 60, r0: 18, width: 3 });
  if (!reduceMotion) for (let i = 0; i < 5; i++) state.fx.push({ kind: "spark", t0, life: rand(300, 500), time, price, a: rand(0, Math.PI * 2), dist: rand(26, 50), rgb: "255,220,195", g: 0, s: 2.4 });
  ripple(xOf(time), yOf(price), 160, 600);
}

function priceFx(up) {
  const t0 = performance.now(), time = now(), price = state.shownMid;
  state.headKick = 1;
  state.tickTimes.push(t0);
  // When the price is running, one flare per move would bury the line: show at most ~3 a second,
  // and just the ring, no sparks or ripple.
  if (t0 - state.lastFlare < 320) return;
  state.lastFlare = t0;
  if (state.tickTimes.length >= 4 || state.lite) {
    state.fx.push({ kind: "ring", t0, life: 450, time, price, rgb: up ? GREEN : RED, size: 30, r0: 8, width: 2, a: 0.7 });
    return;
  }
  const rgb = up ? GREEN : RED;
  state.fx.push({ kind: "ring", t0, life: 600, time, price, rgb, size: 44, r0: 8, width: 2.5 });
  if (!reduceMotion) for (let i = 0; i < 5; i++) state.fx.push({ kind: "spark", t0, life: rand(400, 700), time, price, a: up ? rand(-Math.PI * 0.9, -Math.PI * 0.1) : rand(Math.PI * 0.1, Math.PI * 0.9), dist: rand(20, 46), rgb, g: up ? -10 : 20, s: 2.2 });
  ripple(W * NOW_AT, yOf(price), 220, 800);
}

/** Orders arriving or leaving at the best bid/ask: real book activity, shown as sparks on that edge. */
function orderFlow(d) {
  const b = d.bidSize || 0, a = d.askSize || 0;
  if (b + a <= 0) return;
  const prev = state.sizes;
  state.sizes = { bid: b, ask: a, share: b / (b + a), shown: prev?.shown ?? b / (b + a) };
  if (!prev || reduceMotion || !state.quote) return;
  const t0 = performance.now(), time = now();
  for (const [changed, price, rgb] of [[b !== prev.bid, d.bid, GREEN], [a !== prev.ask, d.ask, RED]]) {
    if (!changed) continue;
    state.fx.push({ kind: "ring", t0, life: 500, time, price, rgb, size: 20, r0: 4, width: 2, a: 0.7 });
  }
}

/** One win effect, however many squares hit together. `amount` is the total; `big` adds confetti. */
function winFx(p, amount, big) {
  const span = p.colMs ?? colMs();
  const time = p.deadline - span / 2, price = (p.lo + p.hi) / 2, t0 = performance.now();
  state.fx.push({ kind: "burst", t0, life: 600, time, price, w: CELL_W - 10, h: CELL_H - 10, win: true });
  state.fx.push({ kind: "ring", t0, life: 700, time, price, rgb: GREEN, size: big ? 130 : 90, r0: 24, width: 3 });
  if (!reduceMotion) for (let i = 0; i < (big ? 18 : 10); i++) state.fx.push({ kind: "spark", t0, life: rand(500, 850), time, price, a: rand(0, Math.PI * 2), dist: rand(40, big ? 110 : 80), rgb: "150,255,190", s: 2.6 });
  state.fx.push({ kind: "text", t0, life: 1500, time, price, dy: -6, text: fmtSigned(amount), size: big ? 32 : 26, color: C.win, rise: 60 });
  ripple(xOf(time), yOf(price), big ? 380 : 260, 1000);
  if (reduceMotion) return;
  state.shake = big ? 6 : 3;
  state.flash = big ? 0.16 : 0.08; state.flashColor = GREEN;
  // A few coins fly from the square to the balance.
  const gr = canvas.getBoundingClientRect(), wr = $("wallet").getBoundingClientRect();
  const x0 = gr.left + xOf(time), y0 = gr.top + yOf(price), x1 = wr.left + wr.width * 0.6, y1 = wr.top + wr.height / 2;
  for (let i = 0; i < (big ? 9 : 5); i++) {
    state.over.push({ kind: "coin", i, t0: t0 + 120 + i * 60, life: 650 + rand(-80, 80), x0: x0 + rand(-14, 14), y0: y0 + rand(-10, 10), cx: (x0 + x1) / 2 + rand(-120, 120), cy: Math.min(y0, y1) - rand(60, 180), x1, y1 });
  }
  if (big) {
    const colors = ["#4ade80", "#f95e01", "#ffd166", "#ffffff"];
    for (let i = 0; i < 40; i++) state.over.push({ kind: "confetti", t0, life: rand(1100, 1700), x: x0, y: y0, vx: rand(-1.1, 1.1), vy: rand(-1.4, -0.3), rot: rand(0, 6), spin: rand(-10, 10), color: colors[i % colors.length] });
  }
}

/** Squares that hit at the same moment fade out quietly; only one of them carries the win effect. */
function quietHit(p) {
  const span = p.colMs ?? colMs();
  state.fx.push({ kind: "burst", t0: performance.now(), life: 450, time: p.deadline - span / 2, price: (p.lo + p.hi) / 2, w: CELL_W - 10, h: CELL_H - 10, win: true });
}

function missFx(p, quiet) {
  const span = p.colMs ?? colMs();
  const time = p.deadline - span / 2, price = (p.lo + p.hi) / 2, t0 = performance.now();
  state.fx.push({ kind: "burst", t0, life: 380, time, price, w: CELL_W - 10, h: CELL_H - 10, win: false });
  if (quiet) return;
  if (!reduceMotion) for (let i = 0; i < 6; i++) state.fx.push({ kind: "shard", t0, life: rand(600, 900), time, price, vx: rand(-1.4, 1.4), vy: rand(-1.6, -0.2), rot: rand(-6, 6), s: rand(5, 10), color: i % 2 ? `rgba(${ACCENT},0.8)` : "rgba(252,72,72,0.8)" });
  state.fx.push({ kind: "text", t0, life: 1100, time, price, text: fmtSigned(p.pnl), size: 17, color: p.pnl >= 0 ? C.win : C.loss, rise: 36 });
}

// ---------- input ----------
function pointer(e) {
  const r = canvas.getBoundingClientRect();
  return boxAt(e.clientX - r.left, e.clientY - r.top);
}
canvas.addEventListener("pointermove", (e) => { state.hover = e.pointerType === "touch" ? null : pointer(e); });
canvas.addEventListener("pointerleave", () => { state.hover = null; state.press = null; });
canvas.addEventListener("pointercancel", () => { state.press = null; });
function setZoom(z) {
  state.zoom = clamp(z, 0.25, 1.5);
  store.set("tapline.zoom", String(round2(state.zoom)));
  const pct = $("zoomPct"); if (pct) pct.textContent = Math.round(state.zoom * 100) + "%";
}
const round2 = (n) => Math.round(n * 100) / 100;
canvas.addEventListener("wheel", (e) => { e.preventDefault(); setZoom(state.zoom * Math.exp(-e.deltaY * 0.0016)); }, { passive: false });
// Two fingers pinch to zoom; a pinch never places a trade.
const touches = new Map();
const spread2 = () => { const [a, b] = [...touches.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
canvas.addEventListener("pointerdown", (e) => {
  if (e.pointerType !== "touch") return;
  touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (touches.size === 2) { state.pinch = { d0: spread2(), z0: state.zoom }; state.press = null; }
}, true);
canvas.addEventListener("pointermove", (e) => {
  if (!touches.has(e.pointerId)) return;
  touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (state.pinch && touches.size === 2) setZoom(state.pinch.z0 * (spread2() / state.pinch.d0));
}, true);
const endTouch = (e) => { touches.delete(e.pointerId); if (!touches.size && state.pinch) setTimeout(() => (state.pinch = null), 60); };
canvas.addEventListener("pointercancel", endTouch, true);

canvas.addEventListener("contextmenu", (e) => e.preventDefault());
canvas.addEventListener("pointerdown", (e) => {
  if (state.pinch) return;
  const box = pointer(e);
  state.press = box ? { col: box.col, row: box.row, x: e.clientX, y: e.clientY } : null;
  if (box) { tone(300, 240, 0.05, "sine", 0.05); buzz(4); }
});
canvas.addEventListener("pointerup", async (e) => {
  const pinched = !!state.pinch, press = state.press;
  endTouch(e);
  state.press = null;
  if (pinched) return;
  hideCoach();
  // The grid scrolls and re-centres while a finger is down. Trade the square that was pressed,
  // not whichever one has slid under the finger; a drag away cancels.
  if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 18) return;
  const box = press ? boxFor(press.col, press.row) : null;
  if (!box || !state.contract) { if (state.quote) { sfx.deny(); buzz(6); } return; }
  const key = box.col + ":" + box.row;
  if (state.ghosts.has(key)) return;
  const span = colMs(), symbol = state.contract.symbol;
  const sz = sizeFor(box.plan);
  if (!sz.ok) {
    sfx.deny(); buzz(20);
    toast(sz.cost > state.maxCost + 1e-9 ? `That square needs ${fmtAmt(Math.ceil(sz.cost))}. Your max per square is ${fmtAmt(state.maxCost)}.` : `That square needs ${fmtAmt(Math.ceil(sz.cost))}, more than your balance.`, "err");
    return;
  }
  state.ghosts.set(key, { bornAt: performance.now(), win: Math.round(sz.win * 100) / 100, cost: sz.cost, multiple: box.plan.multiple });
  sfx.tap(box.plan.multiple); buzz(12); tapFx(box);
  try {
    const { position } = await backend.tap({ symbol, lo: box.lo, hi: box.hi, deadline: box.deadline, amount: state.win, mode: state.mode, maxCost: state.maxCost });
    upsertPosition({ ...position, colMs: span, bornAt: state.ghosts.get(key)?.bornAt, multiple: position.target / position.entry });
  } catch (err) {
    sfx.deny(); buzz(30);
    toast(err.message === "that box is on the line, pick one further away" ? "Try another square." : err.message, "err");
  } finally {
    state.ghosts.delete(key);
  }
});

// ---------- positions ----------
function upsertPosition(p) {
  const i = state.positions.findIndex((x) => x.id === p.id);
  if (i === -1) state.positions.push(p);
  else state.positions[i] = { ...state.positions[i], ...p };
  renderPositions();
  if (state.view === "summary") renderSummary();
}

function renderPositions() {
  $("posCount").textContent = state.positions.filter((p) => p.status === "open").length;
  const list = $("posList");
  if (!$("posDlg").open) return;
  list.replaceChildren();
  const sorted = [...state.positions].sort((a, b) => (a.status === "open" ? 0 : 1) - (b.status === "open" ? 0 : 1) || b.openedAt - a.openedAt).slice(0, 60);
  if (!sorted.length) { list.innerHTML = '<div class="none">No positions yet. Tap a square on the grid.</div>'; return; }
  for (const p of sorted) {
    const row = document.createElement("div"); row.className = "row";
    const up = p.side === "yes";
    const main = document.createElement("div"); main.className = "main";
    main.innerHTML = '<div class="title"></div><div class="sub"></div>';
    main.firstChild.textContent = `${p.label} ${up ? "↑" : "↓"} to ${cents(up ? p.lo : p.hi)}`;
    const status = { open: "Open", won: "Hit", expired: "Timed out", closed: "Closed" }[p.status];
    main.lastChild.textContent = `${status} · ${fmtMoney(p.cost)} in at ${cents(p.entry)}${p.exit != null ? " · out at " + cents(p.exit) : ""}`;
    row.append(main);
    if (p.status === "open") {
      const b = document.createElement("button"); b.className = "close-btn"; b.textContent = "Close";
      b.onclick = async () => { try { await backend.close(p.id); } catch (err) { toast(err.message, "err"); } };
      row.append(b);
    } else {
      const n = document.createElement("div"); n.className = "num " + (p.pnl >= 0 ? "pos" : "neg"); n.textContent = fmtSigned(p.pnl);
      row.append(n);
    }
    list.append(row);
  }
}

const pendingResults = [];
let resultTimer = null;

function onPositionEvent({ position, balance }) {
  const before = state.positions.find((x) => x.id === position.id);
  state.balance = balance;
  upsertPosition(position);
  if (position.status === "open" || (before && before.status !== "open")) return;
  // Several squares often resolve in the same instant (same price move, same deadline).
  // Gather them for a moment and show one result, not a pile of effects and toasts.
  pendingResults.push({ ...before, ...position });
  resultTimer ??= setTimeout(flushResults, 160);
}

function flushResults() {
  resultTimer = null;
  const batch = pendingResults.splice(0);
  const wins = batch.filter((p) => p.status === "won"), rest = batch.filter((p) => p.status !== "won");
  const sum = (ps) => ps.reduce((s, p) => s + p.pnl, 0);
  if (wins.length) {
    const total = sum(wins);
    const milestone = [5, 10, 20].some((m) => state.streak < m && state.streak + wins.length >= m);
    setStreak(state.streak + wins.length);
    checkBadges(wins);
    const big = total >= 5 || milestone;
    const lead = wins[0];
    for (const p of wins.slice(1)) quietHit(p);
    winFx(lead, total, big);
    sfx.win(state.streak, big); buzz(big ? [25, 40, 25, 40, 60] : [20, 40, 40]);
    state.marks.push({ symbol: lead.symbol, t: now(), price: lead.side === "yes" ? lead.lo : lead.hi, text: fmtSigned(total) });
    toast(wins.length > 1 ? `${wins.length} squares hit · won ${fmtMoney(total)}` : `You won ${fmtMoney(total)}`, "win");
  }
  if (rest.length) {
    const total = sum(rest);
    if (rest.some((p) => p.status === "expired") && !wins.length) setStreak(0);
    rest.forEach((p, i) => missFx(p, i > 0));
    if (!wins.length) { sfx.miss(); buzz(30); }
    const p = rest[0];
    const short = Math.round((p.target - (p.best ?? 0)) * 100);
    const why = rest.length > 1 ? `${rest.length} squares ${rest.every((x) => x.status === "closed") ? "closed" : "timed out"}`
      : p.status === "closed" ? "Closed" : short > 0 && short < 50 ? `Missed by ${short}¢` : "Timed out";
    toast(`${why} · ${fmtSigned(total)}`, total >= 0 ? "win" : "loss");
  }
  showDelta(sum(batch));
  state.sessionPnl += sum(batch);
  const chip = $("session");
  chip.textContent = fmtSigned(state.sessionPnl) + " this session";
  chip.className = "session " + (state.sessionPnl >= 0 ? "pos" : "neg");
  chip.hidden = false;
}

// ---------- live activity from the whole game ----------
function onMove(m) {
  if (m.symbol === state.contract?.symbol) return; // the chart itself shows this one
  const up = m.to > m.from;
  for (const tab of document.querySelectorAll("#markets .tab")) {
    if (tab.textContent === m.market) { tab.classList.remove("hot"); void tab.offsetWidth; tab.classList.add("hot"); }
  }
  const el = document.createElement("button");
  el.className = "move " + (up ? "up" : "down");
  el.innerHTML = '<span class="arrow"></span><span class="what"></span><b></b>';
  el.children[0].textContent = up ? "▲" : "▼";
  el.children[1].textContent = `${m.market} · ${m.label}`;
  el.children[2].textContent = cents(m.to);
  el.onclick = () => {
    const market = state.game?.markets.find((x) => x.name === m.market);
    const c = market?.contracts.find((x) => x.symbol === m.symbol);
    if (market && c) { state.market = market; selectContract(c); }
  };
  const box = $("activity");
  box.prepend(el);
  while (box.children.length > 2) box.lastChild.remove();
  setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 420); }, 4500);
  const dot = document.querySelector(".live");
  if (dot) { dot.style.transform = "scale(1.8)"; setTimeout(() => (dot.style.transform = ""), 180); }
}

// ---------- stream ----------
function openStream() {
  state.source?.close();
  state.ticks = []; state.quote = null; state.center = null; state.hover = null; state.lastMid = null; state.trail = []; state.sizes = null; state.thin = false;
  const c = state.contract;
  if (!c) return;
  let src;
  const mine = () => state.source === src;
  src = state.source = backend.stream(c.symbol, state.game?.id, {
    history(d) {
      if (!mine()) return;
      state.clockSkew = d.now - Date.now();
      state.ticks = d.ticks;
      const last = d.ticks.at(-1);
      if (last) { state.quote = { bid: last.bid, ask: last.ask }; state.lastMid = (last.bid + last.ask) / 2; }
      $("empty").hidden = !!last;
      if (!last) {
        $("empty").textContent = "Waiting for a live price on this contract…";
        setTimeout(() => {
          if (mine() && !$("empty").hidden) $("empty").textContent = "No two-sided price here right now. Try another market above, or change game.";
        }, 7000);
      }
      else maybeCoach();
    },
    quote(d) {
      if (!mine()) return;
      // One-sided or gapped quotes aren't drawn, but they are the real market right now:
      // no square can be traded until a normal two-sided price is back.
      state.thin = !drawable(d);
      if (state.thin) return;
      orderFlow(d);
      state.quote = { bid: d.bid, ask: d.ask };
      const lastTick = state.ticks.at(-1);
      if (!lastTick || lastTick.bid !== d.bid || lastTick.ask !== d.ask) state.ticks.push({ t: d.t, bid: d.bid, ask: d.ask });
      const mid = (d.bid + d.ask) / 2;
      if (state.lastMid !== null && Math.abs(mid - state.lastMid) >= 0.005 - 1e-9) {
        const up = mid > state.lastMid;
        priceFx(up);
        const nowMs = performance.now();
        if (nowMs - state.lastBlip > 260) { state.lastBlip = nowMs; up ? sfx.priceUp() : sfx.priceDown(); }
      }
      state.lastMid = mid;
      if (!$("empty").hidden) { $("empty").hidden = true; maybeCoach(); }
      updateChipPrice(c.symbol, d);
    },
    move: (m) => mine() && onMove(m),
    position: (e) => mine() && onPositionEvent(e),
    ping: (d) => { if (mine()) state.clockSkew = d.now - Date.now(); },
  });
}

// ---------- first-run hint ----------
function maybeCoach() {
  if (store.get("tapline.coached")) return;
  $("coach").hidden = false;
  setTimeout(hideCoach, 12000);
}
function hideCoach() {
  if ($("coach").hidden) return;
  $("coach").hidden = true; store.set("tapline.coached", "1");
}

// ---------- chrome ----------
function seg(el, values, label, get, set) {
  el.replaceChildren(...values.map((v) => {
    const b = document.createElement("button");
    b.textContent = label(v);
    b.setAttribute("aria-pressed", String(get() === v));
    b.onclick = () => { set(v); sfx.tap(1.02); buzz(6); seg(el, values, label, get, set); };
    return b;
  }));
}

function updateChipPrice(symbol, q) {
  const el = document.querySelector(`.chip[data-symbol="${CSS.escape(symbol)}"] b`);
  if (el) el.textContent = cents((q.bid + q.ask) / 2);
}

function renderMarkets() {
  const g = state.game;
  $("gameTitle").textContent = g ? g.title : "No live games";
  $("markets").replaceChildren(...(g?.markets ?? []).map((m) => {
    const b = document.createElement("button"); b.className = "tab"; b.textContent = m.name;
    b.setAttribute("aria-pressed", String(m === state.market));
    b.onclick = () => selectMarket(m);
    return b;
  }));
  $("contracts").replaceChildren(...(state.market?.contracts ?? []).map((c) => {
    const b = document.createElement("button"); b.className = "chip"; b.dataset.symbol = c.symbol;
    if (/^#[0-9a-f]{6}$/i.test(c.color ?? "")) b.style.setProperty("--c", c.color);
    b.innerHTML = '<span class="dot"></span><span></span><b></b>';
    b.children[1].textContent = c.label;
    b.children[2].textContent = c.bid != null && c.ask != null ? cents((c.bid + c.ask) / 2) : "no quote";
    b.setAttribute("aria-pressed", String(c === state.contract));
    b.onclick = () => selectContract(c);
    return b;
  }));
}

function selectContract(c) { state.contract = c; renderMarkets(); openStream(); }
function selectMarket(m) {
  // Open on the contract nearest 50/50 with a tight spread: that's where the action is.
  const quoted = m.contracts.filter((c) => drawable(c));
  const score = (c) => Math.abs((c.bid + c.ask) / 2 - 0.5) + (c.ask - c.bid) * 2;
  quoted.sort((a, b) => score(a) - score(b));
  state.market = m;
  selectContract(quoted[0] ?? m.contracts[0]);
}
function selectGame(g) { state.game = g; selectMarket(g.markets[0]); }

function setWin(v) {
  state.win = v; store.set("tapline.win", String(v));
  renderWins();
}
function renderWins() {
  seg($("modeSeg"), ["win", "size"], (v) => (v === "win" ? "Win" : "Size"), () => state.mode, (v) => {
    state.mode = v; store.set("tapline.mode", v);
    toast(v === "win" ? "Win mode: the amount is what a hit pays you." : "Size mode: the amount is what you put in.");
    renderWins();
  });
  $("modeSeg").children[0].title = "The amount is what you win when a square hits";
  $("modeSeg").children[1].title = "The amount is what you put into each square";
  seg($("stakes"), WINS, (v) => "$" + v, () => state.win, setWin);
  const isCustom = !WINS.includes(state.win);
  $("customWin").closest(".custom").classList.toggle("on", isCustom);
  if (isCustom) $("customWin").value = state.win; else if (document.activeElement !== $("customWin")) $("customWin").value = "";
  $("maxVal").textContent = fmtAmt(state.maxCost);
}
const MAX_CHOICES = [50, 100, 250, 500, 1000, 2500];
function renderMax() {
  seg($("maxSeg"), MAX_CHOICES, (v) => "$" + v.toLocaleString(), () => state.maxCost, (v) => {
    state.maxCost = v; store.set("tapline.max", String(v)); renderMax(); renderWins();
  });
}

// ---------- badges: small milestones, kept in this browser ----------
const BADGES = [
  ["first", "First hit", "Land your first square"],
  ["hat", "Hat-trick", "3 hits in a row"],
  ["fire", "On fire", "5 hits in a row"],
  ["big", "Big one", "Win $25 or more on one square"],
  ["century", "Century", "Win $100 in total"],
];
const earned = new Set((store.get("tapline.badges") || "").split(",").filter(Boolean));
function award(id) {
  if (earned.has(id)) return;
  earned.add(id); store.set("tapline.badges", [...earned].join(","));
  const b = BADGES.find((x) => x[0] === id);
  setTimeout(() => toast(`Badge unlocked: ${b[1]}`, "badge"), 900);
}
function checkBadges(wins) {
  if (!wins.length) return;
  award("first");
  if (state.streak >= 3) award("hat");
  if (state.streak >= 5) award("fire");
  if (wins.some((p) => p.pnl >= 25)) award("big");
  const total = state.positions.filter((p) => p.status === "won").reduce((s, p) => s + (p.pnl ?? 0), 0);
  if (total >= 100) award("century");
}

// ---------- sections ----------
function setView(v) {
  if (v === "game" && !state.game) v = "lobby";
  state.view = v;
  document.body.dataset.view = v;
  for (const b of document.querySelectorAll("#views button")) {
    if (b.dataset.view === v) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  }
  if (v === "lobby") renderLobby();
  if (v === "summary") renderSummary();
  if (v === "game") requestAnimationFrame(resize);
  scrollTo(0, 0);
}

const inPlay = (g) => g.markets[0]?.contracts.some((c) => drawable(c) && (c.bid + c.ask) / 2 > 0.12 && (c.bid + c.ask) / 2 < 0.88) ?? false;
/** Can this game be traded at all right now: does any of its first few markets have a two-sided price? */
const hasPrice = (g) => g.markets.slice(0, 3).some((m) => m.contracts.some(drawable));
/** LIVE: in play. CLOSING: priced but all but decided. NO PRICE: nothing two-sided to trade. */
const gameState = (g) => (inPlay(g) ? "live" : hasPrice(g) ? "closing" : "none");

function renderLobby() {
  const wrap = $("lobbyGames");
  wrap.replaceChildren();
  if (!state.games.length) {
    const note = document.createElement("div"); note.className = "cards-note";
    note.textContent = !state.gamesLoaded ? "Loading live games from Gemini…" : state.gamesError ? "Couldn't reach Gemini: " + state.gamesError : "No games are live right now. Check back at game time.";
    wrap.append(note);
  }
  const order = { live: 0, closing: 1, none: 2 };
  const games = [...state.games].sort((x, y) => order[gameState(x)] - order[gameState(y)]);
  if (!games.some((g) => g.id === state.pick)) state.pick = games.find((g) => gameState(g) !== "none")?.id ?? null;
  for (const g of games) {
    const st = gameState(g);
    const card = document.createElement("button");
    card.className = "card glass"; card.setAttribute("role", "option"); card.setAttribute("aria-selected", String(g.id === state.pick));
    card.innerHTML = '<div class="card-top"><span class="league"></span><span class="livetag"><i></i><span></span></span></div><div class="card-title"></div><div class="teams"></div><div class="card-foot"><span></span><span></span></div>';
    card.querySelector(".league").textContent = g.league;
    card.querySelector(".livetag").classList.toggle("quiet", st !== "live");
    card.querySelector(".livetag span").textContent = { live: "LIVE", closing: "CLOSING", none: "NO PRICE" }[st];
    card.classList.toggle("off", st === "none");
    card.querySelector(".card-title").textContent = g.title;
    const teams = card.querySelector(".teams");
    for (const c of g.markets[0].contracts.slice(0, 2)) {
      const row = document.createElement("div"); row.className = "team";
      if (/^#[0-9a-f]{6}$/i.test(c.color ?? "")) row.style.setProperty("--c", c.color);
      const pct = c.bid != null && c.ask != null ? Math.round(((c.bid + c.ask) / 2) * 100) : null;
      row.innerHTML = '<span class="dot"></span><span></span><b></b><div class="bar"><i></i></div>';
      row.children[1].textContent = c.label;
      row.children[2].textContent = pct == null ? "no price" : pct + "%";
      row.querySelector(".bar i").style.width = (pct ?? 0) + "%";
      teams.append(row);
    }
    const foot = card.querySelector(".card-foot");
    foot.children[0].textContent = "$" + Math.round(g.volume24h).toLocaleString() + " traded today";
    foot.children[1].textContent = g.markets.length + (g.markets.length === 1 ? " market" : " markets");
    card.onclick = () => { state.pick = g.id; renderLobby(); };
    card.ondblclick = () => join();
    wrap.append(card);
  }
  const picked = state.games.find((g) => g.id === state.pick);
  const tradable = picked && gameState(picked) !== "none";
  $("joinTitle").textContent = picked ? picked.title : "Choose a game";
  $("joinLabel").textContent = !picked ? "Nothing selected" : tradable ? "Selected" : "No live price right now";
  $("joinBtn").disabled = !tradable;
}

function join() {
  const g = state.games.find((x) => x.id === state.pick);
  if (!g || gameState(g) === "none") return;
  // A short "entering" card so joining feels like stepping into the game.
  const enter = $("enter");
  $("enterTitle").textContent = g.title;
  enter.hidden = false; enter.classList.remove("go"); void enter.offsetWidth; enter.classList.add("go");
  setTimeout(() => { enter.hidden = true; }, reduceMotion ? 0 : 900);
  if (state.game?.id !== g.id) selectGame(g);
  state.joinedAt = performance.now();
  setTimeout(() => setView("game"), reduceMotion ? 0 : 320);
}

function renderSummary() {
  const closed = state.positions.filter((p) => p.status !== "open").sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0));
  const open = state.positions.filter((p) => p.status === "open");
  const sum = (ps, f) => ps.reduce((s, p) => s + f(p), 0);
  const wins = closed.filter((p) => p.status === "won"), misses = closed.filter((p) => p.status === "expired");
  const net = sum(closed, (p) => p.pnl ?? 0);
  let streak = 0, best = 0;
  for (const p of closed) { if (p.status === "won") best = Math.max(best, ++streak); else if (p.status === "expired") streak = 0; }
  const decided = wins.length + misses.length;
  const stats = [
    ["Balance", fmtMoney(state.balance), open.length ? `${fmtMoney(sum(open, (p) => p.cost))} in ${open.length} open` : "nothing open"],
    ["Net profit", fmtSigned(net), `across ${closed.length} settled`, net >= 0 ? "pos" : "neg"],
    ["Hit rate", decided ? Math.round((wins.length / decided) * 100) + "%" : "–", `${wins.length} hit, ${misses.length} timed out`],
    ["Won on hits", fmtMoney(sum(wins, (p) => p.pnl ?? 0)), wins.length ? `biggest ${fmtMoney(Math.max(...wins.map((p) => p.pnl ?? 0)))}` : "no hits yet", "pos"],
    ["Lost on misses", fmtMoney(Math.abs(sum(closed.filter((p) => (p.pnl ?? 0) < 0), (p) => p.pnl))), "exits at market price", "neg"],
    ["Best streak", best ? best + " in a row" : "–", "hits without a miss"],
  ];
  $("stats").replaceChildren(...stats.map(([label, value, sub, tone]) => {
    const el = document.createElement("div"); el.className = "stat glass";
    el.innerHTML = "<span></span><b></b><small></small>";
    el.children[0].textContent = label; el.children[1].textContent = value; el.children[2].textContent = sub;
    if (tone && closed.length) el.children[1].classList.add(tone);
    return el;
  }));
  const recent = $("recent");
  recent.replaceChildren();
  const last = closed.slice(-12).reverse();
  if (!last.length) { recent.innerHTML = '<div class="none">No results yet. Join a game and tap a square.</div>'; }
  for (const p of last) {
    const up = p.side === "yes";
    const row = document.createElement("div"); row.className = "row";
    row.innerHTML = '<div class="main"><div class="title"></div><div class="sub"></div></div><div class="num"></div>';
    row.querySelector(".title").textContent = `${p.label} ${up ? "↑" : "↓"} to ${cents(up ? p.lo : p.hi)}`;
    row.querySelector(".sub").textContent = `${{ won: "Hit", expired: "Timed out", closed: "Closed" }[p.status]} · ${fmtAmt(p.cost)} in at ${cents(p.entry)}, out at ${cents(p.exit)}`;
    const n = row.querySelector(".num"); n.textContent = fmtSigned(p.pnl ?? 0); n.classList.add((p.pnl ?? 0) >= 0 ? "pos" : "neg");
    recent.append(row);
  }
  $("badges").replaceChildren(...BADGES.map(([id, name, how]) => {
    const el = document.createElement("div"); el.className = "badge" + (earned.has(id) ? " on" : "");
    el.innerHTML = "<b></b><span></span>"; el.children[0].textContent = name; el.children[1].textContent = how;
    return el;
  }));
  $("resetBtn").hidden = !backend.reset;
}

async function loadGames(first) {
  try {
    const d = await backend.games();
    state.games = d.games;
    state.gamesError = d.error ?? null;
    state.gamesLoaded = !d.loading;
    if (state.game) state.game = state.games.find((g) => g.id === state.game.id) ?? state.game;
    if (state.view === "lobby") renderLobby();
    if (first && !d.games.length) setTimeout(() => loadGames(true), 3000);
  } catch (err) {
    state.gamesError = err instanceof Error ? err.message : String(err); state.gamesLoaded = true;
    if (state.view === "lobby") renderLobby();
    if (first) setTimeout(() => loadGames(true), 3000);
  }
}

async function init() {
  renderWins();
  const custom = $("customWin");
  custom.addEventListener("change", () => {
    const v = Number(custom.value);
    if (!(v >= 0.5 && v <= 500)) { custom.value = ""; toast("Custom amount must be $0.50 to $500", "err"); renderWins(); return; }
    setWin(Math.round(v * 100) / 100);
  });
  custom.addEventListener("keydown", (e) => { if (e.key === "Enter") custom.blur(); });
  seg($("cols"), COLS, (v) => COL_LABEL[v], () => state.colSec, (v) => { state.colSec = v; });
  const soundBtn = $("soundBtn");
  soundBtn.setAttribute("aria-pressed", String(state.sound));
  soundBtn.onclick = () => {
    state.sound = !state.sound; store.set("tapline.sound", state.sound ? "on" : "off");
    soundBtn.setAttribute("aria-pressed", String(state.sound)); sfx.tap(1.1);
  };
  $("zoomOut").onclick = () => { setZoom(state.zoom / 1.3); sfx.tap(1.02); };
  $("zoomIn").onclick = () => { setZoom(state.zoom * 1.3); sfx.tap(1.02); };
  setZoom(state.zoom);
  $("gameBtn").onclick = () => setView("lobby");
  for (const b of document.querySelectorAll("#views button")) b.onclick = () => setView(b.dataset.view);
  $("joinBtn").onclick = join;
  $("maxBtn").onclick = () => { renderMax(); $("maxDlg").showModal(); };
  $("resetBtn").onclick = async () => {
    if (!backend.reset || !confirm("Reset your paper balance and clear your history?")) return;
    const acct = await backend.reset();
    state.balance = state.balanceShown = acct.balance; state.positions = [];
    $("balance").textContent = fmtMoney(acct.balance); setStreak(0); renderPositions(); renderSummary();
  };
  setView("lobby");
  $("posBtn").onclick = () => { $("posDlg").showModal(); renderPositions(); };
  for (const d of document.querySelectorAll("dialog")) {
    d.addEventListener("click", (e) => { if (e.target === d || e.target.closest("[data-close]")) d.close(); });
  }
  resize();
  requestAnimationFrame(draw);

  await pickBackend();
  const acct = await backend.account();
  state.balance = state.balanceShown = acct.balance; state.limits = acct.limits;
  $("balance").textContent = fmtMoney(acct.balance);
  state.positions = acct.positions.map((p) => ({ ...p, multiple: p.target / p.entry }));
  $("mode").textContent = acct.mode === "paper" ? "PAPER" : "LIVE";
  renderPositions();
  await loadGames(true);
  setInterval(() => loadGames(false), 120_000);
}
init();

// TapLine client: a live odds line on a grid of tappable squares.
// A square is a 1-cent price range and a deadline (its column's right edge).
// Tap above the line to back the odds rising into that square; below, falling.
//
// Hit rule (matches the server): a square above the line is hit when the YES bid
// (bottom of the band) reaches it; a square below when the YES ask (top of the
// band) falls to it. The band is drawn so what you see is what counts.

const $ = (id) => document.getElementById(id);
const fmtMoney = (n) => (n < 0 ? "-" : "") + "$" + Math.abs(n).toFixed(2);
const fmtSigned = (n) => (n >= 0 ? "+" : "-") + "$" + Math.abs(n).toFixed(2);
const cents = (p) => Math.round(p * 100) + "¢";
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rand = (a, b) => a + Math.random() * (b - a);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

let sid = store.get("tapline.sid");
if (!sid) { sid = crypto.randomUUID().replaceAll("-", ""); store.set("tapline.sid", sid); }

const STAKES = [1, 5, 10, 25];
const COLS = [5, 10, 30, 60];
const COL_LABEL = { 5: "5s", 10: "10s", 30: "30s", 60: "1m" };
const MAX_SPREAD = 0.1;
const FONT = '"Space Grotesk", ui-sans-serif, system-ui, sans-serif';
const C = {
  grid: "rgba(110,160,255,0.12)", dot: [150, 195, 255],
  mult: [120, 175, 255], label: "rgba(127,156,207,0.9)",
  tileTop: "#e8fbff", tileBot: "#5ccbff", tileGlow: "rgba(70,185,255,0.95)", tileInk: "#04142e",
  line: "#f4faff", lineGlow: "rgba(90,190,255,0.95)", band: "rgba(120,200,255,",
  win: "#7dffc5", loss: "#ff7d8f", gold: "#ffd166",
};
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

let CELL_W = 80, CELL_H = 74, NOW_AT = 0.34;

const state = {
  games: [], game: null, market: null, contract: null,
  ticks: [], quote: null, shownMid: null, lastMid: null,
  positions: [], balance: 0, balanceShown: 0, limits: null,
  stake: 5, colSec: 10,
  clockSkew: 0, center: null,
  hover: null, ghosts: new Map(),
  fx: [], over: [], marks: [], trail: [], ripples: [],
  shake: 0, flash: 0, flashColor: "125,255,197", headKick: 0,
  streak: 0, lastTick: 0, lastBeat: 0,
  source: null, sound: store.get("tapline.sound") !== "off",
};
const now = () => Date.now() + state.clockSkew;
const drawable = (q) => q && q.bid != null && q.ask != null && q.bid > 0 && q.ask < 1 && q.bid < q.ask && q.ask - q.bid <= MAX_SPREAD;

// ---------- sound: synthesized cues, no audio files ----------
let audio = null, noiseBuf = null;
function ac() {
  if (!state.sound) return null;
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

// ---------- API ----------
async function api(path, body) {
  const res = await fetch(path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sid, ...body }) } : undefined);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "request failed");
  return data;
}

function toast(text, kind = "") {
  const el = document.createElement("div");
  el.className = "toast " + kind;
  el.textContent = text;
  $("toasts").prepend(el);
  while ($("toasts").children.length > 3) $("toasts").lastChild.remove();
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
  if (!q) return null;
  const EPS = 1e-9;
  let side, entry, target;
  if (lo >= q.ask + 0.01 - EPS) { side = "yes"; entry = q.ask; target = lo; }
  else if (hi <= q.bid - 0.01 + EPS) { side = "no"; entry = 1 - q.bid; target = 1 - hi; }
  else return null;
  if (!(entry > 0 && entry < 1 && target > entry && target < 1)) return null;
  return { side, entry, target, multiple: target / entry };
}
/** The price this position could sell at right now, in its own side's terms. */
const sellNow = (p, q) => (p.side === "yes" ? q.bid : 1 - q.ask);

// ---------- canvases ----------
const canvas = $("grid"), ctx = canvas.getContext("2d");
const fxc = $("fx"), fctx = fxc.getContext("2d");
let W = 0, H = 0, FW = 0, FH = 0;

function resize() {
  const dpr = window.devicePixelRatio || 1;
  const r = canvas.getBoundingClientRect();
  W = r.width; H = r.height;
  const narrow = W < 560;
  CELL_W = narrow ? 62 : 80; NOW_AT = narrow ? 0.24 : 0.34;
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
 * A glowing tile centred on (cx, cy).
 * o: { scale, alpha, top, bottom, glow, line1, line2, charge, fromTop, timeLeft, near }
 */
function tile(cx, cy, w, h, o) {
  const alpha = o.alpha ?? 1;
  if (alpha <= 0) return;
  ctx.save();
  ctx.translate(cx, cy); ctx.scale(o.scale ?? 1, o.scale ?? 1); ctx.globalAlpha = alpha;
  const g = ctx.createLinearGradient(0, -h / 2, 0, h / 2);
  g.addColorStop(0, o.top ?? C.tileTop); g.addColorStop(1, o.bottom ?? C.tileBot);
  ctx.shadowColor = o.glow ?? C.tileGlow; ctx.shadowBlur = o.near ? 40 : 26;
  ctx.fillStyle = g; rr(ctx, -w / 2, -h / 2, w, h, 12); ctx.fill();
  ctx.shadowBlur = 0;
  // Charge: fills toward the side the price has to come from.
  if (o.charge > 0) {
    ctx.save(); rr(ctx, -w / 2, -h / 2, w, h, 12); ctx.clip();
    const ch = h * o.charge;
    const cg = ctx.createLinearGradient(0, o.fromTop ? -h / 2 : h / 2, 0, o.fromTop ? -h / 2 + ch : h / 2 - ch);
    cg.addColorStop(0, "rgba(255,255,255,0.85)"); cg.addColorStop(1, "rgba(255,255,255,0.25)");
    ctx.fillStyle = cg;
    ctx.fillRect(-w / 2, o.fromTop ? -h / 2 : h / 2 - ch, w, ch);
    ctx.restore();
  }
  ctx.fillStyle = "rgba(255,255,255,0.32)"; rr(ctx, -w / 2 + 2, -h / 2 + 2, w - 4, h * 0.4, 10); ctx.fill();
  // Text and countdown scale with the tile, which shrinks when the view zooms out.
  const bar = o.timeLeft != null, room = h - (bar ? 7 : 0);
  const f1 = clamp(Math.round(room * 0.36), 12, 17), f2 = clamp(Math.round(room * 0.24), 9, 11);
  const two = o.line2 && room >= 34;
  const top = -h / 2 + (room - (two ? f1 + f2 + 2 : f1)) / 2;
  ctx.fillStyle = C.tileInk; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.font = `700 ${f1}px ${FONT}`; ctx.fillText(o.line1 ?? "", 0, top + f1 / 2);
  if (two) { ctx.globalAlpha = alpha * 0.75; ctx.font = `700 ${f2}px ${FONT}`; ctx.fillText(o.line2, 0, top + f1 + 2 + f2 / 2); }
  // Countdown: a bar along the bottom edge that drains, orange when nearly out.
  if (bar) {
    ctx.globalAlpha = alpha;
    const bw = (w - 16) * clamp(o.timeLeft, 0, 1);
    ctx.fillStyle = "rgba(4,20,46,0.22)"; rr(ctx, -w / 2 + 8, h / 2 - 6, w - 16, 3, 1.5); ctx.fill();
    ctx.fillStyle = o.timeLeft < 0.3 ? "#ff7a1a" : "#04142e"; rr(ctx, -w / 2 + 8, h / 2 - 6, bw, 3, 1.5); ctx.fill();
  }
  ctx.restore();
}

function drawBandAndLine(pts, nowX, headY, q) {
  if (!pts.length) return;
  // Band: bid to ask over time. Hits are judged on its edges, not the middle line.
  ctx.beginPath();
  for (let i = 0; i < pts.length; i++) {
    const x0 = xOf(pts[i].t), x1 = i + 1 < pts.length ? xOf(pts[i + 1].t) : nowX;
    if (x1 < -40) continue;
    ctx.rect(x0, yOf(pts[i].ask), x1 - x0, yOf(pts[i].bid) - yOf(pts[i].ask));
  }
  ctx.fillStyle = C.band + "0.10)"; ctx.fill();

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
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  ctx.strokeStyle = C.lineGlow; ctx.lineWidth = 9; ctx.globalAlpha = 0.22; ctx.stroke();
  ctx.globalAlpha = 1; ctx.strokeStyle = C.line; ctx.lineWidth = 2.6;
  ctx.shadowColor = C.lineGlow; ctx.shadowBlur = 16; ctx.stroke(); ctx.shadowBlur = 0;

  // Project today's bid and ask across the future so each square shows how far it is.
  ctx.setLineDash([2, 6]); ctx.lineWidth = 1.2;
  for (const [p, label] of [[q.ask, "ask " + cents(q.ask)], [q.bid, "bid " + cents(q.bid)]]) {
    const y = yOf(p);
    ctx.strokeStyle = C.band + "0.55)";
    ctx.beginPath(); ctx.moveTo(nowX, y); ctx.lineTo(W - 44, y); ctx.stroke();
  }
  ctx.setLineDash([]);
}

function draw(frame) {
  requestAnimationFrame(draw);
  if (!W || !H) return;
  ctx.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  drawOverlay(frame);
  const q = state.quote;
  if (!q) return;

  // Camera shake after a win.
  if (state.shake > 0.3 && !reduceMotion) ctx.translate(rand(-state.shake, state.shake), rand(-state.shake, state.shake));
  state.shake *= 0.86;

  // Zoom to the spread: as close as possible while keeping ~4 tappable rows each side on screen.
  const maxH = W < 560 ? 68 : 84;
  const fitH = clamp(H / (Math.round((q.ask - q.bid) * 100) + 9), 30, maxH);
  CELL_H = state.center === null || reduceMotion ? fitH : CELL_H + (fitH - CELL_H) * 0.06;

  const mid = (q.bid + q.ask) / 2;
  if (state.center === null) { state.center = mid; state.shownMid = mid; }
  state.center += (mid - state.center) * 0.03;
  state.shownMid += (mid - state.shownMid) * (reduceMotion ? 1 : 0.18);
  state.headKick *= 0.9;

  const t = now(), nowX = W * NOW_AT;
  const col0 = Math.floor(tOf(0) / colMs()), col1 = Math.floor(tOf(W) / colMs());
  const row0 = Math.max(1, Math.floor(pOf(H) * 100)), row1 = Math.min(98, Math.floor(pOf(0) * 100));
  const minLead = state.limits?.minLeadMs ?? 3000;
  const headY = yOf(state.shownMid);

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
    ctx.fillStyle = "rgba(127,220,255,0.06)";
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
      const hot = hv && hv.col === c && hv.row === r;
      if (hot) {
        ctx.save();
        ctx.shadowColor = C.tileGlow; ctx.shadowBlur = 24;
        ctx.strokeStyle = "rgba(200,240,255,0.95)"; ctx.lineWidth = 1.5;
        ctx.fillStyle = "rgba(127,220,255,0.18)";
        rr(ctx, cx - CELL_W / 2 + 4, cy - CELL_H / 2 + 4, CELL_W - 8, CELL_H - 8, 12); ctx.fill(); ctx.stroke();
        ctx.restore();
        ctx.fillStyle = "#ffffff"; ctx.font = `700 16px ${FONT}`;
        ctx.fillText(plan.multiple.toFixed(2) + "x", cx, cy - 9);
        const qty = Math.floor((state.stake / plan.entry) * 100) / 100;
        ctx.fillStyle = C.win; ctx.font = `700 12px ${FONT}`;
        ctx.fillText("+" + fmtMoney(qty * (plan.target - plan.entry)), cx, cy + 11);
      } else {
        // Bigger payouts read brighter; squares near the price shimmer.
        const heat = clamp((plan.multiple - 1) / 0.4, 0, 1);
        const near = clamp(1 - Math.abs((r + 0.5) / 100 - mid) / 0.06, 0, 1);
        const shimmer = reduceMotion ? 0 : near * 0.25 * (0.5 + 0.5 * Math.sin(frame / 260 + c * 0.9));
        const [cr, cg, cb] = C.mult;
        ctx.fillStyle = `rgba(${cr + (255 - cr) * heat * 0.6},${cg + (255 - cg) * heat * 0.6},${cb},${clamp((0.4 + 0.5 * heat + shimmer) * fadeIn, 0, 1)})`;
        ctx.font = `${heat > 0.5 ? 700 : 600} 13px ${FONT}`;
        ctx.fillText(plan.multiple.toFixed(2) + "X", cx, cy);
      }
    }
  }

  // price scale and time labels
  ctx.font = `600 11px ${FONT}`; ctx.textAlign = "right";
  for (let r = row0; r <= row1 + 1; r++) { ctx.fillStyle = C.label; ctx.fillText(cents(r / 100), W - 6, yOf(r / 100) - 10); }
  ctx.textAlign = "center";
  const every = Math.max(1, Math.ceil(90 / CELL_W));
  for (let c = col0; c <= col1 + 1; c++) {
    const ts = c * colMs();
    if (ts <= t || c % every) continue;
    const d = new Date(ts - state.clockSkew);
    ctx.fillStyle = C.label;
    ctx.fillText(d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: state.colSec < 60 ? "2-digit" : undefined }), xOf(ts), H - 9);
  }

  // band, line, projected bid/ask
  drawBandAndLine(state.ticks, nowX, headY, q);

  // comet trail off the head
  if (!reduceMotion && frame % 2 < 1 + (state.headKick > 0.2 ? 1 : 0)) {
    state.trail.push({ t: t, p: state.shownMid + rand(-0.0012, 0.0012), born: frame, life: rand(700, 1300), s: rand(1, 2.6) });
    if (state.trail.length > 160) state.trail.splice(0, state.trail.length - 160);
  }
  state.trail = state.trail.filter((d) => frame - d.born < d.life);
  for (const d of state.trail) {
    const k = (frame - d.born) / d.life;
    ctx.fillStyle = `rgba(170,225,255,${(1 - k) * 0.55})`;
    ctx.beginPath(); ctx.arc(xOf(d.t), yOf(d.p) + k * rand(-3, 3), d.s * (1 - k * 0.6), 0, Math.PI * 2); ctx.fill();
  }

  // head: pulse ring, kick on each price change
  const pulse = reduceMotion ? 0.5 : (Math.sin(frame / 300) + 1) / 2;
  const kick = state.headKick;
  ctx.strokeStyle = `rgba(160,225,255,${0.55 - pulse * 0.4})`; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(nowX, headY, 8 + pulse * 10 + kick * 14, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = "#fff"; ctx.shadowColor = C.lineGlow; ctx.shadowBlur = 20 + kick * 30;
  ctx.beginPath(); ctx.arc(nowX, headY, 5 + kick * 4, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;

  // win markers pinned to the line where each hit happened
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  for (const m of state.marks) {
    if (m.symbol !== state.contract?.symbol) continue;
    const x = xOf(m.t), y = yOf(m.price);
    if (x < -60) continue;
    ctx.fillStyle = C.win; ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill();
    ctx.font = `700 11px ${FONT}`;
    const tw = ctx.measureText(m.text).width + 14;
    ctx.fillStyle = "rgba(125,255,197,0.16)"; ctx.strokeStyle = "rgba(125,255,197,0.7)"; ctx.lineWidth = 1;
    rr(ctx, x - tw / 2, y - 30, tw, 19, 10); ctx.fill(); ctx.stroke();
    ctx.fillStyle = C.win; ctx.fillText(m.text, x, y - 20.5);
  }
  state.marks = state.marks.filter((m) => xOf(m.t) > -80);

  // quote readout beside the head
  ctx.textAlign = "left"; ctx.font = `700 13px ${FONT}`;
  const readout = cents(q.bid) + " / " + cents(q.ask), rw = ctx.measureText(readout).width + 16;
  ctx.fillStyle = "rgba(8,20,48,0.85)"; ctx.strokeStyle = "rgba(140,200,255,0.45)"; ctx.lineWidth = 1;
  rr(ctx, nowX + 18, headY - 11, rw, 22, 11); ctx.fill(); ctx.stroke();
  ctx.fillStyle = "#fff"; ctx.fillText(readout, nowX + 26, headY + 0.5);

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
    tile(x + w / 2 + jx, y + CELL_H / 2 + jy, w - 8, CELL_H - 8, {
      scale: s, alpha: flick, charge, fromTop: p.side === "no", timeLeft: left, near,
      line1: "$" + Math.round(p.cost), line2: near ? "1¢ AWAY" : (p.multiple ? p.multiple.toFixed(2) + "X" : ""),
    });
  }
  for (const [key, g] of state.ghosts) {
    const [c, r] = key.split(":").map(Number);
    const age = clamp((frame - g.bornAt) / 220, 0, 1);
    tile(xOf(c * colMs()) + CELL_W / 2, yOf((r + 1) / 100) + CELL_H / 2, CELL_W - 8, CELL_H - 8, {
      scale: reduceMotion ? 1 : 1.35 - 0.35 * easeOutBack(age), alpha: 0.85, line1: "$" + g.stake, line2: g.multiple.toFixed(2) + "X",
    });
  }
  // Heartbeat and countdown ticks for the most urgent tile only, so it never turns to noise.
  if (tension) {
    const left = tension.deadline - t;
    const gap = Math.max(0, tension.target - sellNow(tension, q));
    if (gap <= 0.01 + 1e-9 && frame - state.lastBeat > 950) { state.lastBeat = frame; sfx.beat(); buzz([18, 90, 18]); }
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
      tile(x, y, f.w, f.h, { scale: 1 + easeOut(k) * 0.6, alpha: 1 - k, top: "#ffffff", bottom: f.win ? "#b6ffe0" : "#ffb3bd", glow: f.win ? "rgba(125,255,197,1)" : "rgba(255,125,143,0.9)" });
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
}

/** Full-screen layer: flash, coins flying to the balance, confetti. */
function drawOverlay(frame) {
  fctx.clearRect(0, 0, FW, FH);
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
      fctx.shadowColor = "rgba(125,255,197,1)"; fctx.shadowBlur = 16;
      fctx.fillStyle = "#c9ffe8"; fctx.beginPath(); fctx.arc(0, 0, 6, 0, Math.PI * 2); fctx.fill();
      fctx.fillStyle = "#7dffc5"; fctx.beginPath(); fctx.arc(0, 0, 3.5, 0, Math.PI * 2); fctx.fill();
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
  state.fx.push({ kind: "ring", t0, life: 450, time, price, rgb: "170,230,255", size: 46, r0: 18, width: 3 });
  if (!reduceMotion) for (let i = 0; i < 8; i++) state.fx.push({ kind: "spark", t0, life: rand(300, 500), time, price, a: rand(0, Math.PI * 2), dist: rand(26, 50), rgb: "190,240,255", g: 0, s: 2 });
  ripple(xOf(time), yOf(price), 220, 700);
}

function priceFx(up) {
  const t0 = performance.now(), time = now(), price = state.shownMid;
  state.headKick = 1;
  const rgb = up ? "125,255,197" : "255,125,143";
  state.fx.push({ kind: "ring", t0, life: 600, time, price, rgb, size: 44, r0: 8, width: 2.5 });
  if (!reduceMotion) for (let i = 0; i < 10; i++) state.fx.push({ kind: "spark", t0, life: rand(400, 700), time, price, a: up ? rand(-Math.PI * 0.9, -Math.PI * 0.1) : rand(Math.PI * 0.1, Math.PI * 0.9), dist: rand(20, 46), rgb, g: up ? -10 : 20, s: 2.2 });
  ripple(W * NOW_AT, yOf(price), 340, 1100);
}

function winFx(p, big) {
  const span = p.colMs ?? colMs();
  const time = p.deadline - span / 2, price = (p.lo + p.hi) / 2, t0 = performance.now();
  state.fx.push({ kind: "burst", t0, life: 650, time, price, w: CELL_W - 8, h: CELL_H - 8, win: true });
  state.fx.push({ kind: "ring", t0, life: 700, time, price, rgb: "125,255,197", size: big ? 150 : 100, r0: 24, width: 4 });
  state.fx.push({ kind: "ring", t0: t0 + 90, life: 800, time, price, rgb: "200,255,235", size: big ? 220 : 150, r0: 24, width: 2, a: 0.7 });
  if (!reduceMotion) for (let i = 0; i < (big ? 34 : 22); i++) state.fx.push({ kind: "spark", t0, life: rand(500, 950), time, price, a: rand(0, Math.PI * 2), dist: rand(40, big ? 140 : 100), rgb: i % 3 ? "170,255,220" : "255,240,180", s: 3 });
  state.fx.push({ kind: "text", t0, life: 1600, time, price, dy: -6, text: fmtSigned(p.pnl), size: big ? 34 : 28, color: C.win, rise: 70 });
  ripple(xOf(time), yOf(price), big ? 520 : 380, 1300);
  if (reduceMotion) return;
  state.shake = big ? 9 : 5;
  state.flash = big ? 0.28 : 0.16; state.flashColor = "125,255,197";
  // Coins fly from the tile to the balance.
  const gr = canvas.getBoundingClientRect(), wr = $("wallet").getBoundingClientRect();
  const x0 = gr.left + xOf(time), y0 = gr.top + yOf(price), x1 = wr.left + wr.width * 0.6, y1 = wr.top + wr.height / 2;
  const n = big ? 14 : 9;
  for (let i = 0; i < n; i++) {
    state.over.push({ kind: "coin", i, t0: t0 + 120 + i * 45, life: 650 + rand(-80, 80), x0: x0 + rand(-14, 14), y0: y0 + rand(-10, 10), cx: (x0 + x1) / 2 + rand(-120, 120), cy: Math.min(y0, y1) - rand(60, 180), x1, y1 });
  }
  if (big) {
    const colors = ["#7dffc5", "#7fdcff", "#ffd166", "#ffffff", "#b38cff"];
    for (let i = 0; i < 90; i++) state.over.push({ kind: "confetti", t0, life: rand(1200, 2000), x: x0, y: y0, vx: rand(-1.2, 1.2), vy: rand(-1.5, -0.3), rot: rand(0, 6), spin: rand(-12, 12), color: colors[i % colors.length] });
  }
}

function missFx(p) {
  const span = p.colMs ?? colMs();
  const time = p.deadline - span / 2, price = (p.lo + p.hi) / 2, t0 = performance.now();
  state.fx.push({ kind: "burst", t0, life: 380, time, price, w: CELL_W - 8, h: CELL_H - 8, win: false });
  if (!reduceMotion) for (let i = 0; i < 12; i++) state.fx.push({ kind: "shard", t0, life: rand(600, 900), time, price, vx: rand(-1.4, 1.4), vy: rand(-1.6, -0.2), rot: rand(-6, 6), s: rand(5, 11), color: i % 2 ? "rgba(140,200,255,0.9)" : "rgba(255,140,160,0.85)" });
  state.fx.push({ kind: "text", t0, life: 1200, time, price, text: fmtSigned(p.pnl), size: 18, color: p.pnl >= 0 ? C.win : C.loss, rise: 36 });
  if (!reduceMotion) { state.shake = 2.5; state.flash = 0.06; state.flashColor = "255,125,143"; }
}

// ---------- input ----------
function pointer(e) {
  const r = canvas.getBoundingClientRect();
  return boxAt(e.clientX - r.left, e.clientY - r.top);
}
canvas.addEventListener("pointermove", (e) => { state.hover = e.pointerType === "touch" ? null : pointer(e); });
canvas.addEventListener("pointerleave", () => { state.hover = null; });
canvas.addEventListener("pointerup", async (e) => {
  hideCoach();
  const box = pointer(e);
  if (!box || !state.contract) { if (state.quote) { sfx.deny(); buzz(6); } return; }
  const key = box.col + ":" + box.row;
  if (state.ghosts.has(key)) return;
  const span = colMs(), symbol = state.contract.symbol;
  state.ghosts.set(key, { bornAt: performance.now(), stake: state.stake, multiple: box.plan.multiple });
  sfx.tap(box.plan.multiple); buzz(12); tapFx(box);
  try {
    const { position } = await api("/api/tap", { symbol, lo: box.lo, hi: box.hi, deadline: box.deadline, stake: state.stake });
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
      b.onclick = async () => { try { await api("/api/close", { id: p.id }); } catch (err) { toast(err.message, "err"); } };
      row.append(b);
    } else {
      const n = document.createElement("div"); n.className = "num " + (p.pnl >= 0 ? "pos" : "neg"); n.textContent = fmtSigned(p.pnl);
      row.append(n);
    }
    list.append(row);
  }
}

function onPositionEvent({ position, balance }) {
  const before = state.positions.find((x) => x.id === position.id);
  state.balance = balance;
  upsertPosition(position);
  if (position.status === "open" || (before && before.status !== "open")) return;
  const p = { ...before, ...position };
  showDelta(position.pnl);
  if (position.status === "won") {
    setStreak(state.streak + 1);
    const big = position.pnl >= 1 || state.streak >= 3;
    winFx(p, big);
    sfx.win(state.streak, big); buzz(big ? [25, 40, 25, 40, 25, 40, 80] : [20, 40, 20, 40, 50]);
    state.marks.push({ symbol: p.symbol, t: now(), price: p.side === "yes" ? p.lo : p.hi, text: fmtSigned(position.pnl) });
    toast(`You won ${fmtMoney(position.pnl)}`, "win");
  } else {
    if (position.status === "expired") setStreak(0);
    missFx(p); sfx.miss(); buzz(40);
    const short = Math.round((p.target - (p.best ?? 0)) * 100);
    const why = position.status === "closed" ? "Closed" : short > 0 && short < 50 ? `Missed by ${short}¢` : "Timed out";
    toast(`${why} · ${fmtSigned(position.pnl)}`, position.pnl >= 0 ? "win" : "loss");
  }
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
  while (box.children.length > 4) box.lastChild.remove();
  setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 420); }, 6000);
  const dot = document.querySelector(".live");
  if (dot) { dot.style.transform = "scale(1.8)"; setTimeout(() => (dot.style.transform = ""), 180); }
}

// ---------- stream ----------
function openStream() {
  state.source?.close();
  state.ticks = []; state.quote = null; state.center = null; state.hover = null; state.lastMid = null; state.trail = [];
  const c = state.contract;
  if (!c) return;
  const src = new EventSource(`/api/stream?sid=${sid}&symbol=${encodeURIComponent(c.symbol)}&game=${encodeURIComponent(state.game?.id ?? "")}`);
  state.source = src;
  const mine = () => state.source === src;
  src.addEventListener("history", (e) => {
    if (!mine()) return;
    const d = JSON.parse(e.data);
    state.clockSkew = d.now - Date.now();
    state.ticks = d.ticks;
    const last = d.ticks.at(-1);
    if (last) { state.quote = { bid: last.bid, ask: last.ask }; state.lastMid = (last.bid + last.ask) / 2; }
    $("empty").hidden = !!last;
    if (!last) $("empty").textContent = "Waiting for a live price on this contract…";
    else maybeCoach();
  });
  src.addEventListener("quote", (e) => {
    if (!mine()) return;
    const d = JSON.parse(e.data);
    if (!drawable(d)) return; // one-sided or gapped: the server still uses it for fills
    state.quote = { bid: d.bid, ask: d.ask };
    const lastTick = state.ticks.at(-1);
    if (!lastTick || lastTick.bid !== d.bid || lastTick.ask !== d.ask) state.ticks.push(d);
    const mid = (d.bid + d.ask) / 2;
    if (state.lastMid !== null && Math.abs(mid - state.lastMid) >= 0.005 - 1e-9) {
      const up = mid > state.lastMid;
      priceFx(up); up ? sfx.priceUp() : sfx.priceDown(); buzz(5);
    }
    state.lastMid = mid;
    $("empty").hidden = true;
    updateChipPrice(c.symbol, d);
  });
  src.addEventListener("move", (e) => mine() && onMove(JSON.parse(e.data)));
  src.addEventListener("position", (e) => mine() && onPositionEvent(JSON.parse(e.data)));
  src.addEventListener("ping", (e) => { if (mine()) state.clockSkew = JSON.parse(e.data).now - Date.now(); });
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
  const quoted = m.contracts.filter((c) => c.bid != null && c.ask != null);
  const score = (c) => Math.abs((c.bid + c.ask) / 2 - 0.5) + (c.ask - c.bid) * 2;
  quoted.sort((a, b) => score(a) - score(b));
  state.market = m;
  selectContract(quoted[0] ?? m.contracts[0]);
}
function selectGame(g) { state.game = g; selectMarket(g.markets[0]); }

function renderGameList() {
  const list = $("gameList");
  list.replaceChildren();
  if (!state.games.length) { list.innerHTML = '<div class="none">No live games right now.</div>'; return; }
  for (const g of state.games) {
    const b = document.createElement("button"); b.className = "row";
    b.innerHTML = '<div class="main"><div class="title"></div><div class="sub"></div></div><div class="num sub"></div>';
    b.querySelector(".title").textContent = g.title;
    b.querySelector(".main .sub").textContent = `${g.league} · ${g.markets.length} market${g.markets.length === 1 ? "" : "s"}`;
    b.querySelector(".num").textContent = "$" + Math.round(g.volume24h).toLocaleString() + " today";
    b.onclick = () => { selectGame(g); $("gameDlg").close(); };
    list.append(b);
  }
}

async function loadGames(first) {
  try {
    const d = await api("/api/games");
    state.games = d.games;
    if (first && !d.games.length) {
      $("empty").textContent = d.error ? "Couldn't reach Gemini: " + d.error : "Loading live games from Gemini…";
      setTimeout(() => loadGames(true), 2500);
      return;
    }
    if (!state.game && d.games.length) selectGame(d.games[0]);
  } catch {
    if (first) { $("empty").textContent = "Couldn't load games. Retrying…"; setTimeout(() => loadGames(true), 3000); }
  }
}

async function init() {
  seg($("stakes"), STAKES, (v) => "$" + v, () => state.stake, (v) => { state.stake = v; });
  seg($("cols"), COLS, (v) => COL_LABEL[v], () => state.colSec, (v) => { state.colSec = v; });
  const soundBtn = $("soundBtn");
  soundBtn.setAttribute("aria-pressed", String(state.sound));
  soundBtn.onclick = () => {
    state.sound = !state.sound; store.set("tapline.sound", state.sound ? "on" : "off");
    soundBtn.setAttribute("aria-pressed", String(state.sound)); sfx.tap(1.1);
  };
  $("gameBtn").onclick = () => { renderGameList(); $("gameDlg").showModal(); };
  $("posBtn").onclick = () => { $("posDlg").showModal(); renderPositions(); };
  for (const d of document.querySelectorAll("dialog")) {
    d.addEventListener("click", (e) => { if (e.target === d || e.target.closest("[data-close]")) d.close(); });
  }
  resize();
  requestAnimationFrame(draw);

  const acct = await api(`/api/account?sid=${sid}`);
  state.balance = state.balanceShown = acct.balance; state.limits = acct.limits;
  $("balance").textContent = fmtMoney(acct.balance);
  state.positions = acct.positions.map((p) => ({ ...p, multiple: p.target / p.entry }));
  $("mode").textContent = acct.mode === "paper" ? "PAPER" : "LIVE";
  renderPositions();
  await loadGames(true);
  setInterval(() => loadGames(false), 120_000);
}
init();

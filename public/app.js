// TapLine client: a live odds line on a grid of tappable squares.
// A square is a 1-cent price range and a deadline (its column's right edge).
// Tap above the line to back the odds rising into that square; below, falling.

const $ = (id) => document.getElementById(id);
const fmtMoney = (n) => (n < 0 ? "-" : "") + "$" + Math.abs(n).toFixed(2);
const fmtSigned = (n) => (n >= 0 ? "+" : "-") + "$" + Math.abs(n).toFixed(2);
const cents = (p) => Math.round(p * 100) + "¢";
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

let sid = store.get("tapline.sid");
if (!sid) { sid = crypto.randomUUID().replaceAll("-", ""); store.set("tapline.sid", sid); }

const STAKES = [1, 5, 10, 25];
const COLS = [15, 30, 60, 300];
const COL_LABEL = { 15: "15s", 30: "30s", 60: "1m", 300: "5m" };
const FONT = '"Space Grotesk", ui-sans-serif, system-ui, sans-serif';
const C = {
  grid: "rgba(110,160,255,0.13)", dot: "rgba(140,190,255,0.42)",
  mult: [120, 175, 255], label: "rgba(127,156,207,0.9)",
  tileTop: "#e2f9ff", tileBot: "#62d0ff", tileGlow: "rgba(70,185,255,0.95)", tileInk: "#04142e",
  line: "#f2f9ff", lineGlow: "rgba(90,190,255,0.9)",
  win: "#7dffc5", loss: "#ff7d8f",
};
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

let CELL_W = 68, CELL_H = 58, NOW_AT = 0.36;

const state = {
  games: [], game: null, market: null, contract: null,
  ticks: [], quote: null, shownMid: null,
  positions: [], balance: 0, limits: null,
  stake: 5, colSec: 30,
  clockSkew: 0, center: null,
  hover: null, ghosts: new Map(), fx: [], marks: [],
  source: null, sound: store.get("tapline.sound") !== "off",
};
const now = () => Date.now() + state.clockSkew;

// ---------- sound: small synthesized cues, no audio files ----------
let audio = null;
function tone(freq, to, dur, type = "sine", gain = 0.08, delay = 0) {
  if (!state.sound) return;
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === "suspended") audio.resume();
    const t0 = audio.currentTime + delay;
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t0);
    if (to) o.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(audio.destination); o.start(t0); o.stop(t0 + dur + 0.02);
  } catch {}
}
const sfx = {
  tap: () => tone(520, 880, 0.09, "triangle", 0.07),
  win: () => { tone(660, 0, 0.16, "triangle", 0.09); tone(990, 0, 0.18, "triangle", 0.09, 0.08); tone(1320, 0, 0.28, "sine", 0.07, 0.16); },
  out: () => tone(220, 130, 0.18, "sine", 0.06),
  deny: () => tone(180, 150, 0.1, "square", 0.03),
};

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

// ---------- canvas ----------
const canvas = $("grid");
const ctx = canvas.getContext("2d");
let W = 0, H = 0;

function resize() {
  const r = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  W = r.width; H = r.height;
  const narrow = W < 560;
  CELL_W = narrow ? 58 : 68; CELL_H = narrow ? 52 : 58; NOW_AT = narrow ? 0.26 : 0.36;
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
new ResizeObserver(resize).observe(canvas);

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

function rr(x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
}

/** A glowing tile centred on (cx, cy). */
function tile(cx, cy, w, h, scale, alpha, top, bottom, glow, line1, line2) {
  if (alpha <= 0) return;
  ctx.save();
  ctx.translate(cx, cy); ctx.scale(scale, scale); ctx.globalAlpha = alpha;
  const g = ctx.createLinearGradient(0, -h / 2, 0, h / 2);
  g.addColorStop(0, top); g.addColorStop(1, bottom);
  ctx.shadowColor = glow; ctx.shadowBlur = 26;
  ctx.fillStyle = g; rr(-w / 2, -h / 2, w, h, 11); ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = "rgba(255,255,255,0.35)"; rr(-w / 2 + 2, -h / 2 + 2, w - 4, h * 0.42, 9); ctx.fill();
  ctx.fillStyle = C.tileInk; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.font = `700 15px ${FONT}`; ctx.fillText(line1, 0, line2 ? -7 : 0);
  if (line2) { ctx.globalAlpha = alpha * 0.7; ctx.font = `600 11px ${FONT}`; ctx.fillText(line2, 0, 10); }
  ctx.restore();
}

function drawLine(pts, nowX, headY) {
  // Prices move in 1-cent steps; ease each step into a short S-curve so the line flows.
  ctx.beginPath();
  let started = false, prevY = 0;
  for (let i = 0; i < pts.length; i++) {
    const x = xOf(pts[i].t), y = yOf((pts[i].bid + pts[i].ask) / 2);
    const nextX = i + 1 < pts.length ? xOf(pts[i + 1].t) : nowX;
    if (nextX < -40) { prevY = y; continue; }
    if (!started) { ctx.moveTo(Math.max(x, -40), y); started = true; }
    else {
      const r = Math.min(12, (nextX - x) / 2);
      ctx.bezierCurveTo(x, prevY, x, y, x + Math.max(r, 0.01), y);
    }
    const last = i + 1 === pts.length;
    if (!last) ctx.lineTo(Math.max(nextX - Math.min(12, (nextX - x) / 2), x), y);
    else { ctx.lineTo(Math.max(nowX - 14, x), y); ctx.bezierCurveTo(nowX - 6, y, nowX - 6, headY, nowX, headY); }
    prevY = y;
  }
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  ctx.strokeStyle = C.lineGlow; ctx.lineWidth = 7; ctx.globalAlpha = 0.25; ctx.stroke();
  ctx.globalAlpha = 1; ctx.strokeStyle = C.line; ctx.lineWidth = 2.2;
  ctx.shadowColor = C.lineGlow; ctx.shadowBlur = 14; ctx.stroke(); ctx.shadowBlur = 0;
}

function draw(frame) {
  requestAnimationFrame(draw);
  if (!W || !H) return;
  ctx.clearRect(0, 0, W, H);
  const q = state.quote;
  if (!q) return;

  const mid = (q.bid + q.ask) / 2;
  if (state.center === null) { state.center = mid; state.shownMid = mid; }
  state.center += (mid - state.center) * 0.035;
  state.shownMid += (mid - state.shownMid) * (reduceMotion ? 1 : 0.14);

  const t = now(), nowX = W * NOW_AT;
  const col0 = Math.floor(tOf(0) / colMs()), col1 = Math.floor(tOf(W) / colMs());
  const row0 = Math.max(1, Math.floor(pOf(H) * 100)), row1 = Math.min(98, Math.floor(pOf(0) * 100));
  const minLead = state.limits?.minLeadMs ?? 3000;

  // spread band: the rows the bid and ask sit in can't be tapped
  ctx.fillStyle = "rgba(120,180,255,0.05)";
  ctx.fillRect(nowX, yOf(q.ask), W - nowX, yOf(q.bid) - yOf(q.ask));

  // grid lines and intersection dots
  ctx.strokeStyle = C.grid; ctx.lineWidth = 1; ctx.beginPath();
  for (let r = row0; r <= row1 + 1; r++) { const y = Math.round(yOf(r / 100)) + 0.5; ctx.moveTo(0, y); ctx.lineTo(W, y); }
  for (let c = col0; c <= col1 + 1; c++) { const x = Math.round(xOf(c * colMs())) + 0.5; ctx.moveTo(x, 0); ctx.lineTo(x, H); }
  ctx.stroke();
  ctx.fillStyle = C.dot;
  for (let c = col0; c <= col1 + 1; c++) {
    const x = xOf(c * colMs());
    for (let r = row0; r <= row1 + 1; r++) ctx.fillRect(x - 1.5, yOf(r / 100) - 1.5, 3, 3);
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
      if (cy < 12 || cy > H - 30) continue; // don't draw labels cut off by the edges or under the clock
      const hot = hv && hv.col === c && hv.row === r;
      if (hot) {
        ctx.save();
        ctx.shadowColor = C.tileGlow; ctx.shadowBlur = 22;
        ctx.strokeStyle = "rgba(190,238,255,0.95)"; ctx.lineWidth = 1.5;
        ctx.fillStyle = "rgba(127,220,255,0.16)";
        rr(cx - CELL_W / 2 + 3, cy - CELL_H / 2 + 3, CELL_W - 6, CELL_H - 6, 11); ctx.fill(); ctx.stroke();
        ctx.restore();
        ctx.fillStyle = "#ffffff"; ctx.font = `700 14px ${FONT}`;
        ctx.fillText(plan.multiple.toFixed(2) + "x", cx, cy - 8);
        const qty = Math.floor((state.stake / plan.entry) * 100) / 100;
        ctx.fillStyle = C.win; ctx.font = `600 11px ${FONT}`;
        ctx.fillText("+" + fmtMoney(qty * (plan.target - plan.entry)), cx, cy + 9);
      } else {
        // Bigger payouts read brighter.
        const heat = clamp((plan.multiple - 1) / 0.4, 0, 1);
        const [cr, cg, cb] = C.mult;
        ctx.fillStyle = `rgba(${cr + (255 - cr) * heat * 0.6},${cg + (255 - cg) * heat * 0.6},${cb},${(0.42 + 0.58 * heat) * fadeIn})`;
        ctx.font = `${heat > 0.5 ? 700 : 600} 12px ${FONT}`;
        ctx.fillText(plan.multiple.toFixed(2) + "X", cx, cy);
      }
    }
  }

  // price scale and time labels
  ctx.font = `600 11px ${FONT}`; ctx.textAlign = "right";
  for (let r = row0; r <= row1 + 1; r++) { ctx.fillStyle = C.label; ctx.fillText(cents(r / 100), W - 6, yOf(r / 100) - 9); }
  ctx.textAlign = "center";
  const every = state.colSec < 60 ? Math.ceil(84 / CELL_W) : 1;
  for (let c = col0; c <= col1 + 1; c++) {
    const ts = c * colMs();
    if (ts <= t || c % every) continue;
    const d = new Date(ts - state.clockSkew);
    ctx.fillStyle = C.label;
    ctx.fillText(d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: state.colSec < 60 ? "2-digit" : undefined }), xOf(ts), H - 9);
  }

  // the line and its head
  const headY = yOf(state.shownMid);
  if (state.ticks.length) drawLine(state.ticks, nowX, headY);
  const pulse = reduceMotion ? 0.5 : (Math.sin(frame / 320) + 1) / 2;
  ctx.strokeStyle = `rgba(160,225,255,${0.5 - pulse * 0.4})`; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(nowX, headY, 7 + pulse * 9, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = "#fff"; ctx.shadowColor = C.lineGlow; ctx.shadowBlur = 18;
  ctx.beginPath(); ctx.arc(nowX, headY, 4.5, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;

  // win markers pinned to the line where each hit happened
  ctx.textAlign = "center";
  for (const m of state.marks) {
    if (m.symbol !== state.contract?.symbol) continue;
    const x = xOf(m.t), y = yOf(m.price);
    if (x < -60) continue;
    ctx.fillStyle = C.win; ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
    ctx.font = `700 11px ${FONT}`;
    const tw = ctx.measureText(m.text).width + 12;
    ctx.fillStyle = "rgba(125,255,197,0.14)"; ctx.strokeStyle = "rgba(125,255,197,0.6)"; ctx.lineWidth = 1;
    rr(x - tw / 2, y - 28, tw, 18, 9); ctx.fill(); ctx.stroke();
    ctx.fillStyle = C.win; ctx.fillText(m.text, x, y - 19);
  }
  state.marks = state.marks.filter((m) => xOf(m.t) > -80);

  // quote readout beside the head
  ctx.textAlign = "left"; ctx.font = `700 13px ${FONT}`;
  const readout = cents(q.bid) + " / " + cents(q.ask), rw = ctx.measureText(readout).width + 16;
  ctx.fillStyle = "rgba(8,20,48,0.85)"; ctx.strokeStyle = "rgba(140,200,255,0.45)"; ctx.lineWidth = 1;
  rr(nowX + 16, headY - 11, rw, 22, 11); ctx.fill(); ctx.stroke();
  ctx.fillStyle = "#fff"; ctx.fillText(readout, nowX + 24, headY + 0.5);

  // open positions as glowing tiles, plus taps still on their way to the server
  for (const p of state.positions) {
    if (p.status !== "open" || p.symbol !== state.contract?.symbol) continue;
    const span = p.colMs ?? colMs();
    const w = (span / colMs()) * CELL_W, x = xOf(p.deadline - span), y = yOf(p.hi);
    if (x + w < -20 || x > W + 20) continue;
    const age = p.bornAt ? (frame - p.bornAt) / 240 : 1;
    const s = reduceMotion ? 1 : age < 1 ? 0.55 + 0.45 * easeOutBack(clamp(age, 0, 1)) : 1;
    // Flicker as the deadline closes in.
    const left = (p.deadline - t) / span;
    const urgency = left < 0.35 && !reduceMotion ? 0.82 + 0.18 * Math.sin(frame / 70) : 1;
    tile(x + w / 2, y + CELL_H / 2, w - 6, CELL_H - 6, s, urgency, C.tileTop, C.tileBot, C.tileGlow, "$" + Math.round(p.cost), p.multiple ? p.multiple.toFixed(2) + "X" : "");
  }
  for (const [key, g] of state.ghosts) {
    const [c, r] = key.split(":").map(Number);
    const age = clamp((frame - g.bornAt) / 200, 0, 1);
    tile(xOf(c * colMs()) + CELL_W / 2, yOf((r + 1) / 100) + CELL_H / 2, CELL_W - 6, CELL_H - 6, reduceMotion ? 1 : 0.55 + 0.45 * easeOutBack(age), 0.75, C.tileTop, C.tileBot, C.tileGlow, "$" + g.stake, g.multiple.toFixed(2) + "X");
  }

  // effects: bursts, sparks, floating amounts
  state.fx = state.fx.filter((f) => frame - f.t0 < f.life);
  for (const f of state.fx) {
    const k = (frame - f.t0) / f.life;
    const x = xOf(f.time) + f.dx, y = yOf(f.price) + f.dy;
    if (f.kind === "burst") {
      tile(x, y, f.w, f.h, 1 + easeOut(k) * 0.55, 1 - k, "#ffffff", f.win ? "#b6ffe0" : "#ffb3bd", f.win ? "rgba(125,255,197,1)" : "rgba(255,125,143,0.9)", "", "");
      ctx.strokeStyle = f.win ? `rgba(125,255,197,${1 - k})` : `rgba(255,125,143,${0.7 * (1 - k)})`; ctx.lineWidth = 3 * (1 - k) + 0.5;
      ctx.beginPath(); ctx.arc(x, y, 24 + easeOut(k) * (f.win ? 90 : 40), 0, Math.PI * 2); ctx.stroke();
    } else if (f.kind === "spark") {
      const d = easeOut(k) * f.dist;
      ctx.fillStyle = `rgba(${f.rgb},${1 - k})`;
      ctx.beginPath(); ctx.arc(x + Math.cos(f.a) * d, y + Math.sin(f.a) * d + k * k * 30, 2.6 * (1 - k) + 0.6, 0, Math.PI * 2); ctx.fill();
    } else if (f.kind === "text") {
      ctx.save();
      ctx.globalAlpha = k < 0.15 ? k / 0.15 : 1 - clamp((k - 0.6) / 0.4, 0, 1);
      ctx.textAlign = "center"; ctx.font = `700 ${f.size}px ${FONT}`;
      ctx.shadowColor = f.color; ctx.shadowBlur = 18; ctx.fillStyle = f.color;
      const pop = reduceMotion ? 1 : k < 0.2 ? 0.7 + 0.3 * easeOutBack(k / 0.2) : 1;
      ctx.translate(x, y - easeOut(k) * 46); ctx.scale(pop, pop);
      ctx.fillText(f.text, 0, 0);
      ctx.restore();
    }
  }
}

function burst(p, win) {
  const span = p.colMs ?? colMs();
  const time = p.deadline - span / 2, price = (p.lo + p.hi) / 2, t0 = performance.now();
  state.fx.push({ kind: "burst", t0, life: win ? 650 : 420, time, price, dx: 0, dy: 0, w: CELL_W - 6, h: CELL_H - 6, win });
  if (!reduceMotion) {
    for (let i = 0; i < (win ? 16 : 6); i++) {
      state.fx.push({ kind: "spark", t0, life: 500 + Math.random() * 400, time, price, dx: 0, dy: 0, a: Math.random() * Math.PI * 2, dist: 30 + Math.random() * (win ? 70 : 30), rgb: win ? "170,255,220" : "255,150,165" });
    }
  }
  state.fx.push({ kind: "text", t0, life: win ? 1500 : 1100, time, price, dx: 0, dy: -4, text: fmtSigned(p.pnl), size: win ? 24 : 16, color: p.pnl >= 0 ? C.win : C.loss });
}

// ---------- input ----------
function pointer(e) {
  const r = canvas.getBoundingClientRect();
  return boxAt(e.clientX - r.left, e.clientY - r.top);
}
canvas.addEventListener("pointermove", (e) => { state.hover = e.pointerType === "touch" ? null : pointer(e); });
canvas.addEventListener("pointerleave", () => { state.hover = null; });
canvas.addEventListener("pointerup", async (e) => {
  const box = pointer(e);
  if (!box || !state.contract) { if (state.quote) sfx.deny(); return; }
  const key = box.col + ":" + box.row;
  if (state.ghosts.has(key)) return;
  const span = colMs(), symbol = state.contract.symbol;
  state.ghosts.set(key, { bornAt: performance.now(), stake: state.stake, multiple: box.plan.multiple });
  sfx.tap(); navigator.vibrate?.(8);
  try {
    const { position } = await api("/api/tap", { symbol, lo: box.lo, hi: box.hi, deadline: box.deadline, stake: state.stake });
    upsertPosition({ ...position, colMs: span, bornAt: state.ghosts.get(key)?.bornAt, multiple: position.target / position.entry });
  } catch (err) {
    sfx.deny(); toast(err.message === "that box is on the line, pick one further away" ? "Try another square." : err.message, "err");
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
  $("balance").textContent = fmtMoney(state.balance);
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
  const win = position.status === "won";
  burst(p, win);
  showDelta(position.pnl);
  if (win) {
    sfx.win(); navigator.vibrate?.([10, 40, 20]);
    state.marks.push({ symbol: p.symbol, t: now(), price: p.side === "yes" ? p.lo : p.hi, text: fmtSigned(position.pnl) });
    toast(`You won ${fmtMoney(position.pnl)}`, "win");
  } else {
    sfx.out();
    const verb = position.status === "closed" ? "Closed" : "Timed out";
    toast(`${verb}: ${fmtSigned(position.pnl)}`, position.pnl >= 0 ? "win" : "loss");
  }
}

// ---------- stream ----------
function openStream() {
  state.source?.close();
  state.ticks = []; state.quote = null; state.center = null; state.hover = null;
  const c = state.contract;
  if (!c) return;
  const src = new EventSource(`/api/stream?sid=${sid}&symbol=${encodeURIComponent(c.symbol)}`);
  state.source = src;
  const mine = () => state.source === src;
  src.addEventListener("history", (e) => {
    if (!mine()) return;
    const d = JSON.parse(e.data);
    state.clockSkew = d.now - Date.now();
    state.ticks = d.ticks;
    const last = d.ticks.at(-1);
    if (last) state.quote = { bid: last.bid, ask: last.ask };
    $("empty").hidden = !!last;
    if (!last) $("empty").textContent = "Waiting for a live price on this contract…";
  });
  src.addEventListener("quote", (e) => {
    if (!mine()) return;
    const d = JSON.parse(e.data);
    state.quote = { bid: d.bid, ask: d.ask };
    const last = state.ticks.at(-1);
    if (!last || last.bid !== d.bid || last.ask !== d.ask) state.ticks.push(d);
    $("empty").hidden = true;
    updateChipPrice(c.symbol, d);
  });
  src.addEventListener("position", (e) => mine() && onPositionEvent(JSON.parse(e.data)));
  src.addEventListener("ping", (e) => { if (mine()) state.clockSkew = JSON.parse(e.data).now - Date.now(); });
}

// ---------- chrome ----------
function seg(el, values, label, get, set) {
  el.replaceChildren(...values.map((v) => {
    const b = document.createElement("button");
    b.textContent = label(v);
    b.setAttribute("aria-pressed", String(get() === v));
    b.onclick = () => { set(v); sfx.tap(); seg(el, values, label, get, set); };
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
  // Open on the contract nearest 50/50: that's where a move pays the most on both sides.
  const quoted = m.contracts.filter((c) => c.bid != null && c.ask != null);
  quoted.sort((a, b) => Math.abs((a.bid + a.ask) / 2 - 0.5) - Math.abs((b.bid + b.ask) / 2 - 0.5));
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
    soundBtn.setAttribute("aria-pressed", String(state.sound)); sfx.tap();
  };
  $("gameBtn").onclick = () => { renderGameList(); $("gameDlg").showModal(); };
  $("posBtn").onclick = () => { $("posDlg").showModal(); renderPositions(); };
  for (const d of document.querySelectorAll("dialog")) {
    d.addEventListener("click", (e) => { if (e.target === d || e.target.closest("[data-close]")) d.close(); });
  }
  resize();
  requestAnimationFrame(draw);

  const acct = await api(`/api/account?sid=${sid}`);
  state.balance = acct.balance; state.limits = acct.limits;
  state.positions = acct.positions.map((p) => ({ ...p, multiple: p.target / p.entry }));
  $("mode").textContent = acct.mode === "paper" ? "PAPER" : "LIVE";
  renderPositions();
  await loadGames(true);
  setInterval(() => loadGames(false), 120_000);
}
init();

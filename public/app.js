// TapLine client: a live odds line on a grid of tappable boxes.
// A box is a 1-cent price range and a deadline (its column's right edge).
// Tap above the line to back the odds rising into that box; below, falling.

const $ = (id) => document.getElementById(id);
const fmtMoney = (n) => (n < 0 ? "-" : "") + "$" + Math.abs(n).toFixed(2);
const fmtSigned = (n) => (n >= 0 ? "+" : "-") + "$" + Math.abs(n).toFixed(2);
const cents = (p) => Math.round(p * 100) + "¢";

function sessionId() {
  let id = null;
  try { id = localStorage.getItem("tapline.sid"); } catch {}
  if (!id) {
    id = crypto.randomUUID().replaceAll("-", "");
    try { localStorage.setItem("tapline.sid", id); } catch {}
  }
  return id;
}
const sid = sessionId();

const STAKES = [1, 5, 10, 25];
const COLS = [15, 30, 60, 300];
const COL_LABEL = { 15: "15s", 30: "30s", 60: "1m", 300: "5m" };
let COL_W = 96;     // px per column (narrower on phones)
const ROW_H = 44;   // px per 1 cent
let NOW_AT = 0.4;   // the present sits this far across the canvas

const state = {
  games: [], game: null, market: null, contract: null,
  ticks: [], quote: null,
  positions: [], balance: 0, mode: "paper", limits: null,
  stake: 5, colSec: 30,
  clockSkew: 0,       // server time minus local time
  center: null,       // price at the vertical middle, eased toward the mid
  hover: null, pending: new Set(), flashes: [],
  source: null,
};

const now = () => Date.now() + state.clockSkew;

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
  while ($("toasts").children.length > 4) $("toasts").lastChild.remove();
  setTimeout(() => el.remove(), 4000);
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
  COL_W = W < 560 ? 76 : 96; NOW_AT = W < 560 ? 0.28 : 0.4;
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
new ResizeObserver(resize).observe(canvas);

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const colMs = () => state.colSec * 1000;
const xOf = (t) => W * NOW_AT + ((t - now()) / colMs()) * COL_W;
const tOf = (x) => now() + ((x - W * NOW_AT) / COL_W) * colMs();
const yOf = (p) => H / 2 - ((p - state.center) / 0.01) * ROW_H;
const pOf = (y) => state.center + ((H / 2 - y) / ROW_H) * 0.01;

/** The box under a canvas point, or null if it isn't a future, tradable box. */
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

/** Team colours come from Gemini; lift the dark ones so the line reads on a dark background. */
function lineColor() {
  const hex = /^#([0-9a-f]{6})$/i.exec(state.contract?.color ?? "");
  if (!hex) return css("--accent");
  let [r, g, b] = [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16));
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  if (lum < 0.45) {
    const k = (0.45 - lum) / (1 - lum); // blend toward white until bright enough
    [r, g, b] = [r, g, b].map((v) => Math.round(v + (255 - v) * k));
  }
  return `rgb(${r} ${g} ${b})`;
}

function draw() {
  requestAnimationFrame(draw);
  if (!W || !H) return;
  ctx.clearRect(0, 0, W, H);
  const q = state.quote;
  if (!q) return;

  const mid = (q.bid + q.ask) / 2;
  if (state.center === null) state.center = mid;
  // Ease the view so the line stays near the middle without jumping.
  state.center += (mid - state.center) * 0.04;

  const t = now();
  const line = css("--line"), muted = css("--muted"), ink = css("--ink");
  const nowX = W * NOW_AT;
  const col0 = Math.floor(tOf(0) / colMs()), col1 = Math.floor(tOf(W) / colMs());
  const row0 = Math.max(1, Math.floor(pOf(H) * 100)), row1 = Math.min(98, Math.floor(pOf(0) * 100));

  // grid
  ctx.strokeStyle = line; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let r = row0; r <= row1 + 1; r++) { const y = Math.round(yOf(r / 100)) + 0.5; ctx.moveTo(0, y); ctx.lineTo(W, y); }
  for (let c = col0; c <= col1 + 1; c++) { const x = Math.round(xOf(c * colMs())) + 0.5; ctx.moveTo(x, 0); ctx.lineTo(x, H); }
  ctx.stroke();

  // payout labels on tradable boxes
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  const minLead = state.limits?.minLeadMs ?? 3000;
  for (let c = col0; c <= col1; c++) {
    const start = c * colMs();
    if (start < t || start + colMs() < t + minLead) continue;
    const x = xOf(start);
    if (x + COL_W / 2 > W - 44) continue; // leave the price scale clear
    for (let r = row0; r <= row1; r++) {
      const plan = planBox(r / 100, (r + 1) / 100);
      if (!plan) continue;
      const y = yOf((r + 1) / 100);
      const hot = state.hover && state.hover.col === c && state.hover.row === r;
      if (hot) {
        ctx.fillStyle = "rgba(255,255,255,0.08)"; ctx.fillRect(x + 1, y + 1, COL_W - 2, ROW_H - 2);
        ctx.strokeStyle = ink; ctx.strokeRect(x + 1.5, y + 1.5, COL_W - 3, ROW_H - 3);
      }
      ctx.fillStyle = hot ? ink : muted;
      ctx.font = (hot ? "600 " : "") + "13px ui-sans-serif, system-ui, sans-serif";
      ctx.fillText(plan.multiple.toFixed(2) + "x", x + COL_W / 2, y + ROW_H / 2 - (hot ? 7 : 0));
      if (hot) {
        ctx.font = "12px ui-sans-serif, system-ui, sans-serif";
        ctx.fillStyle = css("--win");
        const qty = Math.floor((state.stake / plan.entry) * 100) / 100;
        ctx.fillText("+" + fmtMoney(qty * (plan.target - plan.entry)), x + COL_W / 2, y + ROW_H / 2 + 9);
      }
    }
  }

  // price labels down the right edge
  ctx.textAlign = "right"; ctx.font = "12px ui-sans-serif, system-ui, sans-serif"; ctx.fillStyle = muted;
  for (let r = row0; r <= row1 + 1; r++) {
    const y = yOf(r / 100), label = cents(r / 100), tw = ctx.measureText(label).width;
    ctx.fillStyle = css("--bg"); ctx.fillRect(W - tw - 10, y - 8, tw + 10, 16); // sit the label on its gridline
    ctx.fillStyle = muted; ctx.fillText(label, W - 5, y);
  }

  // time labels along the bottom for future columns
  ctx.fillStyle = css("--bg"); ctx.fillRect(0, H - 18, W, 18);
  ctx.fillStyle = muted; ctx.textAlign = "center";
  const every = COL_W < 90 && state.colSec < 60 ? 2 : 1; // thin the labels where they'd collide
  for (let c = col0; c <= col1 + 1; c++) {
    const ts = c * colMs();
    if (ts <= t || c % every) continue;
    const d = new Date(ts - state.clockSkew);
    const label = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: state.colSec < 60 ? "2-digit" : undefined });
    ctx.fillText(label, xOf(ts), H - 8);
  }

  // positions
  for (const p of state.positions) {
    const span = p.colMs ?? colMs();
    const x = xOf(p.deadline - span), w = (span / colMs()) * COL_W, y = yOf(p.hi);
    if (x + w < 0 || x > W) continue;
    const open = p.status === "open";
    const side = sideQuote(q, p.side);
    const live = open ? p.quantity * (side.bid - p.entry) : p.pnl;
    const color = open ? css("--hold") : p.status === "won" ? css("--win") : live >= 0 ? css("--win") : css("--loss");
    const age = open ? 0 : (t - p.closedAt) / 6000;
    if (age > 1) continue;
    ctx.globalAlpha = open ? 1 : 1 - age;
    ctx.fillStyle = color; ctx.globalAlpha *= open ? 0.9 : 0.75;
    roundRect(x + 3, y + 3, w - 6, ROW_H - 6, 8); ctx.fill();
    ctx.globalAlpha = open ? 1 : 1 - age;
    ctx.fillStyle = "#0a0d13"; ctx.textAlign = "center";
    ctx.font = "700 13px ui-sans-serif, system-ui, sans-serif";
    ctx.fillText(open ? fmtMoney(p.cost) : p.status === "won" ? "HIT" : "OUT", x + w / 2, y + ROW_H / 2 - 7);
    ctx.font = "600 12px ui-sans-serif, system-ui, sans-serif";
    ctx.fillText(fmtSigned(live), x + w / 2, y + ROW_H / 2 + 9);
    ctx.globalAlpha = 1;
  }
  for (const key of state.pending) {
    const [c, r] = key.split(":").map(Number);
    ctx.strokeStyle = css("--hold"); ctx.setLineDash([4, 4]);
    ctx.strokeRect(xOf(c * colMs()) + 3.5, yOf((r + 1) / 100) + 3.5, COL_W - 7, ROW_H - 7);
    ctx.setLineDash([]);
  }

  // bid/ask band and the mid line, drawn as steps up to the present
  const pts = state.ticks;
  if (pts.length) {
    const color = lineColor();
    ctx.fillStyle = color; ctx.globalAlpha = 0.12;
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const x0 = xOf(pts[i].t), x1 = i + 1 < pts.length ? xOf(pts[i + 1].t) : nowX;
      ctx.rect(x0, yOf(pts[i].ask), x1 - x0, yOf(pts[i].bid) - yOf(pts[i].ask));
    }
    ctx.fill(); ctx.globalAlpha = 1;

    ctx.strokeStyle = color; ctx.lineWidth = 2.5; ctx.lineJoin = "round";
    ctx.shadowColor = color; ctx.shadowBlur = 10;
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const y = yOf((pts[i].bid + pts[i].ask) / 2);
      const x0 = xOf(pts[i].t), x1 = i + 1 < pts.length ? xOf(pts[i + 1].t) : nowX;
      if (i === 0) ctx.moveTo(x0, y); else ctx.lineTo(x0, y);
      ctx.lineTo(x1, y);
    }
    ctx.stroke(); ctx.shadowBlur = 0;

    const y = yOf(mid);
    ctx.fillStyle = color; ctx.beginPath(); ctx.arc(nowX, y, 5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = ink; ctx.textAlign = "right"; ctx.font = "700 14px ui-sans-serif, system-ui, sans-serif";
    ctx.fillText(cents(q.bid) + " / " + cents(q.ask), nowX - 12, y - 14);
  }

  // the present
  ctx.strokeStyle = muted; ctx.setLineDash([3, 5]); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(nowX + 0.5, 0); ctx.lineTo(nowX + 0.5, H); ctx.stroke(); ctx.setLineDash([]);
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h);
}

function sideQuote(q, side) {
  return side === "yes" ? { bid: q.bid, ask: q.ask } : { bid: 1 - q.ask, ask: 1 - q.bid };
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
  if (!box || !state.contract) return;
  const key = box.col + ":" + box.row;
  if (state.pending.has(key)) return;
  state.pending.add(key);
  const span = colMs();
  try {
    const { position } = await api("/api/tap", { symbol: state.contract.symbol, lo: box.lo, hi: box.hi, deadline: box.deadline, stake: state.stake });
    upsertPosition({ ...position, colMs: span });
  } catch (err) {
    toast(err.message, "err");
  } finally {
    state.pending.delete(key);
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
  const open = state.positions.filter((p) => p.status === "open");
  $("posCount").textContent = open.length;
  $("balance").textContent = fmtMoney(state.balance);
  const list = $("posList");
  if (!$("posDlg").open) return;
  list.replaceChildren();
  const sorted = [...state.positions].sort((a, b) => (a.status === "open" ? 0 : 1) - (b.status === "open" ? 0 : 1) || b.openedAt - a.openedAt).slice(0, 60);
  if (!sorted.length) { list.innerHTML = '<div class="none">No positions yet. Tap a box on the grid.</div>'; return; }
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
  if (position.status !== "open" && (!before || before.status === "open")) {
    const up = position.side === "yes";
    const where = `${position.label} ${up ? "↑" : "↓"} ${cents(up ? position.lo : position.hi)}`;
    if (position.status === "won") toast(`Hit ${where}: ${fmtSigned(position.pnl)}`, "win");
    else toast(`${position.status === "closed" ? "Closed" : "Timed out"} ${where}: ${fmtSigned(position.pnl)}`, position.pnl >= 0 ? "win" : "loss");
  }
}

// ---------- stream ----------
function openStream() {
  state.source?.close();
  state.ticks = []; state.quote = null; state.center = null;
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
    b.onclick = () => { set(v); seg(el, values, label, get, set); };
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
    if (c.color) b.style.setProperty("--c", c.color);
    const quoted = c.bid != null && c.ask != null;
    b.innerHTML = '<span class="dot"></span><span></span><b></b>';
    b.children[1].textContent = c.label;
    b.children[2].textContent = quoted ? cents((c.bid + c.ask) / 2) : "no quote";
    b.setAttribute("aria-pressed", String(c === state.contract));
    b.onclick = () => selectContract(c);
    return b;
  }));
}

function selectContract(c) { state.contract = c; renderMarkets(); openStream(); }
function selectMarket(m) {
  state.market = m;
  selectContract(m.contracts.find((c) => c.bid != null && c.ask != null) ?? m.contracts[0]);
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
  } catch (err) {
    if (first) { $("empty").textContent = "Couldn't load games. Retrying…"; setTimeout(() => loadGames(true), 3000); }
  }
}

async function init() {
  seg($("stakes"), STAKES, (v) => "$" + v, () => state.stake, (v) => { state.stake = v; });
  seg($("cols"), COLS, (v) => COL_LABEL[v], () => state.colSec, (v) => { state.colSec = v; });
  $("gameBtn").onclick = () => { renderGameList(); $("gameDlg").showModal(); };
  $("posBtn").onclick = () => { $("posDlg").showModal(); renderPositions(); };
  for (const d of document.querySelectorAll("dialog")) {
    d.addEventListener("click", (e) => { if (e.target === d || e.target.closest("[data-close]")) d.close(); });
  }
  resize();
  requestAnimationFrame(draw);

  const acct = await api(`/api/account?sid=${sid}`);
  state.balance = acct.balance; state.mode = acct.mode; state.limits = acct.limits;
  state.positions = acct.positions;
  $("mode").textContent = acct.mode === "paper" ? "PAPER" : "LIVE";
  renderPositions();
  await loadGames(true);
  setInterval(() => loadGames(false), 120_000);
}
init();

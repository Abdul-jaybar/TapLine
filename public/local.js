// Browser-only backend: lets TapLine run as a static site with no server.
// The browser talks to Gemini's public market data directly (REST for games, WebSocket for
// quotes) and runs the paper-trading engine itself, keeping the account in localStorage.
// It mirrors src/server/gemini.ts and src/server/engine.ts; keep the rules in step with them.
// Real orders need the server (an API secret can't live in a browser), so this mode is paper only.

const REST = "https://api.gemini.com";
const WS = "wss://ws.gemini.com";
const MAX_SPREAD = 0.1;
const EXIT_GRACE_MS = 20_000;
const START_BALANCE = 10_000;
const LIMITS = { minWin: 0.5, maxWin: 500, maxExposure: 5000, minLeadMs: 3000, maxLeadMs: 60 * 60_000 };
const STORE_KEY = "tapline.paper.v2";

const round = (n, dp) => Math.round(n * 10 ** dp) / 10 ** dp;
const px = (n) => round(n, 2);
const qtyFloor = (n) => Math.floor(n * 100 + 1e-9) / 100;
const money = (n) => round(n, 4);
const drawable = (q) => q && q.bid != null && q.ask != null && q.bid > 0 && q.ask < 1 && q.bid < q.ask && q.ask - q.bid <= MAX_SPREAD;
const sideQuote = (q, side) =>
  side === "yes" ? { bid: q.bid, ask: q.ask } : { bid: q.ask == null ? null : px(1 - q.ask), ask: q.bid == null ? null : px(1 - q.bid) };

class TapError extends Error {}

// `win` is the profit wanted if the square hits; the order is sized to pay exactly that.
function planTap(q, lo, hi, win) {
  if (q.bid == null || q.ask == null) throw new TapError("the market is one-sided right now, try again in a moment");
  let side, target;
  if (lo >= q.ask + 0.01 - 1e-9) { side = "yes"; target = px(lo); }
  else if (hi <= q.bid - 0.01 + 1e-9) { side = "no"; target = px(1 - hi); }
  else throw new TapError("that box is on the line, pick one further away");
  const entry = sideQuote(q, side).ask;
  if (!(entry > 0 && entry < 1) || !(target > entry && target < 1)) throw new TapError("no room to profit in that box");
  const quantity = qtyFloor(win / (target - entry));
  if (quantity < 0.01) throw new TapError("amount too small for this square");
  return { side, entry, target, quantity, cost: money(quantity * entry) };
}

// ---------- games ----------
const GAME_TICKER = /^([A-Z]+)-(\d{10}-[A-Z0-9]+-[A-Z0-9]+)-([A-Z0-9]+)$/;
const MARKET_NAMES = { M: "Winner", S: "Point spread", T: "Total points" };
const MARKET_ORDER = ["M", "S", "T"];
const num = (s) => (s === undefined || s === null ? null : Number(s));

function groupGames(events) {
  const games = new Map();
  for (const e of events) {
    const m = GAME_TICKER.exec(e.ticker);
    if (!m) continue;
    const [, league, rest, kind] = m;
    const id = `${league}-${rest}`;
    let g = games.get(id);
    if (!g) games.set(id, (g = { id, title: "", league, volume24h: 0, markets: [] }));
    if (kind === "M") { g.title = e.title; g.startTime = e.startTime; }
    const contracts = e.contracts
      .filter((c) => c.status === "active" && c.marketState !== "closed")
      .map((c) => ({ symbol: c.instrumentSymbol, label: c.label, color: c.color, bid: num(c.prices?.bestBid), ask: num(c.prices?.bestAsk) }));
    if (!contracts.length) continue;
    const volume24h = Number(e.volume24h ?? 0);
    g.volume24h += volume24h;
    g.markets.push({ ticker: e.ticker, name: MARKET_NAMES[kind] ?? (e.title.split(": ").slice(1).join(": ") || kind), volume24h, contracts, order: MARKET_ORDER.includes(kind) ? MARKET_ORDER.indexOf(kind) : 99 });
  }
  const inPlay = (g) => g.markets[0]?.contracts.some((c) => drawable(c) && (c.bid + c.ask) / 2 > 0.12 && (c.bid + c.ask) / 2 < 0.88) ?? false;
  return [...games.values()]
    .filter((g) => g.title && g.markets.length)
    .map((g) => ({ ...g, markets: g.markets.sort((a, b) => a.order - b.order || b.volume24h - a.volume24h) }))
    .sort((a, b) => Number(inPlay(b)) - Number(inPlay(a)) || b.volume24h - a.volume24h);
}

async function fetchLiveGames(pages = 3, pageSize = 50) {
  const events = [];
  for (let p = 0; p < pages; p++) {
    const res = await fetch(`${REST}/v1/prediction-markets/events?status=active&category=Live&limit=${pageSize}&offset=${p * pageSize}`);
    if (!res.ok) throw new Error(`Gemini returned HTTP ${res.status}`);
    const body = await res.json();
    events.push(...body.data);
    if (body.data.length < pageSize) break;
  }
  return groupGames(events);
}

// ---------- live quotes ----------
class Feed {
  constructor() {
    this.wanted = new Set(); this.quotes = new Map(); this.history = new Map();
    this.onQuote = new Set(); this.onMove = new Set();
    this.nextId = 1; this.retryMs = 1000; this.connected = false;
    this.connect();
  }
  connect() {
    const ws = (this.ws = new WebSocket(WS));
    ws.onopen = () => { this.connected = true; this.retryMs = 1000; if (this.wanted.size) this.send([...this.wanted]); };
    ws.onmessage = (m) => this.message(String(m.data));
    ws.onclose = () => { this.connected = false; setTimeout(() => this.connect(), this.retryMs); this.retryMs = Math.min(this.retryMs * 2, 15_000); };
    ws.onerror = () => ws.close();
  }
  send(symbols) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    for (let i = 0; i < symbols.length; i += 25) {
      this.ws.send(JSON.stringify({ id: this.nextId++, method: "SUBSCRIBE", params: symbols.slice(i, i + 25).map((s) => `${s}@bookTicker`) }));
    }
  }
  subscribe(symbols) {
    const fresh = symbols.filter((s) => !this.wanted.has(s));
    for (const s of fresh) this.wanted.add(s);
    if (fresh.length) this.send(fresh);
  }
  seed(symbol, bid, ask) {
    if (this.quotes.has(symbol)) return;
    const q = { bid: bid && bid > 0 ? bid : null, ask: ask && ask < 1 ? ask : null };
    if (drawable(q)) this.record({ symbol, ...q, bidSize: 0, askSize: 0, t: Date.now() });
  }
  message(text) {
    let j;
    try { j = JSON.parse(text); } catch { return; }
    if (!j.s || j.b === undefined || j.a === undefined) return;
    const b = Number(j.b), a = Number(j.a);
    const bid = b > 0 && b < 1 ? b : null, ask = a > 0 && a < 1 ? a : null;
    if (bid !== null && ask !== null && bid >= ask) return;
    this.record({ symbol: j.s.toUpperCase(), bid, ask, bidSize: Number(j.B ?? 0), askSize: Number(j.A ?? 0), t: Date.now() });
  }
  record(q) {
    this.quotes.set(q.symbol, q);
    if (drawable(q)) {
      let h = this.history.get(q.symbol);
      if (!h) this.history.set(q.symbol, (h = []));
      const last = h.at(-1);
      if (!last || last.bid !== q.bid || last.ask !== q.ask) {
        h.push({ t: q.t, bid: q.bid, ask: q.ask });
        if (h.length > 4000) h.splice(0, h.length - 4000);
        if (last) {
          const from = (last.bid + last.ask) / 2, to = (q.bid + q.ask) / 2;
          if (Math.abs(to - from) >= 0.01 - 1e-9) for (const f of this.onMove) f({ symbol: q.symbol, from, to, t: q.t });
        }
      }
    }
    for (const f of this.onQuote) f(q);
  }
}

// ---------- backend ----------
export function createLocalBackend() {
  const feed = new Feed();
  let games = [], gamesError = null, loaded = false, refreshing = null;

  async function refresh() {
    try {
      games = await fetchLiveGames();
      gamesError = null;
      for (const g of games) for (const m of g.markets) for (const c of m.contracts) feed.seed(c.symbol, c.bid, c.ask);
      feed.subscribe(games.slice(0, 8).flatMap((g) => g.markets[0]?.contracts.map((c) => c.symbol) ?? []));
    } catch (err) {
      gamesError = err instanceof Error ? err.message : String(err);
    }
    loaded = true;
  }
  const knownContract = (symbol) => {
    for (const g of games) for (const m of g.markets) for (const c of m.contracts) if (c.symbol === symbol) return c;
  };

  // account, kept in this browser
  let acct = { balance: START_BALANCE, positions: [] };
  try { const saved = JSON.parse(localStorage.getItem(STORE_KEY)); if (saved && typeof saved.balance === "number") acct = saved; } catch {}
  const save = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify({ balance: acct.balance, positions: acct.positions.slice(-200) })); } catch {} };
  // Positions left open from an earlier visit still need prices to resolve.
  feed.subscribe([...new Set(acct.positions.filter((p) => p.status === "open").map((p) => p.symbol))]);
  const positionListeners = new Set();
  const emit = (p) => { save(); for (const f of positionListeners) f({ position: { ...p }, balance: acct.balance }); };
  const exposure = () => money(acct.positions.filter((p) => p.status === "open").reduce((s, p) => s + p.cost, 0));

  function settle(p, status, limit, now) {
    const q = feed.quotes.get(p.symbol);
    const bid = q ? sideQuote(q, p.side).bid : null;
    if (bid == null || bid < limit - 1e-9 || p.status !== "open") return false;
    p.status = status; p.exit = bid; p.closedAt = now;
    p.pnl = money(p.quantity * (bid - p.entry));
    acct.balance = money(acct.balance + p.quantity * bid);
    emit(p);
    return true;
  }

  feed.onQuote.add((q) => {
    const now = Date.now();
    for (const p of acct.positions) {
      if (p.status !== "open" || p.symbol !== q.symbol) continue;
      const bid = sideQuote(q, p.side).bid;
      if (bid == null) continue;
      if (bid > p.best) p.best = bid;
      if (bid >= p.target - 1e-9) settle(p, "won", p.target, now);
    }
  });
  setInterval(() => {
    const now = Date.now();
    for (const p of acct.positions) {
      if (p.status !== "open" || now < p.deadline) continue;
      // Don't sell into a momentarily gapped book; give it a short grace period to come back.
      const q = feed.quotes.get(p.symbol);
      const gapped = !q || q.bid == null || q.ask == null || q.ask - q.bid > MAX_SPREAD;
      if (gapped && now < p.deadline + EXIT_GRACE_MS) continue;
      if (settle(p, "expired", 0, now)) continue;
      // Still no buyer long after the deadline (e.g. the tab was closed and the market has since
      // ended): void the paper position at its entry price so it doesn't hold the balance forever.
      if (now > p.deadline + 10 * 60_000) {
        p.status = "expired"; p.exit = p.entry; p.closedAt = now; p.pnl = 0;
        acct.balance = money(acct.balance + p.cost);
        emit(p);
      }
    }
  }, 250);

  return {
    mode: "local",
    async games() {
      refreshing ??= refresh().finally(() => { refreshing = null; });
      if (!loaded) await refreshing;
      return { games, error: games.length ? null : gamesError, loading: false };
    },
    async account() {
      return { mode: "paper", balance: acct.balance, limits: LIMITS, positions: acct.positions.slice(-200).map((p) => ({ ...p })) };
    },
    async tap(req) {
      const now = Date.now();
      const contract = knownContract(req.symbol);
      if (!contract) throw new TapError("unknown contract");
      if (!(req.win >= LIMITS.minWin && req.win <= LIMITS.maxWin)) throw new TapError(`win amount must be $${LIMITS.minWin} to $${LIMITS.maxWin}`);
      if (!(req.lo >= 0.01 && req.hi <= 0.99 + 1e-9 && req.hi > req.lo)) throw new TapError("box is outside the tradable range");
      if (req.deadline < now + LIMITS.minLeadMs) throw new TapError("that column is closing, pick a later one");
      if (req.deadline > now + LIMITS.maxLeadMs) throw new TapError("that deadline is too far out");
      const q = feed.quotes.get(req.symbol);
      if (!q) throw new TapError("no live price for this contract yet");
      if (now - q.t > 5 * 60_000) throw new TapError("price is stale, market may be paused");
      const plan = planTap(q, px(req.lo), px(req.hi), req.win);
      if (plan.cost > acct.balance + 1e-9) throw new TapError(`that square needs $${Math.ceil(plan.cost)} to win $${req.win}; not enough balance`);
      if (exposure() + plan.cost > LIMITS.maxExposure + 1e-9) throw new TapError(`open positions are capped at $${LIMITS.maxExposure}`);
      acct.balance = money(acct.balance - plan.cost);
      const p = {
        id: crypto.randomUUID(), symbol: req.symbol, label: contract.label, lo: px(req.lo), hi: px(req.hi), deadline: req.deadline,
        side: plan.side, quantity: plan.quantity, entry: plan.entry, target: plan.target, best: sideQuote(q, plan.side).bid ?? 0,
        cost: plan.cost, status: "open", openedAt: now,
      };
      acct.positions.push(p);
      emit(p); // also tells the page its new balance
      return { position: { ...p } };
    },
    /** Start the paper account over. */
    async reset() {
      acct = { balance: START_BALANCE, positions: [] };
      save();
      return { balance: acct.balance };
    },
    async close(id) {
      const p = acct.positions.find((x) => x.id === id);
      if (!p) throw new TapError("no such position");
      if (p.status === "open" && !settle(p, "closed", 0, Date.now())) throw new TapError("no buyers right now");
      return { position: { ...p } };
    },
    /** Live quotes for one contract, moves across its game, and this account's results. */
    stream(symbol, gameId, on) {
      feed.subscribe([symbol]);
      const activity = new Map();
      for (const m of games.find((g) => g.id === gameId)?.markets ?? []) {
        for (const c of m.contracts) {
          if (activity.size >= 160) break;
          if (c.bid !== null || c.ask !== null) activity.set(c.symbol, { market: m.name, label: c.label });
        }
      }
      feed.subscribe([...activity.keys()]);
      const onQuote = (q) => { if (q.symbol === symbol) on.quote?.({ t: q.t, bid: q.bid, ask: q.ask, bidSize: q.bidSize, askSize: q.askSize }); };
      const onMove = (m) => { const info = activity.get(m.symbol); if (info) on.move?.({ ...m, ...info }); };
      const onPosition = (e) => on.position?.(e);
      feed.onQuote.add(onQuote); feed.onMove.add(onMove); positionListeners.add(onPosition);
      queueMicrotask(() => on.history?.({ symbol, ticks: (feed.history.get(symbol) ?? []).filter((p) => p.t >= Date.now() - 30 * 60_000), now: Date.now() }));
      return { close() { feed.onQuote.delete(onQuote); feed.onMove.delete(onMove); positionListeners.delete(onPosition); } };
    },
  };
}

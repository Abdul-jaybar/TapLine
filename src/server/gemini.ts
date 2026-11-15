import { EventEmitter } from "node:events";

/**
 * Gemini Prediction Markets: game discovery over REST and live quotes over WebSocket.
 * Everything here is public market data; no API key is needed.
 */
const REST = process.env.GEMINI_BASE_URL ?? "https://api.gemini.com";
const WS = process.env.GEMINI_WS_URL ?? "wss://ws.gemini.com";

/** Quotes wider than this are treated as "no market right now". */
const MAX_SPREAD = 0.1;

export interface Quote {
  symbol: string;
  /** Best bid for YES, or null when nobody is bidding. */
  bid: number | null;
  /** Best ask for YES, or null when nobody is offering. */
  ask: number | null;
  bidSize: number;
  askSize: number;
  /** Milliseconds since epoch. */
  t: number;
}

export interface ContractInfo {
  symbol: string;
  label: string;
  color?: string;
  bid: number | null;
  ask: number | null;
}

export interface MarketInfo {
  ticker: string;
  name: string;
  volume24h: number;
  contracts: ContractInfo[];
}

export interface Game {
  id: string;
  title: string;
  league: string;
  startTime?: string;
  volume24h: number;
  markets: MarketInfo[];
}

interface RawEvent {
  title: string;
  ticker: string;
  startTime?: string;
  volume24h?: string;
  contracts: {
    label: string;
    instrumentSymbol: string;
    status: string;
    marketState?: string;
    color?: string;
    prices?: { bestBid?: string; bestAsk?: string };
  }[];
}

const num = (s?: string) => (s === undefined || s === null ? null : Number(s));

/** NFL-2611151800-KC-ATL-M -> game "NFL-2611151800-KC-ATL", market "M". */
const GAME_TICKER = /^([A-Z]+)-(\d{10}-[A-Z0-9]+-[A-Z0-9]+)-([A-Z0-9]+)$/;
const MARKET_NAMES: Record<string, string> = { M: "Winner", S: "Point spread", T: "Total points" };
const MARKET_ORDER = ["M", "S", "T"];

export function groupGames(events: RawEvent[]): Game[] {
  const games = new Map<string, Game & { order: Map<string, number> }>();
  for (const e of events) {
    const m = GAME_TICKER.exec(e.ticker);
    if (!m) continue;
    const [, league, rest, kind] = m as unknown as [string, string, string, string];
    const id = `${league}-${rest}`;
    let g = games.get(id);
    if (!g) games.set(id, (g = { id, title: "", league, volume24h: 0, markets: [], order: new Map() }));
    if (kind === "M") {
      g.title = e.title;
      g.startTime = e.startTime;
    }
    const contracts = e.contracts
      .filter((c) => c.status === "active" && c.marketState !== "closed")
      .map((c) => ({
        symbol: c.instrumentSymbol,
        label: c.label,
        color: c.color,
        bid: num(c.prices?.bestBid),
        ask: num(c.prices?.bestAsk),
      }));
    if (!contracts.length) continue;
    const volume24h = Number(e.volume24h ?? 0);
    g.volume24h += volume24h;
    g.markets.push({
      ticker: e.ticker,
      name: MARKET_NAMES[kind] ?? e.title.split(": ").slice(1).join(": ") ?? kind,
      volume24h,
      contracts,
    });
    g.order.set(e.ticker, MARKET_ORDER.includes(kind) ? MARKET_ORDER.indexOf(kind) : 99);
  }
  return [...games.values()]
    .filter((g) => g.title && g.markets.length)
    .map(({ order, ...g }) => ({
      ...g,
      markets: g.markets.sort((a, b) => order.get(a.ticker)! - order.get(b.ticker)! || b.volume24h - a.volume24h),
    }))
    // Games whose winner market has a real two-sided price come first; finished games sink.
    .sort((a, b) => Number(tradable(b)) - Number(tradable(a)) || b.volume24h - a.volume24h);
}

const tradable = (g: Game) => g.markets[0]?.contracts.some((c) => isDrawable(c)) ?? false;

export async function fetchLiveGames(pages = 3, pageSize = 50): Promise<Game[]> {
  const events: RawEvent[] = [];
  for (let p = 0; p < pages; p++) {
    const url = `${REST}/v1/prediction-markets/events?status=active&category=Live&limit=${pageSize}&offset=${p * pageSize}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`Gemini events -> HTTP ${res.status}`);
    const body = (await res.json()) as { data: RawEvent[] };
    events.push(...body.data);
    if (body.data.length < pageSize) break;
  }
  return groupGames(events);
}

export interface Tick {
  t: number;
  bid: number;
  ask: number;
}

/** A contract's price moved by at least a cent. */
export interface Move {
  symbol: string;
  from: number;
  to: number;
  t: number;
}

/** A quote both sides of which are present and close enough to draw as a price. */
export const isDrawable = (q: { bid: number | null; ask: number | null }): q is { bid: number; ask: number } =>
  q.bid !== null && q.ask !== null && q.bid > 0 && q.ask < 1 && q.bid < q.ask && q.ask - q.bid <= MAX_SPREAD;

/**
 * One WebSocket to Gemini carrying best bid/ask for every subscribed contract.
 *
 * Emits "quote" for every update, including one-sided ones (a side with no
 * orders is null): a resting order can still fill against the side that is
 * there. Only drawable quotes go into the chart history, and a "move" is
 * emitted when a contract's drawable mid changes by a cent or more.
 */
export class Feed extends EventEmitter {
  private ws: WebSocket | null = null;
  private wanted = new Set<string>();
  private nextId = 1;
  private quotes = new Map<string, Quote>();
  private history = new Map<string, Tick[]>();
  private retryMs = 1000;
  connected = false;

  start() {
    this.setMaxListeners(0);
    this.connect();
  }

  private connect() {
    const ws = new WebSocket(WS);
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.retryMs = 1000;
      if (this.wanted.size) this.send("SUBSCRIBE", [...this.wanted]);
    };
    ws.onmessage = (m) => this.onMessage(String(m.data));
    ws.onclose = () => {
      this.connected = false;
      setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 15_000);
    };
    ws.onerror = () => ws.close();
  }

  private send(method: "SUBSCRIBE" | "UNSUBSCRIBE", symbols: string[]) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    // Small frames: one bad symbol or an oversized frame shouldn't sink the rest.
    for (let i = 0; i < symbols.length; i += 25) {
      const params = symbols.slice(i, i + 25).map((s) => `${s}@bookTicker`);
      this.ws.send(JSON.stringify({ id: this.nextId++, method, params }));
    }
  }

  subscribe(symbols: string[]) {
    const fresh = symbols.filter((s) => !this.wanted.has(s));
    for (const s of fresh) this.wanted.add(s);
    if (fresh.length) this.send("SUBSCRIBE", fresh);
  }

  /** Seed a quote from REST so a contract has a price before its first WebSocket update. */
  seed(symbol: string, bid: number | null, ask: number | null) {
    if (this.quotes.has(symbol)) return;
    const q = { bid: bid && bid > 0 ? bid : null, ask: ask && ask < 1 ? ask : null };
    if (!isDrawable(q)) return;
    this.record({ symbol, ...q, bidSize: 0, askSize: 0, t: Date.now() });
  }

  private onMessage(text: string) {
    let j: { s?: string; b?: string; a?: string; B?: string; A?: string };
    try {
      j = JSON.parse(text);
    } catch {
      return;
    }
    if (!j.s || j.b === undefined || j.a === undefined) return;
    const b = Number(j.b);
    const a = Number(j.a);
    // An empty side arrives as 0 (or 1 for the ask); keep the side that has orders.
    const bid = b > 0 && b < 1 ? b : null;
    const ask = a > 0 && a < 1 ? a : null;
    if (bid !== null && ask !== null && bid >= ask) return;
    this.record({ symbol: j.s.toUpperCase(), bid, ask, bidSize: Number(j.B ?? 0), askSize: Number(j.A ?? 0), t: Date.now() });
  }

  private record(q: Quote) {
    this.quotes.set(q.symbol, q);
    if (isDrawable(q)) {
      let h = this.history.get(q.symbol);
      if (!h) this.history.set(q.symbol, (h = []));
      const last = h.at(-1);
      if (!last || last.bid !== q.bid || last.ask !== q.ask) {
        h.push({ t: q.t, bid: q.bid, ask: q.ask });
        if (h.length > 4000) h.splice(0, h.length - 4000);
        if (last) {
          const from = (last.bid + last.ask) / 2, to = (q.bid + q.ask) / 2;
          if (Math.abs(to - from) >= 0.01 - 1e-9) this.emit("move", { symbol: q.symbol, from, to, t: q.t } satisfies Move);
        }
      }
    }
    this.emit("quote", q);
  }

  quote(symbol: string) {
    return this.quotes.get(symbol);
  }

  ticks(symbol: string, sinceMs = 0) {
    return (this.history.get(symbol) ?? []).filter((p) => p.t >= sinceMs);
  }
}

import { randomUUID } from "node:crypto";
import type { Quote } from "./gemini.ts";

/**
 * The tap engine.
 *
 * A box on the grid is a price range [lo, hi) for a contract's YES price and a
 * deadline. Tapping it means "I think the odds will reach this box in time".
 * Because Gemini contracts only settle at the end of the event, a tap becomes a
 * bracket of real orders:
 *
 *   box above the line  -> buy YES now, rest a sell at the box's near edge (lo)
 *   box below the line  -> buy NO now,  rest a sell where YES falls to the near edge (hi)
 *   deadline passes     -> cancel the resting sell and exit at the market
 *
 * So a hit pays the move from entry to the box; a miss is not a total loss, it
 * exits at whatever the market is at the deadline.
 *
 * A box above the line is hit when the YES *bid* reaches it (someone will buy
 * from you there); a box below when the YES *ask* falls to it. The chart's mid
 * line can cross a box before that when the spread is wide, which is why the
 * client draws the bid/ask band and each position tracks how close it got.
 */

const round = (n: number, dp: number) => Math.round(n * 10 ** dp) / 10 ** dp;
/** Prices move in 1 cent ticks; quantities in hundredths of a contract. */
const px = (n: number) => round(n, 2);
const qtyFloor = (n: number) => Math.floor(n * 100 + 1e-9) / 100;
const money = (n: number) => round(n, 4);

export type Side = "yes" | "no";
export type PositionStatus = "open" | "won" | "expired" | "closed";

export interface Position {
  id: string;
  symbol: string;
  label: string;
  /** The tapped box, in YES-price terms. */
  lo: number;
  hi: number;
  deadline: number;
  side: Side;
  quantity: number;
  /** Price paid per contract for `side`. */
  entry: number;
  /** Best price this position could have sold at while open (for "missed by" messages). */
  best: number;
  /** Resting sell price for `side`. */
  target: number;
  cost: number;
  status: PositionStatus;
  openedAt: number;
  closedAt?: number;
  exit?: number;
  pnl?: number;
}

export interface TapRequest {
  symbol: string;
  label: string;
  lo: number;
  hi: number;
  deadline: number;
  /** What the user wants to win if the square hits; the order is sized to pay exactly this. */
  win: number;
}

export interface Fill {
  price: number;
  quantity: number;
}

/**
 * Where orders go. PaperBroker fills against the live quote; a Gemini broker
 * places the same three order types for real.
 */
export interface Broker {
  readonly mode: "paper" | "live";
  /** Buy `quantity` of `side` now at up to `limit`. */
  buy(symbol: string, side: Side, quantity: number, limit: number): Promise<Fill>;
  /** Sell `quantity` of `side` now at `limit` or better. */
  sell(symbol: string, side: Side, quantity: number, limit: number): Promise<Fill>;
}

/** Bid/ask for one side, derived from the YES book. A missing side is null. */
export function sideQuote(q: Pick<Quote, "bid" | "ask">, side: Side): { bid: number | null; ask: number | null } {
  if (side === "yes") return { bid: q.bid, ask: q.ask };
  return { bid: q.ask === null ? null : px(1 - q.ask), ask: q.bid === null ? null : px(1 - q.bid) };
}

export class PaperBroker implements Broker {
  readonly mode = "paper";
  constructor(private quoteOf: (symbol: string) => Quote | undefined) {}

  private book(symbol: string, side: Side) {
    const q = this.quoteOf(symbol);
    if (!q) throw new TapError("no live price for this contract yet");
    return sideQuote(q, side);
  }

  async buy(symbol: string, side: Side, quantity: number, limit: number): Promise<Fill> {
    const { ask } = this.book(symbol, side);
    if (ask === null) throw new TapError("no sellers right now");
    if (ask > limit + 1e-9) throw new TapError("price moved, tap again");
    return { price: ask, quantity };
  }

  async sell(symbol: string, side: Side, quantity: number, limit: number): Promise<Fill> {
    const { bid } = this.book(symbol, side);
    if (bid === null) throw new TapError("no buyers right now");
    if (bid < limit - 1e-9) throw new TapError("no buyer at that price right now");
    return { price: bid, quantity };
  }
}

/** A tap the engine refused; the message is shown to the user. */
export class TapError extends Error {}

export interface Limits {
  /** Smallest and largest amount a single tap may be sized to win. */
  minWin: number;
  maxWin: number;
  /** Most money allowed in open positions at once. */
  maxExposure: number;
  /** Earliest and latest allowed deadline, from now. */
  minLeadMs: number;
  maxLeadMs: number;
}

/** How long a timed-out position waits for a normal two-sided quote before exiting anyway. */
export const EXIT_GRACE_MS = 20_000;

export const DEFAULT_LIMITS: Limits = {
  minWin: 0.5,
  maxWin: 500,
  maxExposure: 5000,
  minLeadMs: 3_000,
  maxLeadMs: 60 * 60_000,
};

/** Plan a tap against a quote. Pure, so the UI's payout labels and the engine agree. */
/**
 * `win` is the profit wanted if the square hits. The move from entry to target is small (cents),
 * so the order is sized up to pay that amount: quantity = win / (target - entry). Near squares
 * therefore need a large position, far squares a small one.
 */
export function planTap(q: Pick<Quote, "bid" | "ask">, lo: number, hi: number, win: number) {
  if (q.bid === null || q.ask === null) throw new TapError("the market is one-sided right now, try again in a moment");
  let side: Side;
  let target: number;
  if (lo >= q.ask + 0.01 - 1e-9) {
    side = "yes"; // box is above the line: profit if YES rises to the box's lower edge
    target = px(lo);
  } else if (hi <= q.bid - 0.01 + 1e-9) {
    side = "no"; // box is below the line: profit if YES falls to the box's upper edge
    target = px(1 - hi);
  } else {
    throw new TapError("that box is on the line, pick one further away");
  }
  const entry = sideQuote(q, side).ask!;
  if (!(entry > 0 && entry < 1) || !(target > entry && target < 1)) throw new TapError("no room to profit in that box");
  const quantity = qtyFloor(win / (target - entry));
  if (quantity < 0.01) throw new TapError("amount too small for this square");
  const cost = money(quantity * entry);
  return { side, entry, target, quantity, cost, multiple: target / entry, profitIfHit: money(quantity * (target - entry)) };
}

export class Account {
  positions: Position[] = [];
  /** Serialises trades so two taps can't both pass the balance check. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    public balance: number,
    private broker: Broker,
    private quoteOf: (symbol: string) => Quote | undefined,
    private onChange: (p: Position, account: Account) => void = () => {},
    private limits: Limits = DEFAULT_LIMITS,
  ) {}

  get mode() {
    return this.broker.mode;
  }

  exposure() {
    return money(this.positions.filter((p) => p.status === "open").reduce((s, p) => s + p.cost, 0));
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }

  tap(req: TapRequest, now = Date.now()): Promise<Position> {
    return this.run(async () => {
      const L = this.limits;
      if (!(req.win >= L.minWin && req.win <= L.maxWin)) {
        throw new TapError(`win amount must be $${L.minWin} to $${L.maxWin}`);
      }
      if (!(req.lo >= 0.01 && req.hi <= 0.99 + 1e-9 && req.hi > req.lo)) throw new TapError("box is outside the tradable range");
      if (req.deadline < now + L.minLeadMs) throw new TapError("that column is closing, pick a later one");
      if (req.deadline > now + L.maxLeadMs) throw new TapError("that deadline is too far out");
      const q = this.quoteOf(req.symbol);
      if (!q) throw new TapError("no live price for this contract yet");
      if (now - q.t > 5 * 60_000) throw new TapError("price is stale, market may be paused");

      // Planned from the server's own quote, never from a price the client sent.
      const plan = planTap(q, px(req.lo), px(req.hi), req.win);
      if (plan.cost > this.balance + 1e-9) throw new TapError(`that square needs $${Math.ceil(plan.cost)} to win $${req.win}; not enough balance`);
      if (this.exposure() + plan.cost > L.maxExposure + 1e-9) {
        throw new TapError(`open positions are capped at $${L.maxExposure}`);
      }

      const fill = await this.broker.buy(req.symbol, plan.side, plan.quantity, plan.entry);
      const cost = money(fill.price * fill.quantity);
      this.balance = money(this.balance - cost);
      const p: Position = {
        id: randomUUID(),
        symbol: req.symbol,
        label: req.label,
        lo: px(req.lo),
        hi: px(req.hi),
        deadline: req.deadline,
        side: plan.side,
        quantity: fill.quantity,
        entry: fill.price,
        target: plan.target,
        best: sideQuote(q, plan.side).bid ?? 0,
        cost,
        status: "open",
        openedAt: now,
      };
      this.positions.push(p);
      this.onChange(p, this);
      return p;
    });
  }

  private async settle(p: Position, status: PositionStatus, limit: number, now: number) {
    const fill = await this.broker.sell(p.symbol, p.side, p.quantity, limit);
    if (p.status !== "open") return;
    p.status = status;
    p.exit = fill.price;
    p.closedAt = now;
    p.pnl = money(fill.quantity * (fill.price - p.entry));
    this.balance = money(this.balance + fill.quantity * fill.price);
    this.onChange(p, this);
  }

  /** Call on every quote: fills resting sells the market has reached. */
  onQuote(q: Quote, now = Date.now()) {
    for (const p of this.positions) {
      if (p.status !== "open" || p.symbol !== q.symbol) continue;
      const bid = sideQuote(q, p.side).bid;
      if (bid === null) continue;
      if (bid > p.best) p.best = bid;
      if (bid >= p.target - 1e-9) {
        void this.run(() => this.settle(p, "won", p.target, now)).catch(() => {});
      }
    }
  }

  /**
   * Call on a timer: exits positions whose deadline has passed, at the market.
   * If nobody is bidding at that moment the sell fails and is retried on the
   * next sweep, so a position is never dumped into an empty book at zero.
   */
  sweep(now = Date.now()) {
    for (const p of this.positions) {
      if (p.status !== "open" || now < p.deadline) continue;
      // A gapped book (one side pulled for a moment) is a terrible price to exit at. Give the
      // market a short grace period to come back before selling into whatever is there.
      const q = this.quoteOf(p.symbol);
      const gapped = !q || q.bid === null || q.ask === null || q.ask - q.bid > 0.1;
      if (gapped && now < p.deadline + EXIT_GRACE_MS) continue;
      void this.run(() => this.settle(p, "expired", 0, now)).catch(() => {});
    }
  }

  /** The user closes a position early, at the market. */
  close(id: string, now = Date.now()): Promise<Position> {
    return this.run(async () => {
      const p = this.positions.find((x) => x.id === id);
      if (!p) throw new TapError("no such position");
      if (p.status === "open") await this.settle(p, "closed", 0, now);
      return p;
    });
  }

  /** Resolves once queued trades have finished. */
  idle() {
    return this.queue;
  }
}

import assert from "node:assert/strict";
import { test } from "node:test";
import { Account, PaperBroker, planTap, TapError } from "../src/server/engine.ts";
import type { Quote } from "../src/server/gemini.ts";

const SYM = "GEMI-TEST-M-HOME";
const T0 = 1_000_000;

function setup(bid = 0.6, ask = 0.61, balance = 1000) {
  const q: Quote = { symbol: SYM, bid, ask, bidSize: 100, askSize: 100, t: T0 };
  const quoteOf = (s: string) => (s === SYM ? q : undefined);
  const origOnQuote = (qq: Quote, t: number) => {
    // Route every quote through the shared object so the paper broker prices off it.
    q.bid = qq.bid; q.ask = qq.ask; q.t = qq.t;
    return t;
  };
  const acct = new Account(balance, new PaperBroker(quoteOf), quoteOf);
  const move = (b: number | null, a: number | null, t = T0) => {
    q.bid = b;
    q.ask = a;
    q.t = t;
    acct.onQuote(q, t);
  };
  const tap = (lo: number, hi: number, stake = 10, deadline = T0 + 60_000) =>
    acct.tap({ symbol: SYM, label: "Home", lo, hi, deadline, stake }, T0);
  const onQuote = acct.onQuote.bind(acct);
  acct.onQuote = (qq: Quote, t = Date.now()) => { origOnQuote(qq, t); onQuote(q, t); };
  return { acct, move, tap };
}

test("box above the line buys YES and rests a sell at the box's near edge", async () => {
  const { acct, tap } = setup();
  const p = await tap(0.65, 0.66);
  assert.equal(p.side, "yes");
  assert.equal(p.entry, 0.61);
  assert.equal(p.target, 0.65);
  assert.equal(p.quantity, 16.39); // floor(10 / 0.61 * 100) / 100
  assert.equal(acct.balance, 1000 - p.cost);
});

test("box below the line buys NO, priced off the YES bid", async () => {
  const { tap } = setup();
  const p = await tap(0.54, 0.55);
  assert.equal(p.side, "no");
  assert.equal(p.entry, 0.4); // 1 - yes bid 0.60
  assert.equal(p.target, 0.45); // 1 - box top 0.55
});

test("hit: line reaches the box and the position is sold at the target", async () => {
  const { acct, move, tap } = setup();
  const p = await tap(0.65, 0.66);
  move(0.63, 0.64);
  await acct.idle();
  assert.equal(p.status, "open");
  move(0.65, 0.66);
  await acct.idle();
  assert.equal(p.status, "won");
  assert.equal(p.exit, 0.65);
  assert.equal(p.pnl, 0.6556); // 16.39 * (0.65 - 0.61)
  assert.equal(acct.balance, 1000.6556);
});

test("downward hit: YES ask falls to the box top", async () => {
  const { acct, move, tap } = setup();
  const p = await tap(0.54, 0.55);
  move(0.54, 0.55); // NO bid = 1 - 0.55 = 0.45 = target
  await acct.idle();
  assert.equal(p.status, "won");
  assert.ok(p.pnl! > 0);
});

test("miss: at the deadline the position exits at the market, not at zero", async () => {
  const { acct, move, tap } = setup();
  const p = await tap(0.65, 0.66);
  move(0.58, 0.59);
  acct.sweep(T0 + 59_000);
  await acct.idle();
  assert.equal(p.status, "open");
  acct.sweep(T0 + 60_000);
  await acct.idle();
  assert.equal(p.status, "expired");
  assert.equal(p.exit, 0.58);
  assert.equal(p.pnl, -0.4917); // 16.39 * (0.58 - 0.61)
  assert.equal(acct.balance, 1000 - 0.4917);
});

test("a position is settled only once even if hit and deadline race", async () => {
  const { acct, move, tap } = setup();
  const p = await tap(0.65, 0.66);
  move(0.65, 0.66, T0 + 60_000);
  acct.sweep(T0 + 60_000);
  await acct.idle();
  assert.equal(p.status, "won");
  assert.equal(acct.balance, 1000.6556);
});

test("manual close sells at the current bid", async () => {
  const { acct, move, tap } = setup();
  const p = await tap(0.65, 0.66);
  move(0.62, 0.63);
  await acct.close(p.id);
  assert.equal(p.status, "closed");
  assert.equal(p.exit, 0.62);
});

test("refusals", async () => {
  const { acct, tap } = setup(0.6, 0.61, 20);
  await assert.rejects(tap(0.6, 0.61), /on the line/); // spread box
  await assert.rejects(tap(0.61, 0.62), /on the line/); // touching the ask: no profit after the spread
  await assert.rejects(tap(0.65, 0.66, 0.5), /stake must be/);
  await assert.rejects(tap(0.65, 0.66, 500), /stake must be/);
  await assert.rejects(tap(0.65, 0.66, 10, T0 + 1000), /closing/);
  await assert.rejects(tap(0.65, 0.66, 50), /not enough balance/);
  await assert.rejects(tap(0.995, 1.0), /outside/);
  await assert.rejects(acct.tap({ symbol: "NOPE", label: "", lo: 0.65, hi: 0.66, deadline: T0 + 60_000, stake: 5 }, T0), TapError);
  assert.equal(acct.balance, 20);
  assert.equal(acct.positions.length, 0);
});

test("two simultaneous taps cannot overspend the balance", async () => {
  const { acct, tap } = setup(0.6, 0.61, 15);
  const results = await Promise.allSettled([tap(0.65, 0.66, 10), tap(0.66, 0.67, 10)]);
  assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
  assert.ok(acct.balance >= 0);
});

test("exposure cap", async () => {
  const { tap } = setup();
  for (let i = 0; i < 5; i++) await tap(0.65, 0.66, 100);
  await assert.rejects(tap(0.65, 0.66, 100), /capped/);
});

test("one-sided quote: a NO position still fills when only the ask is there", async () => {
  const { acct, tap } = setup();
  const p = await tap(0.54, 0.55); // NO, hit when YES ask <= 0.55
  acct.onQuote({ symbol: SYM, bid: null, ask: 0.55, bidSize: 0, askSize: 10, t: T0 }, T0);
  await acct.idle();
  assert.equal(p.status, "won");
});

test("wide spread: the mid crossing the box is not a hit, the bid has to get there", async () => {
  const { acct, move, tap } = setup();
  const p = await tap(0.65, 0.66);
  move(0.6, 0.72); // mid 0.66 is inside the box, but nobody bids 0.65
  await acct.idle();
  assert.equal(p.status, "open");
  assert.equal(p.best, 0.6);
  move(0.64, 0.7);
  await acct.idle();
  assert.equal(p.best, 0.64); // closest it got: 1 cent short
});

test("deadline with nobody bidding waits instead of selling at zero", async () => {
  const { acct, tap } = setup();
  const p = await tap(0.65, 0.66);
  acct.onQuote({ symbol: SYM, bid: null, ask: 0.7, bidSize: 0, askSize: 10, t: T0 + 60_000 }, T0 + 60_000);
  acct.sweep(T0 + 60_000);
  await acct.idle();
  assert.equal(p.status, "open");
  acct.onQuote({ symbol: SYM, bid: 0.59, ask: 0.6, bidSize: 10, askSize: 10, t: T0 + 61_000 }, T0 + 61_000);
  acct.sweep(T0 + 61_000);
  await acct.idle();
  assert.equal(p.status, "expired");
  assert.equal(p.exit, 0.59);
});

test("deadline in a gapped book waits for the market, then exits anyway after the grace period", async () => {
  const { acct, move, tap } = setup();
  const p = await tap(0.65, 0.66);
  move(0.3, 0.75, T0 + 60_000); // one side pulled: bid collapses
  acct.sweep(T0 + 60_000);
  await acct.idle();
  assert.equal(p.status, "open");
  move(0.58, 0.6, T0 + 65_000); // market comes back
  acct.sweep(T0 + 65_000);
  await acct.idle();
  assert.equal(p.status, "expired");
  assert.equal(p.exit, 0.58);

  const p2 = await tap(0.65, 0.66);
  move(0.3, 0.75, T0 + 60_000);
  acct.sweep(T0 + 81_000); // still gapped after 20s: exit at what's there
  await acct.idle();
  assert.equal(p2.status, "expired");
  assert.equal(p2.exit, 0.3);
});

test("one-sided market refuses new taps", async () => {
  const { acct, tap } = setup();
  acct.onQuote({ symbol: SYM, bid: null, ask: 0.61, bidSize: 0, askSize: 10, t: T0 }, T0);
  await assert.rejects(tap(0.65, 0.66), /one-sided/);
});

test("planTap multiple matches what a hit pays", () => {
  const q: Quote = { symbol: SYM, bid: 0.15, ask: 0.18, bidSize: 1, askSize: 1, t: T0 };
  const plan = planTap(q, 0.25, 0.26, 10);
  assert.equal(plan.side, "yes");
  assert.ok(Math.abs(plan.multiple - 0.25 / 0.18) < 1e-9);
  assert.equal(plan.profitIfHit, 3.8885); // 55.55 contracts * 0.07
});

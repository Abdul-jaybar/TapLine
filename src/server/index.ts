import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { Account, DEFAULT_LIMITS, PaperBroker, TapError, type Position } from "./engine.ts";
import { Feed, fetchLiveGames, type Game, type Move, type Quote } from "./gemini.ts";

const feed = new Feed();
feed.start();

// ---- live games, refreshed in the background so requests never wait on Gemini ----
let games: Game[] = [];
let gamesError: string | null = null;

async function refreshGames() {
  try {
    games = await fetchLiveGames();
    gamesError = null;
    for (const g of games) for (const m of g.markets) for (const c of m.contracts) feed.seed(c.symbol, c.bid, c.ask);
    // Keep the busiest games' winner markets streaming so their charts have history on open.
    feed.subscribe(games.slice(0, 12).flatMap((g) => g.markets[0]?.contracts.map((c) => c.symbol) ?? []));
  } catch (err) {
    gamesError = err instanceof Error ? err.message : String(err);
    console.error("game refresh failed:", gamesError);
  }
}
void refreshGames();
setInterval(refreshGames, 120_000);

// ---- sessions: one paper account per browser ----
type Listener = (event: string, data: unknown) => void;
interface Session {
  account: Account;
  listeners: Set<Listener>;
}
const sessions = new Map<string, Session>();
const PAPER_START = 1000;

function sessionFor(id: string): Session {
  let s = sessions.get(id);
  if (!s) {
    const listeners = new Set<Listener>();
    const quoteOf = (sym: string) => feed.quote(sym);
    const account = new Account(PAPER_START, new PaperBroker(quoteOf), quoteOf, (p, a) => {
      for (const l of listeners) l("position", { position: p, balance: a.balance });
    });
    sessions.set(id, (s = { account, listeners }));
  }
  return s;
}

feed.on("quote", (q: Quote) => {
  for (const s of sessions.values()) s.account.onQuote(q);
});
setInterval(() => {
  for (const s of sessions.values()) s.account.sweep();
}, 250);

const SESSION_ID = /^[a-zA-Z0-9_-]{8,64}$/;
const SYMBOL = /^GEMI-[A-Z0-9-]{3,80}$/;
const knownContract = (symbol: string) => {
  for (const g of games) for (const m of g.markets) for (const c of m.contracts) if (c.symbol === symbol) return c;
  return undefined;
};

/** The contracts of a game whose moves we stream as live activity, main markets first. */
function gameContracts(gameId: string, cap = 160) {
  const g = games.find((x) => x.id === gameId);
  const out = new Map<string, { market: string; label: string }>();
  for (const m of g?.markets ?? []) {
    for (const c of m.contracts) {
      if (out.size >= cap) break;
      if (c.bid !== null || c.ask !== null) out.set(c.symbol, { market: m.name, label: c.label });
    }
  }
  return out;
}

const app = new Hono();

app.get("/api/games", (c) => c.json({ games, error: games.length ? null : gamesError, loading: !games.length && !gamesError }));

app.get("/api/account", (c) => {
  const sid = c.req.query("sid") ?? "";
  if (!SESSION_ID.test(sid)) return c.json({ error: "bad session" }, 400);
  const { account } = sessionFor(sid);
  return c.json({
    mode: account.mode,
    balance: account.balance,
    limits: DEFAULT_LIMITS,
    positions: account.positions.slice(-200),
  });
});

app.post("/api/tap", async (c) => {
  const b = await c.req.json<{ sid?: string; symbol?: string; lo?: number; hi?: number; deadline?: number; stake?: number }>();
  if (!SESSION_ID.test(b.sid ?? "")) return c.json({ error: "bad session" }, 400);
  const contract = SYMBOL.test(b.symbol ?? "") ? knownContract(b.symbol!) : undefined;
  if (!contract) return c.json({ error: "unknown contract" }, 400);
  if (![b.lo, b.hi, b.deadline, b.stake].every((n) => typeof n === "number" && Number.isFinite(n))) {
    return c.json({ error: "bad request" }, 400);
  }
  try {
    const position = await sessionFor(b.sid!).account.tap({
      symbol: contract.symbol,
      label: contract.label,
      lo: b.lo!,
      hi: b.hi!,
      deadline: b.deadline!,
      stake: b.stake!,
    });
    return c.json({ position });
  } catch (err) {
    if (err instanceof TapError) return c.json({ error: err.message }, 409);
    console.error(err);
    return c.json({ error: "order failed" }, 500);
  }
});

app.post("/api/close", async (c) => {
  const b = await c.req.json<{ sid?: string; id?: string }>();
  if (!SESSION_ID.test(b.sid ?? "") || typeof b.id !== "string") return c.json({ error: "bad request" }, 400);
  try {
    return c.json({ position: await sessionFor(b.sid!).account.close(b.id) });
  } catch (err) {
    return c.json({ error: err instanceof TapError ? err.message : "close failed" }, 409);
  }
});

/** Live quotes for one contract plus this session's position updates. */
app.get("/api/stream", (c) => {
  const sid = c.req.query("sid") ?? "";
  const symbol = c.req.query("symbol") ?? "";
  if (!SESSION_ID.test(sid) || !SYMBOL.test(symbol) || !knownContract(symbol)) return c.json({ error: "bad request" }, 400);
  feed.subscribe([symbol]);
  const session = sessionFor(sid);
  // Every real price move anywhere in this game, so the screen shows the game's action.
  const activity = gameContracts(c.req.query("game") ?? "");
  feed.subscribe([...activity.keys()]);

  return streamSSE(c, async (stream) => {
    const send = (event: string, data: unknown) => void stream.writeSSE({ event, data: JSON.stringify(data) }).catch(() => {});
    send("history", { symbol, ticks: feed.ticks(symbol, Date.now() - 30 * 60_000), now: Date.now() });
    const onQuote = (q: Quote) => {
      if (q.symbol === symbol) send("quote", { t: q.t, bid: q.bid, ask: q.ask, bidSize: q.bidSize, askSize: q.askSize });
    };
    const onMove = (m: Move) => {
      const info = activity.get(m.symbol);
      if (info) send("move", { ...m, ...info });
    };
    const onPosition: Listener = (event, data) => send(event, data);
    feed.on("quote", onQuote);
    feed.on("move", onMove);
    session.listeners.add(onPosition);
    const beat = setInterval(() => send("ping", { now: Date.now(), feed: feed.connected }), 5000);
    await new Promise<void>((resolve) => stream.onAbort(resolve));
    clearInterval(beat);
    feed.off("quote", onQuote);
    feed.off("move", onMove);
    session.listeners.delete(onPosition);
  });
});

app.use("/*", serveStatic({ root: "./public" }));

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => console.log(`TapLine running at http://localhost:${port} (orders: paper)`));

export type { Position };

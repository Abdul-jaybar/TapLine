# TapLine

Tap the live odds line. One-tap trading on Gemini prediction markets for live games.

Built for the University Blockchain Conference 2026 hackathon.

## What it does

Trading a live game on a prediction market means finding the contract, typing a price and a size, and repeating that every time the game swings. TapLine replaces it with one screen:

- A game's live odds run across a grid as a line, streamed from Gemini in real time.
- Each box is a price level and a deadline. Tap a box above the line if you think the odds will rise to it in time, or below if you think they'll fall.
- A hit sells automatically at the box and pays the move. A miss exits at the market price when the deadline passes, so a miss is not a total loss.

Every tap is built from ordinary Gemini orders, so all volume lands on Gemini's own markets.

## How a tap becomes orders

Gemini contracts settle at the end of the game, not in 30 seconds, so a box is a bracket of orders (see `src/server/engine.ts`):

| You tap | Orders |
|---|---|
| A box above the line | Buy YES now, rest a sell at the box's near edge |
| A box below the line | Buy NO now, rest a sell where YES falls to the box's near edge |
| The deadline passes | Cancel the resting sell, exit at the market |

The number in each box is the payout multiple if it hits: target price divided by entry price.

## Run it

```bash
npm install
```

```bash
npm start
```

Open http://localhost:8787. No API key is needed: market data is public and orders are paper-filled.

```bash
npm test
```

## Status

| Piece | State |
|---|---|
| Live games, markets and contracts from Gemini | Working, live production data |
| Real-time prices over Gemini's WebSocket | Working |
| Grid, tap to trade, positions, timeouts | Working, checked in a browser at desktop and phone sizes |
| Tap engine (entry, target, deadline, limits) | Working, covered by `npm test` |
| Order fills | Paper: filled at the live best bid/ask, starting balance $1,000 |
| Real Gemini orders | Not built yet. `Broker` in `engine.ts` is the interface to implement |
| Log in with Gemini (OAuth) | Not built yet |

Paper fills ignore order-book depth and fees, so real results will be somewhat worse than paper results.

## Safety limits

Enforced on the server for every tap (`DEFAULT_LIMITS` in `engine.ts`): $1 to $100 per tap, at most $500 in open positions, and the price is always taken from the server's own quote, never from the browser.

## Layout

- `src/server/gemini.ts`: game discovery (REST) and the live quote feed (WebSocket)
- `src/server/engine.ts`: the tap engine and paper broker
- `src/server/index.ts`: HTTP API and the per-browser event stream
- `public/`: the grid UI (plain JavaScript on a canvas, no build step)
- `test/engine.test.ts`: engine tests

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
| A box above the line | Buy YES now, rest a sell at the box's near edge. Hit when the YES bid reaches it |
| A box below the line | Buy NO now, rest a sell where YES falls to the box's near edge. Hit when the YES ask falls to it |
| The deadline passes | Cancel the resting sell, exit at the market |

The amount you pick ($1, $5, $10, $25 or a custom amount) can mean one of two things, switched with the Win / Size toggle:

- **Win** (default): the amount is what a hit pays. The move from entry to a square is only a few cents per contract, so the order is sized to pay it: contracts = amount / (target price - entry price). Each empty square shows what that position costs. A square one cent away needs a large position; a far square needs a small one.
- **Size**: the amount is what you put in: contracts = amount / entry price. Each empty square shows what it would win.

**Max per square** (default $250) is your own cap on what one square may cost. A square that would cost more is dimmed and can't be tapped, so a small win never ties up a large amount by accident. A miss exits at the market price, so the loss depends on how far the price moved against you.

The chart draws the bid/ask band, not just the middle line, because hits are judged on the band's edges: when the spread is wide, the middle line can cross a box that nobody would actually buy from you at. A miss says how close it got ("Missed by 2¢").

## Run it

```bash
npm install
```

```bash
npm start
```

Open http://localhost:8787. No API key is needed: market data is public and orders are paper-filled.

### Hosted version (no server)

`public/` also runs on its own as a static site, which is how it's hosted on Vercel (`vercel.json`). With no TapLine server to talk to, the page connects to Gemini's public market data directly from the browser and runs the paper engine itself (`public/local.js`), keeping the paper account in that browser's storage. Real orders will need the server, because an API secret can't live in a browser.

```bash
npm test
```

## Screens

- **Lobby**: the start screen. Pick a live game and press Join. Cards are tagged LIVE, CLOSING (priced but all but decided) or NO PRICE (can't be joined).
- **Game**: the grid. "Change" in the header goes back to the lobby; open positions keep running.
- **Summary**: balance, net profit, hit rate, won on hits, lost on misses, best streak, badges and recent results, from your most recent 200 squares.
- **Leaderboard**: a "coming soon" placeholder. Nothing is ranked yet.

## Status

| Piece | State |
|---|---|
| Live games, markets and contracts from Gemini | Working, live production data |
| Real-time prices over Gemini's WebSocket | Working |
| Grid, tap to trade, positions, timeouts | Working, checked in a browser at desktop and phone sizes |
| Tile animations, win and miss effects, sounds, vibration | Working. Sounds are synthesized in the browser and can be muted. Vibration works on Android; iPhones don't support it in the browser |
| Live moves from the rest of the game | Working: every 1¢ move in the game's main markets shows as a pill you can tap to jump to |
| Tap engine (entry, target, deadline, limits) | Working, covered by `npm test` |
| Order fills | Paper: filled at the live best bid/ask, starting balance $10,000 |
| Real Gemini orders | Not built yet. `Broker` in `engine.ts` is the interface to implement |
| Log in with Gemini (OAuth) | Not built yet |

Paper fills ignore order-book depth and fees, so real results will be somewhat worse than paper results.

## Safety limits

Enforced for every tap (`DEFAULT_LIMITS` in `engine.ts`, mirrored in `public/local.js`): the amount is $0.50 to $500, one square can cost at most your max per square and never more than $2,500, at most $5,000 can sit in open positions, a position can't cost more than the balance, and the price is always taken from the engine's own quote, never from what the page drew. The paper account starts at $10,000.

## Look

The palette and type follow Gemini (near-black, the orange of their Developer Platform mark, their green and red). Type is Barlow, a sign-lettering grotesque, and the line takes each team's colour the way Gemini's charts do. TapLine uses its own name and mark, not Gemini's logo.

Ambient motion (drifting motes, the light running along the line, the sweep across upcoming columns) is decoration. Everything that carries information is real data: the line and band are Gemini's bid and ask, the green/red bar by the line is the size resting at the best bid and ask, sparks on the band's edges fire when those orders change, and the pills are real price moves elsewhere in the game. When the market gaps or goes one-sided the grid says so and offers no squares.

## Layout

- `src/server/gemini.ts`: game discovery (REST) and the live quote feed (WebSocket)
- `src/server/engine.ts`: the tap engine and paper broker
- `src/server/index.ts`: HTTP API and the per-browser event stream
- `public/`: the grid UI (plain JavaScript on a canvas, no build step)
- `public/local.js`: the browser-only backend used when there is no server
- `test/engine.test.ts`: engine tests

## Demo video

`demo/` holds what built the one-minute demo: `record.cjs` captures real footage of the app on a live game (it taps real squares and logs the real outcomes; nothing is simulated), `cards.cjs` renders the title cards and captions, `sfx.py` recreates the app's sound cues at the real event times (screen capture has no audio), and `build.sh` cuts it together with the voiceover. The voiceover was generated with Higgsfield.

// Renders the title cards and caption overlays for the demo video as PNGs.
// Usage: node demo/cards.cjs <outDir>
const { chromium } = require("playwright");
const path = require("path");

const base = `
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700;800&display=swap">
  <style>
    * { box-sizing: border-box; margin: 0; }
    body { width: 1280px; height: 720px; font-family: Geist, system-ui, sans-serif; color: #fff; overflow: hidden; }
    .bg { background: radial-gradient(900px 560px at 30% 45%, rgba(38,221,249,.16), transparent 70%), linear-gradient(180deg, #06161b, #010304 62%); }
    .center { height: 720px; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 0 110px; }
    h1 { font-size: 76px; font-weight: 700; letter-spacing: -.035em; line-height: 1.04; }
    h2 { font-size: 46px; font-weight: 700; letter-spacing: -.03em; line-height: 1.1; }
    p { font-size: 26px; color: #9aa3a6; margin-top: 22px; line-height: 1.4; }
    .accent { color: #26ddf9; }
    .mark { width: 60px; height: 60px; border-radius: 18px; background: linear-gradient(135deg, #c8f8ff, #26ddf9); box-shadow: 0 0 60px rgba(38,221,249,.8); margin-bottom: 30px; }
    .glass { background: linear-gradient(180deg, rgba(255,255,255,.1), rgba(255,255,255,.05)); border: 1px solid rgba(255,255,255,.16); border-radius: 22px; box-shadow: inset 0 1px 0 rgba(255,255,255,.22), 0 16px 40px rgba(0,0,0,.5); }
    .steps { display: flex; gap: 18px; margin-top: 40px; align-items: center; }
    .step { padding: 22px 30px; font-size: 26px; font-weight: 600; }
    .arrow { color: #9aa3a6; font-size: 30px; }
    .small { font-size: 18px; color: #7d878a; margin-top: 34px; }
    .cap { position: absolute; left: 0; right: 0; bottom: 34px; display: flex; justify-content: center; }
    .cap div { padding: 14px 26px; font-size: 27px; font-weight: 600; letter-spacing: -.01em; background: rgba(4,14,17,.86); border: 1px solid rgba(255,255,255,.18); border-radius: 18px; box-shadow: 0 14px 34px rgba(0,0,0,.55); }
    .tag { position: absolute; right: 18px; top: 104px; font-size: 13px; font-weight: 600; letter-spacing: .04em; color: #c9d1d3; padding: 6px 12px; border-radius: 999px; background: rgba(4,14,17,.8); border: 1px solid rgba(255,255,255,.16); }
  </style>`;

const cards = {
  "card1.png": [`<body class="bg"><div class="center"><h1>Live games move fast.<br><span class="accent">Trading them doesn't.</span></h1></div></body>`, false],
  "card2.png": [`<body class="bg"><div class="center"><h2>To trade one swing, you have to</h2>
    <div class="steps"><div class="step glass">Find a contract</div><span class="arrow">→</span><div class="step glass">Type a price</div><span class="arrow">→</span><div class="step glass">Pick a size</div></div>
    <p>By then, the moment is gone.</p></div></body>`, false],
  "title.png": [`<body class="bg"><div class="center"><div class="mark"></div><h1>TapLine</h1><p>Gemini prediction markets, on one live screen.</p></div></body>`, false],
  "how.png": [`<body class="bg"><div class="center"><h2>One tap = ordinary <span class="accent">Gemini</span> orders</h2>
    <div class="steps"><div class="step glass">Buy now</div><span class="arrow">+</span><div class="step glass">Resting sell at your square</div><span class="arrow">+</span><div class="step glass">Timed exit</div></div>
    <p>So all the volume lands on Gemini's own markets.</p></div></body>`, false],
  "end.png": [`<body class="bg"><div class="center"><div class="mark"></div><h1>TapLine</h1><p class="accent" style="font-weight:600">Tap the live odds line.</p>
    <div class="small">Built on Gemini Prediction Markets · University Blockchain Conference 2026<br>This demo: real footage, live Gemini prices, paper orders.</div></div></body>`, false],
  "phonebg.png": [`<body class="bg"><div style="position:absolute;left:110px;top:0;height:720px;width:560px;display:flex;flex-direction:column;justify-content:center"><h2>Works on<br>your phone.</h2><p>Same live line.<br>Same one-tap squares.</p></div></body>`, false],
  // Phone bezel with a transparent screen: sits on top of the phone footage to round its corners.
  "phoneframe.png": [`<body><div style="position:absolute;left:806px;top:16px;width:333px;height:688px;border-radius:58px;border:14px solid #030b0d"></div>
    <div style="position:absolute;left:816px;top:26px;width:313px;height:668px;border-radius:48px;border:4px solid #2a3d42;box-shadow:0 0 50px rgba(38,221,249,.3)"></div></body>`, true],
  "cap_c.png": [`<body><div class="tag">REAL FOOTAGE · LIVE GEMINI PRICES · PAPER ORDERS</div><div class="cap"><div>The line is a team's <span class="accent">real odds</span>. Each square is a price and a deadline.</div></div></body>`, true],
  "cap_d.png": [`<body><div class="tag">REAL FOOTAGE · LIVE GEMINI PRICES · PAPER ORDERS</div><div class="cap"><div>Tap <span class="accent">above</span> if the odds will climb. Tap <span class="accent">below</span> if they'll fall.</div></div></body>`, true],
  "cap_e.png": [`<body><div class="tag">REAL FOOTAGE · LIVE GEMINI PRICES · PAPER ORDERS</div><div class="cap"><div>Odds reach your square: it <span class="accent">sells automatically</span>.</div></div></body>`, true],
  "cap_f.png": [`<body><div class="tag">REAL FOOTAGE · LIVE GEMINI PRICES · PAPER ORDERS</div><div class="cap"><div>Miss? You exit at the market price. <span class="accent">Not a total loss.</span></div></div></body>`, true],
};

(async () => {
  const out = process.argv[2];
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  for (const [name, [html, transparent]] of Object.entries(cards)) {
    await page.setContent(`<!doctype html><html><head>${base}</head>${html}</html>`, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(out, name), omitBackground: transparent });
  }
  await browser.close();
  console.log("cards:", Object.keys(cards).length);
})();

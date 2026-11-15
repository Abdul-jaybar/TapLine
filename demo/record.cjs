// Records real footage of TapLine for the demo video.
// Usage: node demo/record.cjs <outDir> <width> <height> <seconds> [port]
// Captures the page with Chrome's screencast (frames + timestamps) while tapping real squares on a
// live game. Nothing is simulated: every result in the footage is the app's real outcome. The only
// thing added is a visible cursor, because screen capture doesn't include one.
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

(async () => {
  const [outDir, w = "1280", h = "720", secs = "180", port = "8790"] = process.argv.slice(2);
  fs.mkdirSync(path.join(outDir, "frames"), { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: 1.5, hasTouch: +w < 600 });
  await page.addInitScript(() => {
    addEventListener("DOMContentLoaded", () => {
      const c = document.createElement("div");
      c.style.cssText = "position:fixed;z-index:99999;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;border:2px solid #fff;background:rgba(255,255,255,.25);box-shadow:0 2px 8px rgba(0,0,0,.6);pointer-events:none;left:-50px;top:-50px;transition:transform .12s";
      document.body.appendChild(c);
      addEventListener("pointermove", (e) => { c.style.left = e.clientX + "px"; c.style.top = e.clientY + "px"; }, true);
      addEventListener("pointerdown", () => (c.style.transform = "scale(.7)"), true);
      addEventListener("pointerup", () => (c.style.transform = ""), true);
    });
  });
  await page.route("**/app.js", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, body: (await res.text()) + "\nwindow.__t = { state, boxAt, dims: () => ({ W, H, NOW_AT, CELL_W, CELL_H }) };\n" });
  });
  await page.goto(`http://localhost:${port}/`);
  await page.waitForFunction(() => document.getElementById("empty").hidden, null, { timeout: 180000 });

  const cdp = await page.context().newCDPSession(page);
  const frames = []; const t0 = Date.now(); let n = 0;
  cdp.on("Page.screencastFrame", async (f) => {
    const file = `f${String(n++).padStart(6, "0")}.jpg`;
    fs.writeFile(path.join(outDir, "frames", file), Buffer.from(f.data, "base64"), () => {});
    frames.push({ file, t: (Date.now() - t0) / 1000 });
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: 1920, maxHeight: 1920, everyNthFrame: 1 });

  const log = []; const mark = (what, extra = {}) => { const e = { t: +((Date.now() - t0) / 1000).toFixed(2), what, ...extra }; log.push(e); console.log(JSON.stringify(e)); };
  const box = await page.locator("#grid").boundingBox();
  const targets = () => page.evaluate(() => {
    const { boxAt, dims, state } = window.__t; const d = dims(); const out = [];
    for (let c = 1; c <= 5; c++) for (let y = 14; y < d.H - 40; y += d.CELL_H / 3) {
      const x = d.W * d.NOW_AT + d.CELL_W * (c + 0.5), r = boxAt(x, y);
      if (r && !out.some((o) => o.c === c && o.lo === r.lo)) out.push({ x, y: y + d.CELL_H / 6, c, lo: r.lo, side: r.plan.side, mult: r.plan.multiple });
    }
    return { out, quote: state.quote, thin: state.thin };
  });
  const glide = async (x, y) => { await page.mouse.move(box.x + x, box.y + y, { steps: 14 }); await page.waitForTimeout(160); };
  const tap = async (t) => { await glide(t.x, t.y); await page.mouse.down(); await page.waitForTimeout(90); await page.mouse.up(); mark("tap", { side: t.side, lo: t.lo, mult: +t.mult.toFixed(3) }); await page.waitForTimeout(260); };

  // Watch real outcomes.
  const seen = new Map();
  const poll = setInterval(async () => {
    try {
      const ps = await page.evaluate(() => window.__t.state.positions.map((p) => ({ id: p.id, status: p.status, pnl: p.pnl, side: p.side, lo: p.lo })));
      for (const p of ps) { if (seen.get(p.id) !== p.status) { if (seen.has(p.id) || p.status !== "open") mark("result", p); seen.set(p.id, p.status); } }
    } catch {}
  }, 400);

  mark("start", { game: await page.locator("#gameTitle").innerText() });
  await page.waitForTimeout(3500);
  // 1) look around: hover a few squares
  let t = await targets();
  for (const o of t.out.filter((o) => o.c >= 2).slice(0, 4)) { await glide(o.x, o.y); await page.waitForTimeout(650); }
  mark("hovered");
  // 2) keep tapping the squares nearest the band on both sides
  const end = Date.now() + (+secs) * 1000; let round = 0;
  while (Date.now() < end) {
    t = await targets();
    if (t.thin || !t.out.length) { await page.waitForTimeout(1500); continue; }
    const ups = t.out.filter((o) => o.side === "yes").sort((a, b) => a.lo - b.lo || a.c - b.c);
    const dns = t.out.filter((o) => o.side === "no").sort((a, b) => b.lo - a.lo || a.c - b.c);
    const picks = [ups.find((o) => o.c === 2), dns.find((o) => o.c === 2), ups.find((o) => o.c === 3), round % 2 ? dns.find((o) => o.c === 4) : ups.filter((o) => o.c === 3)[1]].filter(Boolean);
    for (const o of picks) await tap(o);
    round++;
    if (round === 3) { await page.click("#stakes button:nth-child(3)"); mark("stake10"); }
    if (round === 6) { await page.click("#cols button:nth-child(3)"); mark("col30"); }
    await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.5, { steps: 10 });
    await page.waitForTimeout(round < 6 ? 5200 : 9000);
  }
  // 3) positions sheet and game list
  await page.click("#posBtn"); mark("positions"); await page.waitForTimeout(3200); await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  await page.click("#gameBtn"); mark("games"); await page.waitForTimeout(3200); await page.keyboard.press("Escape");
  await page.waitForTimeout(1500);
  mark("end", { balance: await page.locator("#balance").innerText() });
  clearInterval(poll);
  await cdp.send("Page.stopScreencast");
  await page.waitForTimeout(500);
  fs.writeFileSync(path.join(outDir, "frames.json"), JSON.stringify(frames));
  fs.writeFileSync(path.join(outDir, "log.json"), JSON.stringify(log, null, 1));
  console.log("frames:", frames.length, "duration:", frames.at(-1)?.t);
  await browser.close();
})();

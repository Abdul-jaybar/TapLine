// Drives TapLine in a headless browser: loads a live game, taps boxes, reports what happened.
// Usage: node scripts/browser-check.cjs <screenshot-prefix> [width] [height]
const { chromium } = require("playwright");

(async () => {
  const [prefix, w = "1200", h = "760"] = process.argv.slice(2);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: 1 });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => m.type() === "error" && errors.push("console: " + m.text()));

  await page.goto(`http://localhost:${process.env.PORT ?? 8790}/`);
  await page.waitForFunction(() => document.getElementById("empty").hidden, null, { timeout: 120000 });
  await page.waitForTimeout(2500);
  console.log("game:", await page.locator("#gameTitle").innerText());
  console.log("markets:", await page.locator("#markets .tab").allInnerTexts());
  console.log("contracts:", (await page.locator("#contracts .chip").allInnerTexts()).map((s) => s.replace(/\n/g, " ")));
  await page.screenshot({ path: `${prefix}-1-loaded.png` });

  // Tap a box above the line and one below, two columns ahead of the present.
  const box = await page.locator("#grid").boundingBox();
  const narrow = box.width < 560;
  const colW = narrow ? 76 : 96;
  const x = box.x + box.width * (narrow ? 0.28 : 0.4) + colW * 2.5;
  for (const dy of [-44 * 2.5, 44 * 2.5]) {
    await page.mouse.move(x, box.y + box.height / 2 + dy);
    await page.waitForTimeout(150);
    await page.mouse.click(x, box.y + box.height / 2 + dy);
    await page.waitForTimeout(500);
  }
  await page.mouse.move(x + colW, box.y + box.height / 2 - 44 * 3.5);
  await page.waitForTimeout(400);
  console.log("after taps: balance", await page.locator("#balance").innerText(), "| open", await page.locator("#posCount").innerText());
  console.log("toasts:", await page.locator(".toast").allInnerTexts());
  await page.screenshot({ path: `${prefix}-2-tapped.png` });

  await page.click("#posBtn");
  await page.waitForTimeout(300);
  console.log("positions:", (await page.locator("#posList .row").allInnerTexts()).map((s) => s.replace(/\n/g, " | ")));
  await page.screenshot({ path: `${prefix}-3-positions.png` });
  await page.keyboard.press("Escape");

  await page.click("#gameBtn");
  await page.waitForTimeout(300);
  console.log("games listed:", await page.locator("#gameList .row").count());
  await page.screenshot({ path: `${prefix}-4-games.png` });

  console.log("overflow-x:", await page.evaluate(() => document.documentElement.scrollWidth > innerWidth));
  console.log("errors:", errors.length ? errors : "none");
  await browser.close();
})();

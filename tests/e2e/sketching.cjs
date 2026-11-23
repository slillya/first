// Hands-on sketch gestures in a phone-sized Chromium: chained lines with
// inferred relations, dragging with relations held, press-and-hold selection,
// arcs, erasing, and freehand clean-up.
// Usage: npm run build && npx vite preview --port 4173 &  then  node tests/e2e/sketching.cjs [outDir]
const { chromium, devices } = require("playwright");
const assert = require("node:assert/strict");
const path = require("node:path");

const URL = process.env.APP_URL || "http://localhost:4173/";
const OUT = process.argv[2] || "test-results";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices["iPhone 14"], defaultBrowserType: undefined });
  const page = await ctx.newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && problems.push(`console: ${m.text()}`));

  const sketch = () =>
    page.evaluate(() => {
      const id = JSON.parse(localStorage.getItem("napkin.current"));
      return JSON.parse(localStorage.getItem(`napkin.file.${id}`)).features.filter((f) => f.type === "sketch").at(-1);
    });
  const tool = async (label) => {
    await page.locator(".tools .pill").click();
    await page.locator(".tools .tool", { hasText: new RegExp(`^${label}$`) }).first().click();
    await sleep(450);
  };
  const at = (xy) => page.evaluate((p) => window.napkinDebug.sketch(p), xy);
  const dragMm = async (from, to, hold = 0) => {
    const a = await at(from);
    const b = await at(to);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    if (hold) await sleep(hold);
    await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
    await page.mouse.move(b.x, b.y, { steps: 4 });
    await page.mouse.up();
    await sleep(250);
  };
  const state = () => page.locator(".context-hint").textContent();

  await page.goto(URL);
  await page.waitForSelector(".center-note.quiet", { timeout: 60_000 });
  await tool("Front");

  // Three lines chained end to end into a triangle; the level one picks up a horizontal relation.
  await dragMm([-20, 0], [20, 0.6]);
  await dragMm([20, 0], [2, 24]);
  await dragMm([2, 24], [-20, 0]);
  let s = await sketch();
  const count = (t) => s.entities.filter((e) => e.type === t && e.id !== "origin").length;
  assert.equal(count("line"), 3);
  assert.equal(count("point"), 3, "chained lines should share their end points");
  assert.deepEqual(s.constraints.map((c) => c.type), ["horizontal"]);
  assert.match(await state(), /1 closed/);
  const [l1] = s.entities.filter((e) => e.type === "line");
  const yOf = (id) => s.entities.find((e) => e.id === id).y;
  assert.equal(yOf(l1.p1), yOf(l1.p2));

  // Drag the apex: it follows the finger, and the base stays horizontal.
  await tool("Select");
  const apex = s.entities.find((e) => e.type === "point" && e.y > 10);
  await dragMm([apex.x, apex.y], [8, 30]);
  s = await sketch();
  const moved = s.entities.find((e) => e.id === apex.id);
  assert.ok(Math.abs(moved.x - 8) < 0.6 && Math.abs(moved.y - 30) < 0.6, `apex did not follow the drag: ${moved.x}, ${moved.y}`);
  assert.equal(yOf(l1.p1), yOf(l1.p2));
  // Dragging the base line moves the triangle but keeps it level.
  await dragMm([7, yOf(l1.p1)], [7, yOf(l1.p1) - 6]); // clear of the origin point, which sits on this line
  s = await sketch();
  assert.ok(Math.abs(yOf(l1.p1) + 6) < 0.6, `base did not follow the drag: ${yOf(l1.p1)}`);
  assert.equal(yOf(l1.p1), yOf(l1.p2));

  // Press and hold selects, whatever tool is active.
  await tool("Line");
  const baseMid = await at([6, yOf(l1.p1)]);
  await page.mouse.move(baseMid.x, baseMid.y);
  await page.mouse.down();
  await sleep(650);
  await page.mouse.up();
  await sleep(200);
  assert.equal(await page.locator(".chip", { hasText: "Set dimension" }).count(), 1, "press and hold did not select the line");
  assert.equal((await sketch()).entities.filter((e) => e.type === "line").length, 3, "press and hold must not draw");
  await page.locator(".segmented.small button", { hasText: "Horizontal" }).click();
  await page.locator(".chip", { hasText: "Set dimension" }).click();
  await page.locator(".card input").fill("50");
  await page.locator(".card button[type=submit]").click();
  await sleep(300);
  s = await sketch();
  const xs = [l1.p1, l1.p2].map((id) => s.entities.find((e) => e.id === id).x);
  assert.ok(Math.abs(Math.abs(xs[1] - xs[0]) - 50) < 1e-3, "horizontal dimension on a line was not applied");
  await page.screenshot({ path: path.join(OUT, "20-sketch-gestures.png") });

  // Arc, then erase it.
  await tool("Arc");
  await dragMm([-30, 40], [-10, 40]);
  s = await sketch();
  assert.equal(s.entities.filter((e) => e.type === "arc").length, 1);
  await tool("Erase");
  const onArc = await at([-20, 30]); // the arc bulges below its chord (counter-clockwise from the start)
  await page.mouse.click(onArc.x, onArc.y);
  await sleep(250);
  s = await sketch();
  assert.equal(s.entities.filter((e) => e.type === "arc").length, 0, "erase did not remove the arc");
  assert.equal(s.entities.filter((e) => e.type === "point" && e.id !== "origin").length, 3, "the arc's points should go with it");

  // Freehand circle, cleaned up offline into a real circle.
  await tool("Freehand");
  const c = await at([-30, 45]);
  const rim = await at([-20, 45]);
  const r = Math.abs(rim.x - c.x);
  await page.mouse.move(c.x + r, c.y);
  await page.mouse.down();
  for (let i = 1; i <= 40; i++) {
    const a = (i / 39) * Math.PI * 2;
    await page.mouse.move(c.x + (r + Math.sin(i * 1.7)) * Math.cos(a), c.y + (r + Math.sin(i * 1.7)) * Math.sin(a));
  }
  await page.mouse.up();
  await sleep(200);
  await page.locator(".chip", { hasText: "Clean up" }).click();
  await sleep(300);
  s = await sketch();
  const circle = s.entities.find((e) => e.type === "circle");
  assert.ok(circle && Math.abs(circle.r - 10) <= 1.5, "freehand circle was not recognised");
  assert.match(await state(), /2 closed/);

  assert.deepEqual(problems, [], "page reported errors");
  console.log("sketching passed");
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

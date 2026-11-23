// End-to-end walkthrough in a phone-sized Chromium: sketch by hand, extrude,
// fillet, sketch on a face, then let a scripted "Claude" interpret finger ink.
// Usage: npm run build && npx vite preview --port 4173 &  then  node tests/e2e/walkthrough.cjs [outDir]
// Needs the `playwright` package and a Chromium it can launch.
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

  const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
  const doc = () => page.evaluate(() => JSON.parse(localStorage.getItem("napkin.doc.v1") || "{}"));
  const tool = async (label) => {
    await page.locator(".tools .pill").click();
    await page.locator(".tools .tool", { hasText: new RegExp(`^${label}$`) }).first().click();
    await sleep(450);
  };
  const chip = (label) => page.locator(".chip", { hasText: label }).click();
  const drag = async (pts) => {
    await page.mouse.move(pts[0][0], pts[0][1]);
    await page.mouse.down();
    for (const [x, y] of pts.slice(1)) await page.mouse.move(x, y, { steps: 3 });
    await page.mouse.up();
    await sleep(150);
  };
  const settle = async () => {
    await page.waitForFunction(() => !document.querySelector(".spinner.small") && !document.querySelector(".center-note .spinner"));
    await sleep(350);
  };

  await page.goto(URL);
  await page.waitForSelector(".center-note.quiet", { timeout: 60_000 });
  await shot("01-empty");

  // --- Sketch on the top plane: rectangle, circle, and a freehand hole -----
  await tool("Top");
  assert.equal(await page.locator(".tools .pill-title").textContent(), "Draw");
  await tool("Rect");
  await drag([[100, 240], [290, 400]]);
  await tool("Circle");
  await drag([[150, 320], [175, 320]]);
  await tool("Draw");
  const wobble = [];
  for (let i = 0; i <= 40; i++) {
    const a = (i / 39) * Math.PI * 2;
    const r = 20 + Math.sin(i * 1.7) * 1.5;
    wobble.push([240 + r * Math.cos(a), 320 + r * Math.sin(a)]);
  }
  await drag(wobble);
  await shot("02-sketch-ink");
  await chip("Clean up");
  await sleep(300);
  let d = await doc();
  assert.equal(d.features.length, 1);
  assert.deepEqual(d.features[0].profiles.map((p) => p.type), ["rect", "circle", "circle"]);

  // Type an exact width through a dimension label.
  const rect = d.features[0].profiles[0];
  await page.locator(".dim", { hasText: new RegExp(`^${rect.w}$`) }).first().click();
  await page.locator(".card input").fill("64");
  await page.locator(".card button[type=submit]").click();
  await sleep(300);
  d = await doc();
  assert.equal(d.features[0].profiles[0].w, 64);
  await tool("Fit");
  await shot("03-sketch-clean");

  // --- Extrude -----------------------------------------------------------
  await chip("Done");
  await sleep(500);
  await chip("Extrude");
  await settle();
  await page.locator(".card input").fill("12");
  await settle();
  await shot("04-extrude-sheet");
  await page.locator(".card button[type=submit]").click();
  await settle();
  d = await doc();
  assert.equal(d.features[1].type, "extrude");
  assert.equal(d.features[1].distance, 12);
  await tool("Fit");
  await shot("05-solid");

  // --- Pick an edge, fillet it -------------------------------------------
  // Find a vertical corner edge by scanning for a tap that selects an edge.
  const size = page.viewportSize();
  let picked = false;
  for (let y = 300; y < 520 && !picked; y += 6)
    for (let x = 40; x < size.width - 40 && !picked; x += 6) {
      await page.mouse.click(x, y);
      if (await page.locator(".chip-label", { hasText: "1 edge" }).count()) picked = true;
      else if (await page.locator(".chip", { hasText: "Clear" }).count()) await chip("Clear");
    }
  assert.ok(picked, "could not pick an edge");
  await shot("06-edge-selected");
  await chip("Fillet");
  await settle();
  await page.locator(".card button[type=submit]").click();
  await settle();
  d = await doc();
  assert.equal(d.features[2].type, "fillet");
  assert.equal(await page.locator(".badge.err").count(), 0, "fillet failed to build");
  await shot("07-fillet");

  // --- Feature tree ------------------------------------------------------
  await page.locator(".tree .pill").click();
  await page.locator(".row-main", { hasText: "Boss-Extrude1" }).click();
  await shot("08-tree");
  await page.locator(".tree .pill").click();

  // --- Navigation: orbit with a drag, pinch with two touches --------------
  await drag([[200, 420], [140, 380]]);
  const cdp = await ctx.newCDPSession(page);
  const touch = (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
  await touch("touchStart", [[150, 350], [240, 350]]);
  for (let i = 1; i <= 6; i++) await touch("touchMove", [[150 - i * 5, 350], [240 + i * 5, 350]]);
  await touch("touchEnd", []);
  await sleep(200);
  await shot("09-orbit-pinch");
  await tool("Iso");

  // --- Sketch on the top face, finger ink, scripted Claude ---------------
  let faced = false;
  for (let y = 250; y < 420 && !faced; y += 12)
    for (let x = 120; x < 280 && !faced; x += 12) {
      await page.mouse.click(x, y);
      if (await page.locator(".chip", { hasText: "Sketch here" }).count()) {
        faced = true;
      } else if (await page.locator(".chip", { hasText: "Clear" }).count()) await chip("Clear");
    }
  assert.ok(faced, "could not pick a planar face");
  await chip("Sketch here");
  await sleep(600);
  await drag([[150, 300], [152, 360], [230, 362], [232, 298], [151, 299]].flatMap(([x, y], i, a) => {
    if (!i) return [[x, y]];
    const [px, py] = a[i - 1];
    return Array.from({ length: 8 }, (_, k) => [px + ((x - px) * (k + 1)) / 8, py + ((y - py) * (k + 1)) / 8]);
  }));
  await shot("10-face-sketch-ink");

  const requests = [];
  await page.route("**/api/chat", async (route) => {
    const body = JSON.parse(route.request().postData());
    requests.push(body);
    const sse = (events) => route.fulfill({ status: 200, contentType: "text/event-stream", body: events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") });
    const message = (content, stop_reason) => ({ type: "message", message: { id: "msg_test", type: "message", role: "assistant", model: "test", content, stop_reason, usage: {} } });
    if (requests.length === 1) {
      const text = body.messages[0].content.find((b) => b.type === "text" && b.text.includes("<state>")).text;
      const sketchId = /sketching in "([^"]+)"/.exec(text)[1];
      return sse([
        { type: "tool", name: "update_feature" },
        message(
          [
            { type: "tool_use", id: "tu_1", name: "update_feature", input: { id: sketchId, changes: { name: "Pocket outline", profiles: [{ type: "rect", cx: 0, cy: 0, w: 16, h: 10, r: 2 }] } } },
            { type: "tool_use", id: "tu_2", name: "add_features", input: { features: [{ id: "pocket1", name: "Pocket", type: "extrude", sketch: sketchId, distance: 4, op: "cut" }] } },
            { type: "tool_use", id: "tu_3", name: "add_features", input: { features: [{ id: "bad", type: "extrude", sketch: sketchId, distance: -1, op: "cut" }] } },
          ],
          "tool_use",
        ),
      ]);
    }
    return sse([{ type: "text", text: "Cut a 16 × 10 mm pocket, " }, { type: "text", text: "4 mm deep." }, message([{ type: "text", text: "Cut a 16 × 10 mm pocket, 4 mm deep." }], "end_turn")]);
  });

  await page.locator(".composer textarea").click();
  await page.keyboard.type("pocket this 4 deep");
  await shot("11-composer-open");
  await page.locator(".composer button[aria-label=Send]").click();
  await page.waitForSelector(".reply:not(.live)");
  await settle();

  assert.equal(requests.length, 2);
  const first = requests[0].messages[0].content;
  assert.ok(first.some((b) => b.type === "image"), "no screenshot sent");
  const state = first.find((b) => b.type === "text" && b.text.includes("<state>")).text;
  assert.match(state, /ink: 1 finger stroke/);
  assert.match(state, /<request>pocket this 4 deep<\/request>/);
  const results = requests[1].messages[2].content;
  assert.equal(results.length, 3);
  assert.equal(JSON.parse(results[0].content).built, true);
  assert.equal(JSON.parse(results[1].content).built, true);
  assert.equal(results[2].is_error, true, "invalid tool input was not rejected");
  d = await doc();
  assert.deepEqual(d.features.map((f) => f.type), ["sketch", "extrude", "fillet", "sketch", "extrude"]);
  assert.equal(d.features[4].name, "Pocket");
  assert.equal(await page.locator(".tools .pill-title").textContent(), "Tools", "should have left sketch mode");
  assert.equal(await page.locator(".composer.open").count(), 0, "composer should fold after sending");
  assert.match(await page.locator(".reply-text").textContent(), /16 × 10 mm pocket/);
  await shot("12-claude-pocket");

  // --- Undo / redo -------------------------------------------------------
  await page.locator(".tools .pill").click();
  await page.locator(".tools .tool", { hasText: /^Undo$/ }).click();
  await settle();
  assert.equal((await doc()).features.length, 4);
  await page.locator(".tools .tool", { hasText: /^Redo$/ }).click();
  await settle();
  assert.equal((await doc()).features.length, 5);
  await page.locator(".viewport").click({ position: { x: 20, y: 600 } });

  // --- State survives a reload -------------------------------------------
  await page.reload();
  await page.waitForSelector(".tree .pill");
  await settle();
  assert.equal((await doc()).features.length, 5);
  await shot("13-reloaded");

  assert.deepEqual(problems, [], "page reported errors");
  console.log("walkthrough passed");
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

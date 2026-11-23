// End-to-end walkthrough in a phone-sized Chromium: constraint sketching with
// relations and smart/horizontal/vertical dimensions, extrude, a reference
// plane, a sketch snapped to model geometry, fillet, a scripted Claude turn,
// then files, an assembly and mates.
// Usage: npm run build && npx vite preview --port 4173 &  then  node tests/e2e/walkthrough.cjs [outDir]
// Needs the `playwright` package and a Chromium it can launch.
const { chromium, devices } = require("playwright");
const assert = require("node:assert/strict");
const path = require("node:path");

const URL = process.env.APP_URL || "http://localhost:4173/";
const OUT = process.argv[2] || "test-results";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b, tol = 1e-3) => assert.ok(Math.abs(a - b) <= tol, `expected ${a} ≈ ${b}`);

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices["iPhone 14"], defaultBrowserType: undefined });
  const page = await ctx.newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && problems.push(`console: ${m.text()}`));

  const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
  const doc = () =>
    page.evaluate(() => {
      const id = JSON.parse(localStorage.getItem("napkin.current"));
      return JSON.parse(localStorage.getItem(`napkin.file.${id}`));
    });
  const sketch = async (n = -1) => (await doc()).features.filter((f) => f.type === "sketch").at(n);
  const tool = async (label) => {
    await page.locator(".tools .pill").click();
    await page.locator(".tools .tool", { hasText: new RegExp(`^${label}$`) }).first().click();
    await sleep(450);
  };
  const chip = (label) => page.locator(".chip", { hasText: new RegExp(`^${label}$`) }).first().click();
  const drag = async (pts) => {
    await page.mouse.move(pts[0][0], pts[0][1]);
    await page.mouse.down();
    for (const [x, y] of pts.slice(1)) await page.mouse.move(x, y, { steps: 4 });
    await page.mouse.up();
    await sleep(200);
  };
  const settle = async () => {
    await page.waitForFunction(() => !document.querySelector(".spinner.small") && !document.querySelector(".center-note .spinner"));
    await sleep(400);
  };
  const onScreen = (xy) => page.evaluate((p) => window.napkinDebug.sketch(p), xy);
  const world = (p) => page.evaluate((q) => window.napkinDebug.project(q), p);
  /** Screen position to tap for a sketch entity: a point itself, the middle of a line, the rim of a circle. */
  const where = async (id) => {
    const s = await sketch();
    const by = Object.fromEntries(s.entities.map((e) => [e.id, e]));
    const e = by[id];
    if (e.type === "point") return onScreen([e.x, e.y]);
    // A third of the way along: clear of the relation badge that sits by the middle.
    if (e.type === "line") return onScreen([by[e.p1].x + (by[e.p2].x - by[e.p1].x) * 0.3, by[e.p1].y + (by[e.p2].y - by[e.p1].y) * 0.3]);
    return onScreen([by[e.c].x + e.r * Math.SQRT1_2, by[e.c].y - e.r * Math.SQRT1_2]);
  };
  const tapEnt = async (id) => {
    const p = await where(id);
    await page.mouse.click(p.x, p.y);
    await sleep(120);
  };
  const setValue = async (v) => {
    await page.locator(".card input").fill(String(v));
    await page.locator(".card button[type=submit]").click();
    await sleep(350);
  };
  const state = () => page.locator(".context-hint .state").textContent();

  await page.goto(URL);
  await page.waitForSelector(".center-note.quiet", { timeout: 60_000 });
  await shot("01-empty");

  // --- A rectangle: relations come with it, dimensions and position are added by hand -------
  await tool("Top");
  assert.equal(await page.locator(".tools .pill-title").textContent(), "Line");
  await tool("Rect");
  await drag([[110, 250], [283, 392]]);
  let s = await sketch();
  assert.deepEqual(s.constraints.map((c) => c.type), ["horizontal", "vertical", "horizontal", "vertical"]);
  assert.equal(await state(), "Under defined · 4 free");
  const lines = s.entities.filter((e) => e.type === "line").map((e) => e.id);

  await tool("Select");
  await tapEnt(lines[0]);
  await chip("Set dimension");
  await setValue(60);
  await tapEnt(lines[1]);
  await chip("Set dimension");
  await setValue(30);
  assert.equal(await state(), "Under defined · 2 free");
  await shot("02-rect-dimensioned");

  // Pin a corner to the sketch origin: select both points, Coincident.
  s = await sketch();
  const corner = s.entities.find((e) => e.type === "point" && e.id !== "origin").id;
  await tapEnt(corner);
  await tapEnt("origin");
  await chip("Coincident");
  await sleep(300);
  assert.equal(await state(), "Fully defined");
  s = await sketch();
  const c0 = s.entities.find((e) => e.id === corner);
  near(c0.x, 0);
  near(c0.y, 0);
  const xs = s.entities.filter((e) => e.type === "point").map((e) => e.x);
  near(Math.max(...xs) - Math.min(...xs), 60);
  await tool("Fit");

  // --- A hole placed with horizontal and vertical dimensions from the origin ---------------
  await tool("Circle");
  const cStart = await onScreen([22, 12]);
  const cEnd = await onScreen([27, 12]);
  await drag([[cStart.x, cStart.y], [cEnd.x, cEnd.y]]);
  s = await sketch();
  const circle = s.entities.find((e) => e.type === "circle");
  assert.ok(circle, "circle was not created");
  await tool("Dimension");
  await page.locator(".segmented.small button", { hasText: "Horizontal" }).click();
  await tapEnt(circle.c);
  await tapEnt("origin");
  await chip("Set dimension");
  await setValue(40);
  // Only x is pinned: the centre is still free to slide in y.
  s = await sketch();
  near(s.entities.find((e) => e.id === circle.c).x, 40);
  assert.equal(await state(), "Under defined · 2 free");
  await page.locator(".segmented.small button", { hasText: "Vertical" }).click();
  await tapEnt(circle.c);
  await tapEnt("origin");
  await chip("Set dimension");
  await setValue(15);
  await page.locator(".segmented.small button", { hasText: "Smart" }).click();
  await tapEnt(circle.id);
  await chip("Set dimension");
  await setValue(12);
  assert.equal(await state(), "Fully defined");
  s = await sketch();
  const centre = s.entities.find((e) => e.id === circle.c);
  near(centre.x, 40);
  near(centre.y, 15);
  near(s.entities.find((e) => e.id === circle.id).r, 6);
  await tool("Fit");
  await shot("03-sketch-defined");

  // Editing a dimension re-solves; a contradictory relation is refused.
  await page.locator(".dim", { hasText: /^60$/ }).click();
  await setValue(64);
  s = await sketch();
  const xs2 = s.entities.filter((e) => e.type === "point" && e.id !== circle.c).map((e) => e.x);
  near(Math.max(...xs2) - Math.min(...xs2), 64);
  await tool("Select");
  await tapEnt(lines[0]);
  await chip("Vertical");
  await sleep(300);
  assert.match(await page.locator(".toast").textContent(), /cannot all be satisfied|over-define/i);
  assert.equal((await sketch()).constraints.filter((c) => c.type === "vertical").length, 2);
  await page.mouse.click(30, 170);

  // --- Extrude ----------------------------------------------------------------------------
  await chip("Done");
  await sleep(500);
  await chip("Extrude");
  await settle();
  await page.locator(".card input").fill("12");
  await settle();
  await page.locator(".card button[type=submit]").click();
  await settle();
  let d = await doc();
  assert.equal(d.features[1].type, "extrude");
  assert.equal(await page.locator(".badge.err").count(), 0, "extrude failed");
  await tool("Fit");
  await shot("04-solid");

  // --- Reference plane: pick the top face, offset by a typed distance ----------------------
  const top = await world([18, 15, 12]);
  await page.mouse.click(top.x, top.y);
  await chip("Offset plane");
  await settle();
  await page.locator(".card input").fill("18");
  await settle();
  await shot("05-plane-sheet");
  await page.locator(".card button[type=submit]").click();
  await settle();
  d = await doc();
  assert.equal(d.features[2].type, "plane");
  assert.equal(d.features[2].def.distance, 18);

  // Sketch on that plane, and snap a line to a model edge and a point to a model corner.
  await page.locator(".tree .pill").click();
  // The new plane is already highlighted in the tree; select it if it is not.
  if (!(await page.locator(".row.selected", { hasText: "Plane1" }).count())) await page.locator(".row-main", { hasText: "Plane1" }).click();
  await page.locator(".row-actions button", { hasText: "Sketch" }).click();
  await sleep(700);
  await tool("Rect");
  const r0 = await onScreen([-20, -8]);
  const r1 = await onScreen([-4, 6]);
  await drag([[r0.x, r0.y], [r1.x, r1.y]]);
  s = await sketch();
  assert.equal(s.plane.feature, d.features[2].id);
  const rl = s.entities.filter((e) => e.type === "line");
  await tool("Select");
  // The block's right face (x = 64 in the first sketch) is square to this plane: reference it.
  const side = await world([64, 20, 6]);
  const before = (await sketch()).entities.length;
  await page.mouse.click(side.x, side.y);
  await sleep(300);
  s = await sketch();
  assert.ok(s.entities.length > before, "tapping the model did not create a reference");
  const ref = s.entities.find((e) => e.type === "line" && e.ref);
  assert.ok(ref, "no reference line");
  await tapEnt(rl[1].id); // the rectangle's right-hand side
  await chip("Coincident");
  await sleep(300);
  s = await sketch();
  const by = Object.fromEntries(s.entities.map((e) => [e.id, e]));
  const refPt = by[ref.p1];
  // Collinear with the reference: both ends of the side share its sketch-x.
  const sideLine = by[rl[1].id];
  const dxRef = by[ref.p2].x - refPt.x;
  const dyRef = by[ref.p2].y - refPt.y;
  for (const pid of [sideLine.p1, sideLine.p2]) near((dxRef * (by[pid].y - refPt.y) - dyRef * (by[pid].x - refPt.x)) / Math.hypot(dxRef, dyRef), 0, 1e-3);
  await shot("06-plane-sketch-reference");
  await chip("Done");
  await sleep(500);
  await chip("Cut");
  await settle();
  await page.locator(".segmented button", { hasText: "To depth" }).click();
  await settle();
  await page.locator(".card input").fill("30");
  await settle();
  await page.locator(".card button[type=submit]").click();
  await settle();
  assert.equal(await page.locator(".badge.err").count(), 0, "cut from the plane sketch failed");
  await tool("Iso");

  // --- Pick an edge, fillet it ------------------------------------------------------------
  const edge = await world([0, 15, 12]);
  await page.mouse.click(edge.x, edge.y);
  assert.equal(await page.locator(".chip-label", { hasText: "1 edge" }).count(), 1, "edge not picked");
  await chip("Fillet");
  await settle();
  await page.locator(".card button[type=submit]").click();
  await settle();
  assert.equal(await page.locator(".badge.err").count(), 0, "fillet failed to build");
  await shot("07-part");

  // --- Feature tree -----------------------------------------------------------------------
  await page.locator(".tree .pill").click();
  await page.locator(".row-main", { hasText: "Boss-Extrude1" }).click();
  await shot("08-tree");
  await page.locator(".tree .pill").click();

  // --- Scripted Claude turn: resize through a dimension, add a hole to the sketch -----------
  const requests = [];
  await page.route("**/api/chat", async (route) => {
    const body = JSON.parse(route.request().postData());
    requests.push(body);
    const sse = (events) => route.fulfill({ status: 200, contentType: "text/event-stream", body: events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") });
    const message = (content, stop_reason) => ({ type: "message", message: { id: "msg_test", type: "message", role: "assistant", model: "test", content, stop_reason, usage: {} } });
    if (requests.length === 1) {
      const text = body.messages[0].content.find((b) => b.type === "text" && b.text.includes("<state>")).text;
      const features = JSON.parse(/features: (\[.*\])\n/.exec(text)[1]);
      const sk1 = features[0];
      const width = sk1.constraints.find((c) => c.type === "distance" && c.value === 64).id;
      return sse([
        { type: "tool", name: "set_dimensions" },
        message(
          [
            { type: "tool_use", id: "tu_1", name: "set_dimensions", input: { sketch: sk1.id, values: [{ id: width, value: 80 }] } },
            { type: "tool_use", id: "tu_2", name: "add_sketch_shapes", input: { sketch: sk1.id, profiles: [{ type: "circle", cx: 70, cy: 15, d: 8 }] } },
            { type: "tool_use", id: "tu_3", name: "set_dimensions", input: { sketch: sk1.id, values: [{ id: "nope", value: 1 }] } },
          ],
          "tool_use",
        ),
      ]);
    }
    return sse([{ type: "text", text: "Widened the plate to 80 mm and added an 8 mm hole." }, message([{ type: "text", text: "Widened the plate to 80 mm and added an 8 mm hole." }], "end_turn")]);
  });
  await page.locator(".composer textarea").click();
  await page.keyboard.type("make it 80 wide with another hole");
  await page.locator(".composer button[aria-label=Send]").click();
  await page.waitForSelector(".reply:not(.live)");
  await settle();
  assert.equal(requests.length, 2);
  assert.ok(requests[0].messages[0].content.some((b) => b.type === "image"), "no screenshot sent");
  const results = requests[1].messages[2].content;
  assert.equal(JSON.parse(results[0].content).built, true);
  near(JSON.parse(results[0].content).body.bbox_max[0], 80);
  assert.equal(JSON.parse(results[1].content).built, true);
  assert.equal(results[2].is_error, true, "bad dimension id was not rejected");
  d = await doc();
  assert.equal(d.features[0].entities.filter((e) => e.type === "circle").length, 2);
  assert.equal(await page.locator(".composer.open").count(), 0, "composer should fold after sending");
  await shot("09-claude-edit");
  await page.unroute("**/api/chat");

  // --- Undo / redo ------------------------------------------------------------------------
  await page.locator(".tools .pill").click();
  await page.locator(".tools .tool", { hasText: /^Undo$/ }).click();
  await settle();
  assert.equal((await doc()).features[0].entities.filter((e) => e.type === "circle").length, 1);
  await page.locator(".tools .tool", { hasText: /^Redo$/ }).click();
  await settle();
  assert.equal((await doc()).features[0].entities.filter((e) => e.type === "circle").length, 2);
  await page.mouse.click(20, 600);

  // --- Files: a folder, a second part, an assembly ----------------------------------------
  await page.locator(".tree .pill").click();
  await page.locator(".panel-head .link", { hasText: "Files" }).click();
  await page.locator(".file-new button", { hasText: "New folder" }).click();
  await shot("10-files");
  await page.locator(".file-new button", { hasText: "New part" }).click();
  await settle();
  assert.equal(await page.locator(".tree .pill-title").textContent(), "Part2");
  // A simple pin: circle on the top plane, extruded.
  await tool("Top");
  await tool("Circle");
  const p0 = await onScreen([0, 0]);
  const p1 = await onScreen([6, 0]);
  await drag([[p0.x, p0.y], [p1.x, p1.y]]);
  s = await sketch();
  assert.equal(s.entities.find((e) => e.type === "circle").c, "origin", "circle should reuse the origin point as its centre");
  await chip("Done");
  await sleep(400);
  await chip("Extrude");
  await settle();
  await page.locator(".card input").fill("25");
  await page.locator(".card button[type=submit]").click();
  await settle();

  await page.locator(".tree .pill").click();
  await page.locator(".panel-head .link", { hasText: "Files" }).click();
  await page.locator(".file-new button", { hasText: "New assembly" }).click();
  await sleep(400);
  assert.equal(await page.locator(".tree .pill-title").textContent(), "Assembly1");
  for (const name of ["Part1", "Part2"]) {
    await page.locator(".tools .pill").click();
    await page.locator(".tools .tool", { hasText: "Insert part" }).click();
    await page.locator(".files .row-main", { hasText: name }).click();
    await settle();
  }
  let a = await doc();
  assert.deepEqual(a.components.map((c) => [c.name, !!c.fixed]), [["Part1<1>", true], ["Part2<1>", false]]);
  await tool("Fit");
  await shot("11-assembly-inserted");

  // Mate the pin into the 8 mm hole Claude added at (70, 15): concentric on the two round faces.
  const pinPose = a.components[1].pose.p;
  assert.ok(pinPose[0] >= 100, "the second part should be placed clear of the first");
  // The part of the hole wall the camera can see is the far side, a little below the rim.
  const holeWall = await world([70 - 4 * Math.SQRT1_2, 15 + 4 * Math.SQRT1_2, 9]);
  await page.mouse.click(holeWall.x, holeWall.y);
  const pinSide = await world([pinPose[0] + 6 * Math.SQRT1_2, pinPose[1] - 6 * Math.SQRT1_2, 12]);
  await page.mouse.click(pinSide.x, pinSide.y);
  await shot("12-mate-picks");
  await chip("Concentric");
  await sleep(400);
  a = await doc();
  assert.equal(a.mates.length, 1, "concentric mate was not added");
  assert.deepEqual([a.mates[0].a.ref.type, a.mates[0].b.ref.type], ["axis", "axis"]);
  near(a.components[1].pose.p[0], 70, 1e-3);
  near(a.components[1].pose.p[1], 15, 1e-3);
  await tool("Fit");
  // Then set the pin's top face 5 mm from the plate's top face with a distance mate. A tap near an
  // edge picks the edge first; tapping the same spot again moves on to the face under the finger.
  const pickFace = async (p, count) => {
    for (let i = 0; i < 3; i++) {
      await page.mouse.click(p.x, p.y);
      await sleep(120);
      const said = await page.locator(".context-hint .state").textContent();
      if ((said.match(/flat face/g) ?? []).length === count) return;
    }
    assert.fail(`could not pick flat face #${count}`);
  };
  await pickFace(await world([74, 26, 12]), 1);
  a = await doc();
  await pickFace(await world([70, 15, a.components[1].pose.p[2] + 25]), 2);
  await chip("Distance");
  await sleep(300);
  await setValue(5);
  a = await doc();
  assert.equal(a.mates.length, 2, "distance mate was not added");
  assert.equal(a.mates[1].value, 5);
  await page.locator(".tree .pill").click();
  await shot("13-assembly-tree");
  assert.equal(await page.locator(".badge.err").count(), 0, "a mate is unsatisfied");
  assert.match(await page.locator(".panel-foot").textContent(), /1 degree of freedom left/);

  // Open the pin from the assembly, change it, come back: the assembly shows the new part.
  await page.locator(".row-main", { hasText: "Part2<1>" }).click();
  await page.locator(".row-actions button", { hasText: "Edit part" }).click();
  await settle();
  assert.equal(await page.locator(".tree .pill-title").textContent(), "Part2");
  await page.locator(".tree .pill").nth(1).click();
  await page.locator(".row-main", { hasText: "Boss-Extrude1" }).click();
  await page.locator(".row-actions button", { hasText: "Edit" }).click();
  await page.locator(".card input").fill("40");
  await settle();
  await page.locator(".card button[type=submit]").click();
  await settle();
  await page.locator(".pill.icon-only").click();
  await settle();
  assert.equal(await page.locator(".tree .pill-title").textContent(), "Assembly1");
  await tool("Fit");
  await shot("14-assembly-after-edit");

  // --- State survives a reload ------------------------------------------------------------
  await page.reload();
  await page.waitForSelector(".tree .pill");
  await settle();
  assert.equal(await page.locator(".tree .pill-title").textContent(), "Assembly1");
  assert.equal((await doc()).mates.length, 2);

  assert.deepEqual(problems, [], "page reported errors");
  console.log("walkthrough passed");
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

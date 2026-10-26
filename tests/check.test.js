// Runs check.js against fake Apple, GitHub and ntfy in a temp folder: no
// network, no real pushes. Stock scenarios; failures are in check-failures.test.js.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const { PICKUP_URL } = require("../duo");
const { APPLE_STORES } = require("./fakes");
const { setup, cell, openKeys, TOPIC, BUY, W256, N256, W512, N512, appleSays } = require("./check-harness");

const VERIFIED_URL =
  "https://www.apple.com/shop/retail/pickup-message?pl=true&parts.0=MK1E4LL%2FA&parts.1=MK1F4LL%2FA&parts.2=MK1G4LL%2FA&parts.3=MK1H4LL%2FA&location=92618";
const ctx = setup();

test("asks Apple the verified URL", () => {
  assert.equal(PICKUP_URL, VERIFIED_URL);
});

test("first run, no state.json, one model in stock: one push naming model and store", async () => {
  assert.equal(ctx.gh.file(), null);
  ctx.apple = appleSays({ "Irvine Spectrum Center": [N512] });
  const { record, status } = await ctx.run();

  assert.equal(ctx.pushes.length, 1);
  assert.deepEqual(ctx.pushes[0], {
    url: `https://ntfy.sh/${TOPIC}`,
    title: "512GB Night Sky at Irvine Spectrum",
    body: "Irvine Spectrum (Irvine): Available Today",
    click: `${BUY}512gb-night-sky-unlocked`,
    priority: "urgent",
  });
  assert.deepEqual(openKeys(record), ["Irvine Spectrum|MK1H4LL/A"]);
  assert.equal(record.failStreak, 0);
  assert.equal(status.ok, true);
  assert.equal(status.models.length, 4);
  assert.deepEqual(status.stores.map((s) => s.name), [
    "Irvine Spectrum", "South Coast Plaza", "Mission Viejo", "Fashion Island",
    "Brea Mall", "Los Cerritos", "Victoria Gardens",
  ]);
  assert.deepEqual(cell(status, "Irvine Spectrum", N512), { available: true, quote: "Available Today" });
  assert.equal(cell(status, "Irvine Spectrum", W256).available, false);
  assert.equal(status.stores.find((s) => s.name === "Victoria Gardens").miles, 31.01);
});

test("first run creates state.json with no sha", async () => {
  ctx.apple = appleSays({ "Irvine Spectrum Center": [N512] });
  await ctx.run();
  assert.equal(ctx.gh.puts.length, 1);
  assert.equal("sha" in ctx.gh.puts[0], false);
});

test("first run with nothing in stock: no push, nothing open", async () => {
  const { record, status } = await ctx.run();
  assert.equal(ctx.pushes.length, 0);
  assert.deepEqual(openKeys(record), []);
  assert.equal(record.failStreak, 0);
  assert.equal(status.ok, true);
});

test("same stock again: no repeat push, state.json byte-for-byte unchanged", async () => {
  ctx.apple = appleSays({ "Irvine Spectrum Center": [N512], "Brea Mall": [W256] });
  const first = await ctx.run();
  assert.equal(ctx.pushes.length, 2);
  const second = await ctx.run();
  assert.equal(ctx.pushes.length, 0);
  assert.equal(JSON.stringify(second.record), JSON.stringify(first.record));
});

test("no change means no write", async () => {
  ctx.apple = appleSays({ "Irvine Spectrum Center": [N512] });
  await ctx.run();
  const writes = ctx.gh.puts.length;
  await ctx.run();
  assert.equal(ctx.gh.puts.length, writes);
});

test("two models at once: one push per model, each with its own buy link", async () => {
  ctx.apple = appleSays({ "Irvine Spectrum Center": [W256, N512], "Brea Mall": [N512] });
  const { record } = await ctx.run();
  assert.deepEqual(
    ctx.pushes.map((p) => [p.title, p.click]),
    [
      ["256GB Star White at Irvine Spectrum", `${BUY}256gb-star-white-unlocked`],
      ["512GB Night Sky at Irvine Spectrum, Brea Mall", `${BUY}512gb-night-sky-unlocked`],
    ]
  );
  assert.equal(ctx.pushes[1].body, "Irvine Spectrum (Irvine): Available Today\nBrea Mall (Brea): Available Today");
  assert.deepEqual(openKeys(record), [
    "Brea Mall|MK1H4LL/A", "Irvine Spectrum|MK1E4LL/A", "Irvine Spectrum|MK1H4LL/A",
  ]);
});

test("a second model at the same store is its own alert", async () => {
  ctx.apple = appleSays({ "Irvine Spectrum Center": [W256] });
  await ctx.run();
  ctx.apple = appleSays({ "Irvine Spectrum Center": [W256, N512] });
  await ctx.run();
  assert.deepEqual(ctx.pushes.map((p) => p.title), ["512GB Night Sky at Irvine Spectrum"]);
});

test("sells out then comes back: alerts again", async () => {
  ctx.apple = appleSays({ "Fashion Island": [W512] });
  await ctx.run();
  ctx.apple = appleSays();
  const gone = await ctx.run();
  assert.equal(ctx.pushes.length, 0);
  assert.deepEqual(openKeys(gone.record), []);
  ctx.advance(11); // an instant return would be a flap, which does not ping
  ctx.apple = appleSays({ "Fashion Island": [W512] });
  await ctx.run();
  assert.deepEqual(ctx.pushes.map((p) => p.title), ["512GB Star White at Fashion Island"]);
});

test("back within 10 minutes is not a new ping", async () => {
  ctx.apple = appleSays({ "Fashion Island": [W512] });
  await ctx.run();
  ctx.apple = appleSays();
  await ctx.run();
  ctx.advance(9);
  ctx.apple = appleSays({ "Fashion Island": [W512] });
  const { record } = await ctx.run();
  assert.equal(ctx.pushes.length, 0);
  assert.deepEqual(openKeys(record), ["Fashion Island|MK1G4LL/A"]);
});

test("back after 11 minutes pings again", async () => {
  ctx.apple = appleSays({ "Fashion Island": [W512] });
  await ctx.run();
  ctx.apple = appleSays();
  await ctx.run();
  ctx.advance(11);
  ctx.apple = appleSays({ "Fashion Island": [W512] });
  await ctx.run();
  assert.equal(ctx.pushes.length, 1);
});

test("a store outside the 7 is ignored", async () => {
  ctx.apple = appleSays({ "Del Amo": [W256, N256, W512, N512], "Pasadena": [N512] });
  const { record, status } = await ctx.run();
  assert.equal(ctx.pushes.length, 0);
  assert.deepEqual(openKeys(record), []);
  assert.ok(!status.stores.some((s) => s.name === "Del Amo" || s.name === "Pasadena"));
});

test("a watched store missing from Apple's answer is unknown, and its stock memory is kept", async () => {
  ctx.apple = appleSays({ "Victoria Gardens": [W512] });
  await ctx.run();
  assert.equal(ctx.pushes.length, 1);

  ctx.apple = appleSays({}, APPLE_STORES.filter(([n]) => n !== "Victoria Gardens"));
  const { record, status } = await ctx.run();
  const vg = status.stores.find((s) => s.name === "Victoria Gardens");
  assert.equal(status.ok, true);
  assert.equal(vg.found, false);
  assert.equal(vg.parts[W512], null);
  assert.deepEqual(openKeys(record), ["Victoria Gardens|MK1G4LL/A"]);

  ctx.apple = appleSays({ "Victoria Gardens": [W512] });
  await ctx.run();
  assert.equal(ctx.pushes.length, 0, "no repeat push when it reappears still in stock");
});

test("the other checker claimed it first", async () => {
  ctx.apple = appleSays({ "Irvine Spectrum Center": [N512] });
  ctx.gh.setFile({ version: 2, failStreak: 0, hours: {}, restocks: [] });
  ctx.gh.beforeNextPut(() => {
    const claimed = { version: 2, failStreak: 0, hours: {}, restocks: [
      { store: "Irvine Spectrum", parts: { [N512]: { in: "2026-10-26T17:59:00.000Z", out: null } } },
    ] };
    ctx.gh.setFile(claimed);
  });
  const { record } = await ctx.run();
  assert.equal(ctx.pushes.length, 0);
  assert.deepEqual(openKeys(record), ["Irvine Spectrum|MK1H4LL/A"]);
});

test("v1 state.json is migrated without re-pinging", async () => {
  ctx.gh.setFile({ inStock: ["Irvine Spectrum|MK1H4LL/A"], failStreak: 0 });
  ctx.apple = appleSays({ "Irvine Spectrum Center": [N512] });
  const { record } = await ctx.run();
  assert.equal(ctx.pushes.length, 0);
  assert.equal(record.version, 2);
  assert.deepEqual(openKeys(record), ["Irvine Spectrum|MK1H4LL/A"]);
});

test("status.json carries the history summary", async () => {
  const { status } = await ctx.run();
  assert.equal(status.history.grid.length, 7);
  assert.ok(fs.existsSync("status.json"));
});

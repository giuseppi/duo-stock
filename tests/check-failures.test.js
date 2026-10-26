// check.js when things go wrong: Apple failing, ntfy down, GitHub unreachable.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const { main } = require("../check");
const { APPLE_STORES, captureConsole } = require("./fakes");
const { setup, cell, openKeys, N256, N512, W256, appleSays } = require("./check-harness");

const ctx = setup();

// The harness already checks status.json for leaked secrets on every run.
function assertStatusError(pattern) {
  const status = JSON.parse(fs.readFileSync("status.json", "utf8"));
  assert.equal(status.ok, false);
  assert.match(status.error, pattern);
}
const VERIFIED_KEY = "Irvine Spectrum|MK1H4LL/A";

test("failure streak: one 'failing' push at 6, quiet after, then one 'back' push and no repeat stock push", async () => {
  ctx.apple = appleSays({ "Irvine Spectrum Center": [N512] });
  await ctx.run();
  assert.equal(ctx.pushes.length, 1);

  ctx.apple = 541;
  for (let i = 1; i <= 5; i++) {
    const { record, status } = await ctx.run();
    assert.equal(ctx.pushes.length, 0, `no push on failure ${i}`);
    assert.equal(record.failStreak, i);
    assert.deepEqual(openKeys(record), [VERIFIED_KEY], "stock memory kept through failures");
    assert.equal(status.ok, false);
    assert.equal(status.error, "Apple blocked the request (HTTP 541)");
    assert.equal(cell(status, "Irvine Spectrum", N512), null, "stock is unknown while failing");
  }
  const sixth = await ctx.run();
  assert.deepEqual(ctx.pushes.map((p) => [p.title, p.priority]), [["Duo checker is failing", "default"]]);
  assert.match(ctx.pushes[0].body, /HTTP 541/);
  assert.match(sixth.logs, /::error title=Apple check failed::Apple blocked the request \(HTTP 541\)/);

  const writes = ctx.gh.puts.length;
  for (let i = 7; i <= 9; i++) {
    const later = await ctx.run();
    assert.equal(ctx.pushes.length, 0, `no push on failure ${i}`);
    assert.equal(JSON.stringify(later.record), JSON.stringify(sixth.record));
  }
  assert.equal(ctx.gh.puts.length, writes, "a long outage makes no writes");

  ctx.apple = appleSays({ "Irvine Spectrum Center": [N512] });
  const back = await ctx.run();
  assert.deepEqual(ctx.pushes.map((p) => [p.title, p.priority]), [["Duo checker is back", "default"]]);
  assert.equal(back.record.failStreak, 0);
  assert.deepEqual(openKeys(back.record), [VERIFIED_KEY]);
  assert.equal(back.status.ok, true);
});

test("if the 'failing' push doesn't go out, the next failed run tries again", async () => {
  ctx.apple = 541;
  for (let i = 1; i <= 5; i++) await ctx.run();
  ctx.ntfyUp = false;
  const missed = await ctx.run();
  assert.deepEqual(ctx.pushes.map((p) => p.title), ["Duo checker is failing"]);
  assert.equal(missed.record.failStreak, 5, "not counted as told");

  ctx.ntfyUp = true;
  const told = await ctx.run();
  assert.deepEqual(ctx.pushes.map((p) => p.title), ["Duo checker is failing"]);
  assert.equal(told.record.failStreak, 6);

  ctx.apple = appleSays();
  await ctx.run();
  assert.deepEqual(ctx.pushes.map((p) => p.title), ["Duo checker is back"]);
});

test("a short failure streak recovers quietly", async () => {
  ctx.apple = 503;
  const { status } = await ctx.run();
  assert.equal(status.error, "Apple answered HTTP 503");
  await ctx.run();
  ctx.apple = appleSays();
  const { record } = await ctx.run();
  assert.equal(ctx.pushes.length, 0);
  assert.equal(record.failStreak, 0);
});

test("HTTP 403 is reported as blocked too", async () => {
  ctx.apple = 403;
  const { status } = await ctx.run();
  assert.equal(status.error, "Apple blocked the request (HTTP 403)");
});

test("a response with no stores, or none of ours, counts as a failure", async () => {
  ctx.apple = { body: {} };
  assert.equal((await ctx.run()).status.error, "no stores in Apple's response (Apple may have changed the format)");
  ctx.apple = appleSays({}, APPLE_STORES.slice(7));
  const { record, status } = await ctx.run();
  assert.equal(status.error, "none of the watched stores are in Apple's response");
  assert.equal(record.failStreak, 2);
});

test("if the ntfy push fails, the hit isn't remembered, so the next run retries it", async () => {
  ctx.apple = appleSays({ "South Coast Plaza": [N256] });
  ctx.ntfyUp = false;
  const failed = await ctx.run();
  assert.equal(ctx.pushes.length, 1);
  assert.deepEqual(openKeys(failed.record), []);
  assert.match(failed.logs, /ntfy push failed: HTTP 500/);

  ctx.ntfyUp = true;
  const retried = await ctx.run();
  assert.deepEqual(ctx.pushes.map((p) => p.title), ["256GB Night Sky at South Coast Plaza"]);
  assert.deepEqual(openKeys(retried.record), ["South Coast Plaza|MK1F4LL/A"]);
});

test("a failed push undoes its claim", async () => {
  ctx.apple = appleSays({ "Mission Viejo": [W256] });
  ctx.ntfyUp = false;
  await ctx.run();
  assert.deepEqual(openKeys(ctx.gh.file()), []);
  ctx.ntfyUp = true;
  await ctx.run();
  assert.deepEqual(ctx.pushes.map((p) => p.title), ["256GB Star White at Mission Viejo"]);
});

test("invalid JSON on GitHub: no pushes, run fails, file untouched", async () => {
  ctx.gh.setRaw("{oops");
  ctx.apple = appleSays({ "Mission Viejo": [W256] });
  await assert.rejects(ctx.run(), /not valid JSON/);
  assert.equal(ctx.pushes.length, 0);
  assert.equal(ctx.gh.puts.length, 0);
});

test("unknown state.json version on GitHub: no pushes, run fails, file untouched", async () => {
  ctx.gh.setFile({ version: 3, restocks: [] });
  ctx.apple = appleSays({ "Mission Viejo": [W256] });
  await assert.rejects(ctx.run(), /left alone/);
  assert.equal(ctx.pushes.length, 0);
  assert.equal(ctx.gh.puts.length, 0);
});

test("without NTFY_TOPIC nothing is sent and nothing crashes", async () => {
  const topic = process.env.NTFY_TOPIC;
  delete process.env.NTFY_TOPIC;
  try {
    ctx.apple = appleSays({ "Los Cerritos": [N512] });
    const { record, logs } = await ctx.run();
    assert.equal(ctx.pushes.length, 0);
    assert.match(logs, /NTFY_TOPIC not set, push skipped/);
    assert.deepEqual(openKeys(record), [], "kept unclaimed so it pushes once the secret is set");
  } finally {
    process.env.NTFY_TOPIC = topic;
  }
});

test("GitHub unreadable: no pushes and the run fails", async () => {
  ctx.apple = appleSays({ "Irvine Spectrum Center": [N512] });
  ctx.gh.failNext("GET", 500);
  await assert.rejects(ctx.run());
  assert.equal(ctx.pushes.length, 0);
  assert.match(ctx.logs, /check failed: /);
  assertStatusError(/GitHub API GET .* answered HTTP 500/);
});

test("GitHub unwritable: pushes go out and the run fails", async () => {
  ctx.apple = appleSays({ "Irvine Spectrum Center": [N512] });
  ctx.gh.failNext("PUT", 500, 5);
  await assert.rejects(ctx.run());
  assert.equal(ctx.pushes.length, 1);
  assert.equal(ctx.pushes[0].title, "512GB Night Sky at Irvine Spectrum");
  assertStatusError(/GitHub API PUT .* answered HTTP 500/);
});

test("missing GitHub settings: the run fails and says why", async () => {
  const con = captureConsole();
  try {
    await assert.rejects(main({ env: {} }), /GITHUB_TOKEN and GITHUB_REPOSITORY must be set/);
  } finally {
    con.restore();
  }
  assert.match(con.text(), /check failed: GITHUB_TOKEN and GITHUB_REPOSITORY must be set/);
});

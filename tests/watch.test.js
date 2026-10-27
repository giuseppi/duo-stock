// Runs the laptop watcher's checkOnce against fake Apple, GitHub and ntfy.
// No network, no real pushes.

const test = require("node:test");
const assert = require("node:assert/strict");
const { createWatcher } = require("../duo-watch");
const { claimedKeys } = require("../record");
const { appleSays, fakeGitHub, installFetch, captureConsole } = require("./fakes");

const TOPIC = "fake-topic-for-tests-7q2x";
const TOKEN = "gho_fake_laptop_token";
const API = { repo: "giuseppi/duo-stock", token: TOKEN, branch: "main" };
const IRVINE = "Irvine Spectrum";
const W256 = "MK1E4LL/A";
const KEY = `${IRVINE}|${W256}`;
const T0 = Date.parse("2026-10-26T18:00:00.000Z");

process.env.NTFY_TOPIC = TOPIC;

const ctx = {};

test.beforeEach(() => {
  ctx.apple = appleSays();
  ctx.clock = T0;
  ctx.gh = fakeGitHub({});
  ctx.con = null;
});

test.afterEach(() => ctx.con?.restore());

// A watcher over fresh fakes; fakes are re-routed each call so tests can swap GitHub.
function start(api = API) {
  const net = installFetch({ apple: () => ctx.apple, github: ctx.gh });
  ctx.pushes = net.pushes;
  ctx.con = captureConsole();
  return createWatcher({ api, now: () => new Date(ctx.clock) });
}

const stock = (...parts) => (ctx.apple = appleSays({ "Irvine Spectrum Center": parts }));

async function check(watcher) {
  await watcher.checkOnce();
  const text = ctx.con.text();
  assert.ok(!text.includes(TOPIC) && !text.includes(TOKEN), "secret leaked");
  return text;
}

test("new stock: claim, one push, one dispatch", async () => {
  const w = start();
  stock(W256);
  await check(w);
  assert.equal(ctx.pushes.length, 1);
  assert.equal(ctx.pushes[0].title, "256GB Star White at Irvine Spectrum");
  assert.deepEqual([...claimedKeys(ctx.gh.file())], [KEY]);
  assert.equal(ctx.gh.puts.length, 1);
  assert.equal(ctx.gh.dispatches, 1);
});

test("already claimed by GitHub: no push, no write, no dispatch", async () => {
  const w = start();
  stock(W256);
  await check(w);
  const [puts, dispatches] = [ctx.gh.puts.length, ctx.gh.dispatches];
  await check(start()); // a fresh laptop session reads the same record
  assert.equal(ctx.pushes.length, 0);
  assert.equal(ctx.gh.puts.length, puts);
  assert.equal(ctx.gh.dispatches, dispatches);
});

test("nothing changed: no write, no dispatch", async () => {
  const w = start();
  stock(W256);
  await check(w);
  ctx.pushes.length = 0;
  const puts = ctx.gh.puts.length;
  await check(w);
  assert.equal(ctx.pushes.length, 0);
  assert.equal(ctx.gh.puts.length, puts);
  assert.equal(ctx.gh.dispatches, 1);
});

test("GitHub down: pings from memory once", async () => {
  const w = start();
  stock(W256);
  ctx.gh.failNext("GET", 500, 2);
  const text = await check(w);
  assert.equal(ctx.pushes.length, 1);
  assert.match(text, /GitHub unreachable \(.*HTTP 500.*\), pinging from this laptop's memory until it's back/);
  await check(w);
  assert.equal(ctx.pushes.length, 1);
  assert.equal(ctx.gh.puts.length, 0);
});

test("the unreachable warning prints once per outage, again for a later one", async () => {
  const w = start();
  stock(W256);
  ctx.gh.failNext("GET", 500, 2);
  await check(w);
  await check(w);
  assert.equal(ctx.con.text().match(/GitHub unreachable/g).length, 1);
  await check(w); // back
  ctx.gh.failNext("GET", 500, 1);
  await check(w);
  assert.equal(ctx.con.text().match(/GitHub unreachable/g).length, 2);
});

test("expired login (401) falls back and names the status", async () => {
  const w = start();
  stock(W256);
  ctx.gh.failNext("GET", 401, 1);
  const text = await check(w);
  assert.match(text, /HTTP 401/);
  assert.equal(ctx.pushes.length, 1);
});

test("invalid JSON on GitHub: falls back, never writes", async () => {
  const w = start();
  stock(W256);
  ctx.gh.setRaw("{ nope");
  const text = await check(w);
  assert.match(text, /not valid JSON/);
  assert.equal(ctx.pushes.length, 1);
  assert.equal(ctx.gh.puts.length, 0);
});

test("a write that fails after deciding still pings once", async () => {
  const w = start();
  stock(W256);
  ctx.gh.failNext("PUT", 500, 2);
  await check(w);
  assert.equal(ctx.pushes.length, 1);
  assert.deepEqual([...w.offline.keys()], [KEY]);
  await check(w);
  assert.equal(ctx.pushes.length, 1);
});

test("a failed push is not remembered, so the next check retries it", async () => {
  const w = start();
  stock(W256);
  ctx.gh.failNext("GET", 500, 2);
  installFetch({ apple: () => ctx.apple, github: ctx.gh, ntfyUp: false });
  await check(w);
  assert.equal(w.offline.size, 0);
  const net = installFetch({ apple: () => ctx.apple, github: ctx.gh });
  await check(w);
  assert.equal(net.pushes.length, 1);
  assert.equal(w.offline.size, 1);
});

test("a failed dispatch is a warning only", async () => {
  const w = start();
  stock(W256);
  ctx.gh.failNext("POST", 500, 1);
  const text = await check(w);
  assert.equal(ctx.pushes.length, 1);
  assert.match(text, /could not start a GitHub check.*HTTP 500/);
});

test("a failed push is unclaimed so the next check tries again", async () => {
  const w = start();
  stock(W256);
  installFetch({ apple: () => ctx.apple, github: ctx.gh, ntfyUp: false });
  await check(w);
  assert.deepEqual([...claimedKeys(ctx.gh.file())], []);
  const net = installFetch({ apple: () => ctx.apple, github: ctx.gh });
  await check(w);
  assert.equal(net.pushes.length, 1);
});

test("reconnect hands over still-in-stock pings", async () => {
  const w = start();
  stock(W256);
  ctx.gh.failNext("GET", 500, 1);
  await check(w);
  assert.equal(ctx.pushes.length, 1);
  ctx.clock = T0 + 3 * 60 * 1000;
  await check(w);
  assert.equal(ctx.pushes.length, 1);
  const rec = ctx.gh.file();
  assert.equal(rec.restocks[0].parts[W256].in, new Date(T0).toISOString());
  assert.equal(w.offline.size, 0);
  assert.equal(ctx.gh.dispatches, 1);
});

test("offline restock that sold out is not backfilled", async () => {
  const w = start();
  stock(W256);
  ctx.gh.failNext("GET", 500, 1);
  await check(w);
  stock();
  ctx.clock = T0 + 3 * 60 * 1000;
  await check(w);
  assert.equal(ctx.pushes.length, 1);
  assert.equal(w.offline.size, 0);
  assert.deepEqual((ctx.gh.file()?.restocks) ?? [], []);
});

test("no api at all behaves like GitHub down", async () => {
  const w = start(null);
  stock(W256);
  const text = await check(w);
  assert.equal(ctx.pushes.length, 1);
  assert.match(text, /GitHub unreachable/);
  await check(w);
  assert.equal(ctx.pushes.length, 1);
  assert.equal(ctx.gh.puts.length, 0);
});

test("sold out and back during an outage pings again", async () => {
  const w = start();
  stock(W256);
  await check(w); // GitHub claims it and the laptop pings
  ctx.gh.failNext("GET", 500, 2);
  stock();
  await check(w);
  stock(W256);
  const net = installFetch({ apple: () => ctx.apple, github: ctx.gh });
  await check(w);
  assert.equal(net.pushes.length, 1);
});

test("failed offline push is retried after a read failure", async () => {
  const w = start();
  stock(W256);
  await check(w);
  // Meanwhile GitHub's own check recorded the sell-out.
  const rec = ctx.gh.file();
  rec.restocks[0].parts[W256].out = new Date(T0 + 1000).toISOString();
  ctx.gh.setFile(rec);
  ctx.clock = T0 + 30 * 60 * 1000;
  ctx.gh.failNext("PUT", 500, 1);
  const down = installFetch({ apple: () => ctx.apple, github: ctx.gh, ntfyUp: false });
  await check(w);
  assert.equal(down.pushes.length, 1); // tried, and failed
  assert.equal(w.offline.size, 0);
  ctx.gh.failNext("GET", 500, 1);
  const up = installFetch({ apple: () => ctx.apple, github: ctx.gh });
  await check(w);
  assert.equal(up.pushes.length, 1);
});

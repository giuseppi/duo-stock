// Runs check.js against a mocked fetch in a temp folder: no network, no real
// pushes. Run with: node --test

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { PICKUP_URL } = require("./duo");
const { main } = require("./check");

const TOPIC = "fake-topic-for-tests-7q2x"; // the real one only lives in the repo secret
process.env.NTFY_TOPIC = TOPIC;

const VERIFIED_URL =
  "https://www.apple.com/shop/retail/pickup-message?pl=true&parts.0=MK1E4LL%2FA&parts.1=MK1F4LL%2FA&parts.2=MK1G4LL%2FA&parts.3=MK1H4LL%2FA&location=92618";
const BUY = "https://www.apple.com/shop/buy-iphone/iphone-duo/7.6-inch-display-";
const [W256, N256, W512, N512] = ["MK1E4LL/A", "MK1F4LL/A", "MK1G4LL/A", "MK1H4LL/A"];

// The 12 stores Apple returned for 92618 on 2026-10-26.
const APPLE_STORES = [
  ["Irvine Spectrum Center", "Irvine", "R146", 3.07],
  ["South Coast Plaza", "Costa Mesa", "R004", 9.4],
  ["Mission Viejo", "Mission Viejo", "R069", 9.94],
  ["Fashion Island", "Newport Beach", "R015", 10.01],
  ["Brea Mall", "Brea", "R156", 17.89],
  ["Los Cerritos", "Cerritos", "R300", 24.01],
  ["Victoria Gardens", "Rancho Cucamonga", "R094", 31.01],
  ["Promenade Temecula", "Temecula", "R345", 35.15],
  ["Del Amo", "Torrance", "R777", 36.99],
  ["Tower Theatre", "Los Angeles", "R720", 38.69],
  ["Pasadena", "Pasadena", "R034", 39.59],
  ["Manhattan Village", "Manhattan Beach", "R122", 40.7],
];

// Apple's response shape. inStock looks like { "Irvine Spectrum Center": [N512] }.
function appleSays(inStock = {}, stores = APPLE_STORES) {
  return {
    body: {
      stores: stores.map(([storeName, city, storeNumber, storedistance]) => ({
        storeName,
        city,
        storeNumber,
        storedistance,
        partsAvailability: Object.fromEntries(
          [W256, N256, W512, N512].map((part) => {
            const yes = (inStock[storeName] || []).includes(part);
            return [part, {
              partNumber: part,
              pickupDisplay: yes ? "available" : "unavailable",
              pickupSearchQuote: yes ? "Available Today" : "Currently unavailable",
            }];
          })
        ),
      })),
    },
  };
}

let apple; // next Apple answer: a response body, or an HTTP status number
let ntfyUp; // whether ntfy accepts pushes
let pushes; // ntfy requests made by the last run

// One check.js run. Also asserts the ntfy topic never reaches logs or files.
async function run() {
  pushes = [];
  let logs = "";
  const saved = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(saved)) console[k] = (...a) => { logs += a.join(" ") + "\n"; };
  globalThis.fetch = async (url, opts = {}) => {
    if (url.startsWith("https://ntfy.sh/")) {
      const h = opts.headers;
      pushes.push({ url, title: h.Title, body: opts.body, click: h.Click, priority: h.Priority });
      return { ok: ntfyUp, status: ntfyUp ? 200 : 500 };
    }
    assert.equal(url, VERIFIED_URL);
    if (typeof apple === "number") return { ok: false, status: apple, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => apple };
  };
  try {
    await main();
  } finally {
    Object.assign(console, saved);
  }
  const stateText = fs.readFileSync("state.json", "utf8");
  const statusText = fs.readFileSync("status.json", "utf8");
  for (const text of [logs, stateText, statusText]) assert.ok(!text.includes(TOPIC), "ntfy topic leaked");
  return { stateText, state: JSON.parse(stateText), status: JSON.parse(statusText), logs };
}

const cell = (status, store, part) => status.stores.find((s) => s.name === store).parts[part];

test.beforeEach(() => {
  process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "duo-test-")));
  apple = appleSays();
  ntfyUp = true;
});

test("asks Apple the verified URL", () => {
  assert.equal(PICKUP_URL, VERIFIED_URL);
});

test("first run, no state.json, one model in stock: one push naming model and store", async () => {
  assert.ok(!fs.existsSync("state.json"));
  apple = appleSays({ "Irvine Spectrum Center": [N512] });
  const { state, status } = await run();

  assert.equal(pushes.length, 1);
  assert.deepEqual(pushes[0], {
    url: `https://ntfy.sh/${TOPIC}`,
    title: "512GB Night Sky at Irvine Spectrum",
    body: "Irvine Spectrum (Irvine): Available Today",
    click: `${BUY}512gb-night-sky-unlocked`,
    priority: "urgent",
  });
  assert.deepEqual(state, { inStock: ["Irvine Spectrum|MK1H4LL/A"], failStreak: 0 });
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

test("first run with nothing in stock: no push, empty state", async () => {
  const { state, status } = await run();
  assert.equal(pushes.length, 0);
  assert.deepEqual(state, { inStock: [], failStreak: 0 });
  assert.equal(status.ok, true);
});

test("same stock again: no repeat push, state.json byte-for-byte unchanged", async () => {
  apple = appleSays({ "Irvine Spectrum Center": [N512], "Brea Mall": [W256] });
  const first = await run();
  assert.equal(pushes.length, 2);
  const second = await run();
  assert.equal(pushes.length, 0);
  assert.equal(second.stateText, first.stateText);
});

test("two models at once: one push per model, each with its own buy link", async () => {
  apple = appleSays({ "Irvine Spectrum Center": [W256, N512], "Brea Mall": [N512] });
  const { state } = await run();
  assert.deepEqual(
    pushes.map((p) => [p.title, p.click]),
    [
      ["256GB Star White at Irvine Spectrum", `${BUY}256gb-star-white-unlocked`],
      ["512GB Night Sky at Irvine Spectrum, Brea Mall", `${BUY}512gb-night-sky-unlocked`],
    ]
  );
  assert.equal(pushes[1].body, "Irvine Spectrum (Irvine): Available Today\nBrea Mall (Brea): Available Today");
  assert.deepEqual(state.inStock, [
    "Brea Mall|MK1H4LL/A", "Irvine Spectrum|MK1E4LL/A", "Irvine Spectrum|MK1H4LL/A",
  ]);
});

test("a second model at the same store is its own alert", async () => {
  apple = appleSays({ "Irvine Spectrum Center": [W256] });
  await run();
  apple = appleSays({ "Irvine Spectrum Center": [W256, N512] });
  await run();
  assert.deepEqual(pushes.map((p) => p.title), ["512GB Night Sky at Irvine Spectrum"]);
});

test("sells out then comes back: alerts again", async () => {
  apple = appleSays({ "Fashion Island": [W512] });
  await run();
  apple = appleSays();
  const gone = await run();
  assert.equal(pushes.length, 0);
  assert.deepEqual(gone.state.inStock, []);
  apple = appleSays({ "Fashion Island": [W512] });
  await run();
  assert.deepEqual(pushes.map((p) => p.title), ["512GB Star White at Fashion Island"]);
});

test("a store outside the 7 is ignored", async () => {
  apple = appleSays({ "Del Amo": [W256, N256, W512, N512], "Pasadena": [N512] });
  const { state, status } = await run();
  assert.equal(pushes.length, 0);
  assert.deepEqual(state.inStock, []);
  assert.ok(!status.stores.some((s) => s.name === "Del Amo" || s.name === "Pasadena"));
});

test("failure streak: one 'failing' push at 6, quiet after, then one 'back' push and no repeat stock push", async () => {
  apple = appleSays({ "Irvine Spectrum Center": [N512] });
  await run();
  assert.equal(pushes.length, 1);

  apple = 541;
  for (let i = 1; i <= 5; i++) {
    const { state, status } = await run();
    assert.equal(pushes.length, 0, `no push on failure ${i}`);
    assert.equal(state.failStreak, i);
    assert.deepEqual(state.inStock, ["Irvine Spectrum|MK1H4LL/A"], "stock memory kept through failures");
    assert.equal(status.ok, false);
    assert.equal(status.error, "Apple blocked the request (HTTP 541)");
    assert.equal(cell(status, "Irvine Spectrum", N512), null, "stock is unknown while failing");
  }
  const sixth = await run();
  assert.deepEqual(pushes.map((p) => [p.title, p.priority]), [["Duo checker is failing", "default"]]);
  assert.match(pushes[0].body, /HTTP 541/);
  assert.match(sixth.logs, /::error title=Apple check failed::Apple blocked the request \(HTTP 541\)/);

  for (let i = 7; i <= 9; i++) {
    const later = await run();
    assert.equal(pushes.length, 0, `no push on failure ${i}`);
    assert.equal(later.stateText, sixth.stateText, "state.json stops changing, so no commit per failed run");
  }

  apple = appleSays({ "Irvine Spectrum Center": [N512] });
  const back = await run();
  assert.deepEqual(pushes.map((p) => p.title), ["Duo checker is back"]);
  assert.deepEqual(back.state, { inStock: ["Irvine Spectrum|MK1H4LL/A"], failStreak: 0 });
  assert.equal(back.status.ok, true);
});

test("if the 'failing' push doesn't go out, the next failed run tries again", async () => {
  apple = 541;
  for (let i = 1; i <= 5; i++) await run();
  ntfyUp = false;
  const missed = await run();
  assert.deepEqual(pushes.map((p) => p.title), ["Duo checker is failing"]);
  assert.equal(missed.state.failStreak, 5, "not counted as told");

  ntfyUp = true;
  const told = await run();
  assert.deepEqual(pushes.map((p) => p.title), ["Duo checker is failing"]);
  assert.equal(told.state.failStreak, 6);

  apple = appleSays();
  await run();
  assert.deepEqual(pushes.map((p) => p.title), ["Duo checker is back"]);
});

test("a short failure streak recovers quietly", async () => {
  apple = 503;
  const { status } = await run();
  assert.equal(status.error, "Apple answered HTTP 503");
  await run();
  apple = appleSays();
  const { state } = await run();
  assert.equal(pushes.length, 0);
  assert.equal(state.failStreak, 0);
});

test("HTTP 403 is reported as blocked too", async () => {
  apple = 403;
  const { status } = await run();
  assert.equal(status.error, "Apple blocked the request (HTTP 403)");
});

test("a response with no stores, or none of ours, counts as a failure", async () => {
  apple = { body: {} };
  assert.equal((await run()).status.error, "no stores in Apple's response (Apple may have changed the format)");
  apple = appleSays({}, APPLE_STORES.slice(7));
  const { state, status } = await run();
  assert.equal(status.error, "none of the watched stores are in Apple's response");
  assert.equal(state.failStreak, 2);
});

test("a watched store missing from Apple's answer is unknown, and its stock memory is kept", async () => {
  apple = appleSays({ "Victoria Gardens": [W512] });
  await run();
  assert.equal(pushes.length, 1);

  apple = appleSays({}, APPLE_STORES.filter(([n]) => n !== "Victoria Gardens"));
  const { state, status } = await run();
  const vg = status.stores.find((s) => s.name === "Victoria Gardens");
  assert.equal(status.ok, true);
  assert.equal(vg.found, false);
  assert.equal(vg.parts[W512], null);
  assert.deepEqual(state.inStock, ["Victoria Gardens|MK1G4LL/A"]);

  apple = appleSays({ "Victoria Gardens": [W512] });
  await run();
  assert.equal(pushes.length, 0, "no repeat push when it reappears still in stock");
});

test("if the ntfy push fails, the hit isn't remembered, so the next run retries it", async () => {
  apple = appleSays({ "South Coast Plaza": [N256] });
  ntfyUp = false;
  const failed = await run();
  assert.equal(pushes.length, 1);
  assert.deepEqual(failed.state.inStock, []);
  assert.match(failed.logs, /ntfy push failed: HTTP 500/);

  ntfyUp = true;
  const retried = await run();
  assert.deepEqual(pushes.map((p) => p.title), ["256GB Night Sky at South Coast Plaza"]);
  assert.deepEqual(retried.state.inStock, ["South Coast Plaza|MK1F4LL/A"]);
});

test("unreadable state.json is logged and replaced, not a crash", async () => {
  fs.writeFileSync("state.json", "{not json");
  apple = appleSays({ "Mission Viejo": [W256] });
  const { state, logs } = await run();
  assert.match(logs, /state\.json unreadable, starting fresh/);
  assert.deepEqual(state.inStock, ["Mission Viejo|MK1E4LL/A"]);
});

test("without NTFY_TOPIC nothing is sent and nothing crashes", async () => {
  delete process.env.NTFY_TOPIC;
  try {
    apple = appleSays({ "Los Cerritos": [N512] });
    const { state, logs } = await run();
    assert.equal(pushes.length, 0);
    assert.match(logs, /NTFY_TOPIC not set, push skipped/);
    assert.deepEqual(state.inStock, [], "kept unalerted so it pushes once the secret is set");
  } finally {
    process.env.NTFY_TOPIC = TOPIC;
  }
});

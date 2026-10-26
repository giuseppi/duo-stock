#!/usr/bin/env node
// Watches Apple Store pickup availability for the iPhone Duo models and
// stores in duo.js, and pings your phone through ntfy.sh when one shows up.
// Laptop version of check.js: faster, but only runs while this does.
//
// Usage:
//   NTFY_TOPIC=your-topic node duo-watch.js   (sends a test push on startup)
//   node duo-watch.js --no-test  (skip the test push)
//
// Needs Node 20+ (built in fetch). No npm install.

const { MODELS, STORES, HEADERS, fetchRows, notify, alertNew } = require("./duo");

const INTERVAL_SEC = Number(process.env.INTERVAL_SEC || 120);
const NTFY_TOPIC = process.env.NTFY_TOPIC; // subscribe to this in the ntfy app

let alerted = []; // "store|part" already pushed; dropped when it sells out so a restock re-alerts
let cookies = "";

// Load the product page first like a browser would, and keep its cookies.
// The pickup endpoint works without them, but a fresh session is a cheap
// thing to try after a block.
async function warmUp() {
  const res = await fetch(MODELS[0].buy, {
    headers: { "User-Agent": HEADERS["User-Agent"], Accept: "text/html", "Accept-Language": "en-US,en;q=0.9" },
    signal: AbortSignal.timeout(20000),
  });
  const set = res.headers.getSetCookie?.() || [];
  cookies = set.map((c) => c.split(";")[0]).join("; ");
  console.log(`warmed up (page ${res.status}, ${set.length} cookies)`);
}

// Extra headers the browser sends with this request, as JSON in the
// DUO_EXTRA_HEADERS env var. If 541 keeps happening: in Chrome, open a buy
// page, open DevTools > Network, click "Check availability" for pickup, right
// click the pickup-message request > Copy > Copy as cURL, and put the header
// values there. Never paste them into this file: a copied request carries
// your Apple sign-in cookies, and this repo is public.
const EXTRA_HEADERS = JSON.parse(process.env.DUO_EXTRA_HEADERS || "{}");

async function check() {
  if (!cookies) await warmUp();
  let rows;
  try {
    rows = await fetchRows({
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Dest": "empty",
      ...(cookies ? { Cookie: cookies } : {}),
      ...EXTRA_HEADERS,
    });
  } catch (e) {
    if (e.blocked) cookies = ""; // get a fresh session next time
    throw e;
  }
  alerted = await alertNew(rows, alerted);

  const now = new Date().toLocaleTimeString();
  const found = rows.flatMap((r) =>
    MODELS.filter((m) => r.parts[m.part]?.available).map((m) => `${m.name} at ${r.name}`)
  );
  const missing = rows.filter((r) => !r.found).map((r) => r.name);
  console.log(
    `[${now}] ${found.length ? "AVAILABLE: " + found.join(", ") : `nothing yet (${rows.length - missing.length} stores checked)`}` +
      (missing.length ? `; not in Apple's list: ${missing.join(", ")}` : "")
  );
}

let blockedStreak = 0;

async function loop() {
  try {
    await check();
    blockedStreak = 0;
  } catch (e) {
    blockedStreak = e.blocked ? blockedStreak + 1 : 0;
    console.error(`[${new Date().toLocaleTimeString()}] check failed: ${e.message}`);
    if (blockedStreak === 5) {
      await notify("Duo watcher is blocked", "Apple has blocked 5 checks in a row. The watcher is still running but probably isn't seeing stock.");
    }
  }
  // back off when blocked (2x, 4x, then 7.5x the interval: 4, 8, 15 min at
  // the default 2 min), plus random jitter
  const backoff = blockedStreak ? Math.min(2 ** blockedStreak, 7.5) : 1;
  const wait = INTERVAL_SEC * 1000 * backoff + Math.floor(Math.random() * 20000);
  setTimeout(loop, wait);
}

process.on("unhandledRejection", (e) => {
  console.error("duo-watch crashed:", e);
  process.exit(1);
});

if (!NTFY_TOPIC) console.warn("NTFY_TOPIC not set, alerts will only print to the terminal.");
console.log(
  `Watching ${MODELS.length} models at ${STORES.length} stores every ~${INTERVAL_SEC}s` +
    (NTFY_TOPIC ? ", alerts to your ntfy topic" : "")
);
(async () => {
  if (!process.argv.includes("--no-test")) {
    await notify("Duo watcher running", "Test push. You'll get an alert like this when stock shows up.", {
      click: "https://ntfy.sh/" + NTFY_TOPIC,
    });
  }
  loop();
})();

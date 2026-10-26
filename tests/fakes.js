// Shared fakes for the end-to-end tests: Apple's pickup answer, a GitHub
// contents API with real SHA checks, and an ntfy recorder. Not a test file.

const crypto = require("crypto");
const { PICKUP_URL } = require("../duo");

const [W256, N256, W512, N512] = ["MK1E4LL/A", "MK1F4LL/A", "MK1G4LL/A", "MK1H4LL/A"];

const hours = (...rows) => ({
  storeHours: rows.map(([storeDays, voStoreDays, storeTimings]) => ({ storeDays, voStoreDays, storeTimings })),
  timezone: "America/Los_Angeles",
});
const FRI_SAT = ["Fri-Sat", "Friday-Saturday"];
const SUN = ["Sun", "Sunday"];
const MON_THU = ["Mon-Thu", "Monday-Thursday"];
const MON_SAT = ["Mon-Sat", "Monday-Saturday"];
const at = (days, timings) => [days[0], days[1], timings];
const T10_8 = "10:00 AM-8:00 PM";
const T10_9 = "10:00 AM-9:00 PM";
const T11_7 = "11:00 AM-7:00 PM";
const T10_10 = "10:00 AM-10:00 PM";
const T11_6 = "11:00 AM-6:00 PM";

// Hours as Apple returned them on 2026-10-26 (see the design doc).
const WATCHED_HOURS = {
  R146: hours(at(FRI_SAT, T10_10), ["Mon-Thu, Sun", "Monday-Thursday, Sunday", T10_9]),
  R004: hours(at(SUN, T11_7), at(MON_THU, T10_8), at(FRI_SAT, T10_9)),
  R069: hours(at(SUN, T11_7), at(MON_SAT, T10_8)),
  R015: hours(at(MON_SAT, T10_8), at(SUN, T11_6)),
  R156: hours(at(SUN, T11_7), at(MON_THU, T10_8), at(FRI_SAT, T10_9)),
  R300: hours(at(SUN, T11_7), at(MON_SAT, T10_9)),
  R094: hours(at(SUN, T11_7), at(MON_THU, T10_8), at(FRI_SAT, T10_9)),
};

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
        ...(WATCHED_HOURS[storeNumber] && { retailStore: WATCHED_HOURS[storeNumber] }),
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

const reply = (status, body) =>
  new Response(status === 204 ? null : JSON.stringify(body ?? {}), { status });
const shaOf = (text) => crypto.createHash("sha1").update(text).digest("hex");

// A GitHub contents API holding one file, state.json.
function fakeGitHub({ repo = "giuseppi/duo-stock" } = {}) {
  const base = `https://api.github.com/repos/${repo}`;
  let text = null; // the file, or null when it does not exist
  let sha = null;
  let before = null;
  const failures = [];
  const self = { puts: [], dispatches: 0 };

  const store = (next) => { text = next; sha = shaOf(next + Math.random()); };

  function put(body) {
    if (before) { const fn = before; before = null; fn(); }
    self.puts.push(body);
    if (text !== null && !body.sha) return reply(422);
    if (body.sha && body.sha !== sha) return reply(409);
    const created = text === null;
    store(Buffer.from(body.content, "base64").toString("utf8"));
    return reply(created ? 201 : 200, { content: { sha }, commit: { sha: shaOf(sha) } });
  }

  return Object.assign(self, {
    handle(url, opts = {}) {
      const method = opts.method || "GET";
      const hit = failures.findIndex((f) => f.method === method && f.times > 0);
      if (hit >= 0) { failures[hit].times -= 1; return reply(failures[hit].status); }
      if (url.startsWith(`${base}/actions/workflows/check.yml/dispatches`) && method === "POST") {
        self.dispatches += 1;
        return reply(204);
      }
      if (!url.startsWith(`${base}/contents/state.json`)) return reply(404);
      if (method === "PUT") return put(JSON.parse(opts.body));
      if (text === null) return reply(404);
      const content = Buffer.from(text).toString("base64").replace(/(.{60})/g, "$1\n");
      return reply(200, { type: "file", encoding: "base64", content, sha });
    },
    file: () => (text === null ? null : JSON.parse(text)),
    setFile: (obj) => store(JSON.stringify(obj, null, 2) + "\n"),
    setRaw: (raw) => store(raw),
    failNext: (method, status, times = 1) => failures.push({ method, status, times }),
    beforeNextPut: (fn) => { before = fn; },
  });
}

// Routes global fetch: GitHub, ntfy (recorded), Apple's pickup URL, buy pages.
function installFetch({ apple, github, ntfyUp = true }) {
  const pushes = [];
  globalThis.fetch = async (url, opts = {}) => {
    if (url.startsWith("https://api.github.com/")) return github.handle(url, opts);
    if (url.startsWith("https://ntfy.sh/")) {
      const h = opts.headers;
      pushes.push({ url, title: h.Title, body: opts.body, click: h.Click, priority: h.Priority });
      return new Response(null, { status: ntfyUp ? 200 : 500 });
    }
    if (url.startsWith("https://www.apple.com/shop/buy-iphone/")) return new Response("", { status: 200 });
    if (url === PICKUP_URL) {
      const answer = apple();
      return typeof answer === "number" ? reply(answer) : reply(200, answer);
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return { pushes };
}

function captureConsole() {
  let logs = "";
  const saved = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(saved)) console[k] = (...a) => { logs += a.join(" ") + "\n"; };
  return { text: () => logs, restore: () => Object.assign(console, saved) };
}

module.exports = { APPLE_STORES, appleSays, fakeGitHub, installFetch, captureConsole };

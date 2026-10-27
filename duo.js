// Shared by check.js (GitHub Actions) and duo-watch.js (laptop): what to
// watch, how to ask Apple, and how to push new stock to ntfy.

const ZIP = "92618";

const buyPage = (slug) =>
  `https://www.apple.com/shop/buy-iphone/iphone-duo/7.6-inch-display-${slug}-unlocked`;

const MODELS = [{ part: "MK1E4LL/A", name: "256GB Star White", buy: buyPage("256gb-star-white") }];

// Matched against Apple's storeName. By name, not distance: Victoria Gardens
// is ~31 mi from ZIP.
const STORES = [
  "Irvine Spectrum",
  "South Coast Plaza",
  "Mission Viejo",
  "Fashion Island",
  "Brea Mall",
  "Los Cerritos",
  "Victoria Gardens",
];

// Apple's old fulfillment-messages endpoint returns 541 for everyone (even
// Apple's own page). This retail pickup endpoint works, even without cookies.
const PICKUP_URL =
  "https://www.apple.com/shop/retail/pickup-message?pl=true&" +
  MODELS.map((m, i) => `parts.${i}=${encodeURIComponent(m.part)}`).join("&") +
  `&location=${ZIP}`;

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  Accept: "*/*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: MODELS[0].buy,
};

// One row per watched store, in STORES order. A store Apple left out, or a
// part missing from a store, is null (unknown), not unavailable.
function toRows(apiStores) {
  return STORES.map((name) => {
    const s = apiStores.find((x) => (x.storeName || "").includes(name));
    const parts = {};
    for (const { part } of MODELS) {
      const info = s?.partsAvailability?.[part];
      parts[part] = info
        ? { available: info.pickupDisplay === "available", quote: info.pickupSearchQuote || "" }
        : null;
    }
    const hours = s?.retailStore?.storeHours;
    return {
      name,
      city: s?.city || "",
      miles: Number(s?.storedistance) || null,
      found: Boolean(s),
      hours: Array.isArray(hours)
        ? hours.map(({ storeDays, storeTimings }) => ({ storeDays, storeTimings }))
        : null,
      parts,
    };
  });
}

// Throws with err.blocked set when Apple refuses us (541 or 403).
async function fetchRows(extraHeaders = {}) {
  const res = await fetch(PICKUP_URL, {
    headers: { ...HEADERS, ...extraHeaders },
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 541 || res.status === 403) {
    throw Object.assign(new Error(`Apple blocked the request (HTTP ${res.status})`), { blocked: true });
  }
  if (!res.ok) throw new Error(`Apple answered HTTP ${res.status}`);
  const stores = (await res.json())?.body?.stores;
  if (!Array.isArray(stores) || !stores.length) {
    throw new Error("no stores in Apple's response (Apple may have changed the format)");
  }
  const rows = toRows(stores);
  if (!rows.some((r) => r.found)) throw new Error("none of the watched stores are in Apple's response");
  return rows;
}

// The topic only ever comes from the env (a repo secret on GitHub). Anyone
// who knows it can read and send your pushes, so it is never logged.
async function notify(title, body, { priority = "urgent", click } = {}) {
  console.log(`PUSH: ${title}\n${body}`);
  const topic = process.env.NTFY_TOPIC;
  if (!topic) {
    console.warn("NTFY_TOPIC not set, push skipped");
    return false;
  }
  try {
    const res = await fetch(`https://ntfy.sh/${topic}`, {
      method: "POST",
      body,
      headers: { Title: title, Priority: priority, Tags: "iphone", ...(click && { Click: click }) },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return true;
  } catch (e) {
    console.error(`ntfy push failed: ${e.message}`);
    return false;
  }
}

// Pushes the claims: one push per model so the title and Click link fit it,
// all at once. Returns the claims whose push failed so the caller can undo them.
async function pushClaims(claims, rows) {
  const failed = await Promise.all(
    MODELS.map(async (model) => {
      const mine = claims.filter((c) => c.part === model.part);
      if (!mine.length) return [];
      const hits = STORES.filter((name) => mine.some((c) => c.store === name)).map((name) =>
        rows.find((r) => r.name === name)
      );
      const pushed = await notify(
        `${model.name} at ${hits.map((r) => r.name).join(", ")}`,
        hits.map((r) => `${r.name} (${r.city}): ${r.parts[model.part].quote || "Available"}`).join("\n"),
        { click: model.buy }
      );
      return pushed ? [] : mine;
    })
  );
  return failed.flat();
}

module.exports = { MODELS, STORES, PICKUP_URL, HEADERS, toRows, fetchRows, notify, pushClaims };

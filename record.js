// The shared record (state.json) and the rules for changing it. Pure: no I/O,
// so check.js and duo-watch.js can both lean on it and it is easy to test.

const FLAP_MS = 10 * 60 * 1000;

const emptyRecord = () => ({ version: 2, failStreak: 0, hours: {}, restocks: [] });

const isPlainObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

// Turns whatever state.json held (v1 or v2) into a v2 record.
function migrate(raw, nowIso) {
  if (!isPlainObject(raw)) throw new Error("state.json has an unknown format");
  const record = emptyRecord();
  record.failStreak = Number(raw.failStreak) || 0;
  if (raw.version === 2) {
    if (isPlainObject(raw.hours)) record.hours = structuredClone(raw.hours);
    if (Array.isArray(raw.restocks)) record.restocks = structuredClone(raw.restocks);
    return record;
  }
  // v1 only knew what was in stock and already pinged: treat each as open.
  for (const key of Array.isArray(raw.inStock) ? raw.inStock : []) {
    const cut = key.indexOf("|");
    const store = key.slice(0, cut);
    const part = key.slice(cut + 1);
    let restock = record.restocks.find((r) => r.store === store);
    if (!restock) record.restocks.push((restock = { store, parts: {} }));
    restock.parts[part] = { in: nowIso, out: null };
  }
  return record;
}

const partList = (r) => Object.values(r.parts);

function restockStart(r) {
  return partList(r)
    .map((p) => p.in)
    .sort()[0];
}

function restockEnd(r) {
  const outs = partList(r).map((p) => p.out);
  return outs.includes(null) ? null : outs.sort().at(-1);
}

function latestRestock(record, store) {
  return record.restocks.findLast((r) => r.store === store);
}

// Keys ("<store>|<part>") in stock and already claimed.
function claimedKeys(record) {
  const keys = new Set();
  const seen = new Set();
  for (const r of [...record.restocks].reverse()) {
    if (seen.has(r.store)) continue;
    seen.add(r.store);
    for (const [part, p] of Object.entries(r.parts)) if (p.out === null) keys.add(`${r.store}|${part}`);
  }
  return keys;
}

// A restock still counts as "the same one" while open or just ended (a flap).
function isLive(restock, now) {
  if (!restock) return false;
  const end = restockEnd(restock);
  return end === null || now - Date.parse(end) <= FLAP_MS;
}

// Records an in-stock part. Returns a claim, or null when nobody should ping.
function markAvailable(record, row, part, nowIso, pinged) {
  const now = Date.parse(nowIso);
  const key = `${row.name}|${part}`;
  let restock = latestRestock(record, row.name);
  if (!isLive(restock, now)) {
    record.restocks.push((restock = { store: row.name, parts: {} }));
  }
  const known = restock.parts[part];
  if (known?.out === null) return { changed: false, claim: null };
  if (known) {
    const prevOut = known.out;
    known.out = null;
    const isFlap = now - Date.parse(prevOut) <= FLAP_MS;
    return { changed: true, claim: isFlap ? null : { store: row.name, part, prevOut } };
  }
  const seenAt = pinged?.get(key);
  restock.parts[part] = { in: seenAt ?? nowIso, out: null };
  return { changed: true, claim: seenAt ? null : { store: row.name, part, prevOut: null } };
}

function markSoldOut(record, row, part, nowIso) {
  const p = latestRestock(record, row.name)?.parts[part];
  if (!p || p.out !== null) return false;
  p.out = nowIso;
  return true;
}

// Applies one check's rows. Never mutates `record`. `pinged` maps keys the
// laptop already pinged offline to when it first saw them: recorded, no claim.
function applyRows(record, rows, nowIso, { pinged } = {}) {
  const next = structuredClone(record);
  const claims = [];
  let changed = false;
  for (const row of rows) {
    if (row.hours && JSON.stringify(row.hours) !== JSON.stringify(next.hours[row.name])) {
      next.hours[row.name] = structuredClone(row.hours);
      changed = true;
    }
    for (const [part, cell] of Object.entries(row.parts)) {
      if (cell === null) continue;
      if (cell.available) {
        const res = markAvailable(next, row, part, nowIso, pinged);
        changed ||= res.changed;
        if (res.claim) claims.push(res.claim);
      } else {
        changed = markSoldOut(next, row, part, nowIso) || changed;
      }
    }
  }
  return { record: next, claims, changed };
}

// Undoes claims whose ping failed, so the next check tries again.
function unclaim(record, claims) {
  const next = structuredClone(record);
  let changed = false;
  for (const { store, part, prevOut } of claims) {
    const restock = latestRestock(next, store);
    if (!restock?.parts[part]) continue;
    changed = true;
    if (prevOut !== null) {
      restock.parts[part].out = prevOut;
      continue;
    }
    delete restock.parts[part];
    if (!partList(restock).length) next.restocks.splice(next.restocks.lastIndexOf(restock), 1);
  }
  return { record: next, changed };
}

module.exports = {
  FLAP_MS,
  emptyRecord,
  migrate,
  restockStart,
  restockEnd,
  claimedKeys,
  applyRows,
  unclaim,
};

const test = require("node:test");
const assert = require("node:assert/strict");
const { toRows } = require("../duo");
const { emptyRecord, migrate, restockEnd, claimedKeys, applyRows, unclaim } = require("../record");

const T0 = "2026-10-27T14:00:00.000Z";
const at = (min) => new Date(Date.parse(T0) + min * 60000).toISOString();
const E = "MK1E4LL/A";
const H = "MK1H4LL/A";
const PARTS = ["MK1E4LL/A", "MK1F4LL/A", "MK1G4LL/A", "MK1H4LL/A"];

// `avail` lists the parts in stock; `unknown` lists parts Apple left out.
function row(name, avail = [], { unknown = [], found = true, hours = null } = {}) {
  const parts = {};
  for (const p of PARTS) {
    parts[p] = unknown.includes(p) ? null : { available: avail.includes(p), quote: "" };
  }
  return { name, city: "", miles: null, found, hours, parts };
}
const IRV = "Irvine Spectrum";
const claim = (part, prevOut = null) => ({ store: IRV, part, prevOut });

test("new stock opens a restock and claims it", () => {
  const r = applyRows(emptyRecord(), [row(IRV, [H])], T0);
  assert.deepEqual(r.claims, [claim(H)]);
  assert.equal(r.record.restocks.length, 1);
  assert.equal(r.changed, true);
});

test("same stock again changes nothing", () => {
  const first = applyRows(emptyRecord(), [row(IRV, [H])], T0);
  const again = applyRows(first.record, [row(IRV, [H])], at(5));
  assert.equal(again.claims.length, 0);
  assert.equal(again.changed, false);
});

test("two models at one store are one restock", () => {
  const r = applyRows(emptyRecord(), [row(IRV, [E, H])], T0);
  assert.equal(r.claims.length, 2);
  assert.equal(r.record.restocks.length, 1);
});

test("a model joining an open restock is claimed", () => {
  const a = applyRows(emptyRecord(), [row(IRV, [E])], at(0));
  const b = applyRows(a.record, [row(IRV, [E, H])], at(5));
  assert.deepEqual(b.claims, [claim(H)]);
  assert.equal(b.record.restocks.length, 1);
});

test("sold out closes the part and ends the restock", () => {
  const a = applyRows(emptyRecord(), [row(IRV, [H])], at(0));
  const b = applyRows(a.record, [row(IRV, [])], at(25));
  assert.equal(restockEnd(b.record.restocks[0]), at(25));
  assert.equal(claimedKeys(b.record).size, 0);
  assert.equal(b.changed, true);
});

test("back within 10 minutes is a flap", () => {
  let rec = applyRows(emptyRecord(), [row(IRV, [H])], at(0)).record;
  rec = applyRows(rec, [row(IRV, [])], at(20)).record;
  const back = applyRows(rec, [row(IRV, [H])], at(29));
  assert.equal(back.claims.length, 0);
  assert.equal(back.record.restocks.length, 1);
  assert.equal(restockEnd(back.record.restocks[0]), null);
});

test("back after more than 10 minutes is a new restock", () => {
  let rec = applyRows(emptyRecord(), [row(IRV, [H])], at(0)).record;
  rec = applyRows(rec, [row(IRV, [])], at(20)).record;
  const back = applyRows(rec, [row(IRV, [H])], at(31));
  assert.equal(back.claims.length, 1);
  assert.equal(back.record.restocks.length, 2);
});

// E stays in stock, H sells out at 5 and returns at 20.
function returning() {
  let rec = applyRows(emptyRecord(), [row(IRV, [E, H])], at(0)).record;
  rec = applyRows(rec, [row(IRV, [E])], at(5)).record;
  return { rec, back: applyRows(rec, [row(IRV, [E, H])], at(20)) };
}

test("a model returning after 10+ minutes inside an open restock is claimed again", () => {
  const { back } = returning();
  assert.deepEqual(back.claims, [claim(H, at(5))]);
  assert.equal(back.record.restocks.length, 1);
});

test("unknown cells keep what was known", () => {
  const a = applyRows(emptyRecord(), [row(IRV, [H])], at(0));
  const nullCell = applyRows(a.record, [row(IRV, [], { unknown: [H] })], at(5));
  assert.equal(nullCell.changed, false);
  assert.ok(claimedKeys(nullCell.record).has(`${IRV}|${H}`));
  const notFound = applyRows(a.record, [row(IRV, [], { unknown: PARTS, found: false })], at(5));
  assert.equal(notFound.changed, false);
  assert.ok(claimedKeys(notFound.record).has(`${IRV}|${H}`));
});

test("pinged keys are recorded without a claim", () => {
  const pinged = new Map([[`Brea Mall|${E}`, at(-7)]]);
  const r = applyRows(emptyRecord(), [row("Brea Mall", [E])], T0, { pinged });
  assert.equal(r.claims.length, 0);
  assert.equal(r.record.restocks[0].parts[E].in, at(-7));
  assert.ok(claimedKeys(r.record).has(`Brea Mall|${E}`));
});

test("a pinged key returning inside an open restock is recorded without a claim", () => {
  const { rec } = returning();
  const pinged = new Map([[`${IRV}|${H}`, at(18)]]);
  const back = applyRows(rec, [row(IRV, [E, H])], at(20), { pinged });
  assert.equal(back.claims.length, 0);
  assert.equal(back.record.restocks[0].parts[H].out, null);
  assert.equal(back.record.restocks[0].parts[H].in, at(0));
});

test("unclaim removes a new part and an empty restock", () => {
  const r = applyRows(emptyRecord(), [row(IRV, [H])], T0);
  const u = unclaim(r.record, r.claims);
  assert.equal(u.record.restocks.length, 0);
  assert.equal(u.changed, true);
});

test("unclaim restores a returning part", () => {
  const { back } = returning();
  const u = unclaim(back.record, back.claims);
  assert.equal(u.record.restocks[0].parts[H].out, at(5));
});

test("hours are stored once and only change when Apple's do", () => {
  const hours = [{ storeDays: "Fri-Sat", storeTimings: "10:00 AM-10:00 PM" }];
  const a = applyRows(emptyRecord(), [row(IRV, [], { hours })], T0);
  assert.deepEqual(a.record.hours[IRV], hours);
  assert.equal(a.changed, true);
  const same = applyRows(a.record, [row(IRV, [], { hours: structuredClone(hours) })], at(5));
  assert.equal(same.changed, false);
  const none = applyRows(a.record, [row(IRV, [], { hours: null })], at(5));
  assert.equal(none.changed, false);
  assert.deepEqual(none.record.hours[IRV], hours);
  const newHours = [{ storeDays: "Mon-Sun", storeTimings: "9:00 AM-9:00 PM" }];
  const diff = applyRows(a.record, [row(IRV, [], { hours: newHours })], at(5));
  assert.equal(diff.changed, true);
  assert.deepEqual(diff.record.hours[IRV], newHours);
});

test("applyRows does not mutate its input", () => {
  const { rec } = returning();
  const before = structuredClone(rec);
  applyRows(rec, [row(IRV, [E, H], { hours: [{ storeDays: "x", storeTimings: "y" }] })], at(40));
  assert.deepEqual(rec, before);
});

test("migrate turns v1 inStock into open claims", () => {
  const rec = migrate({ inStock: [`${IRV}|${H}`], failStreak: 2 }, T0);
  assert.ok(claimedKeys(rec).has(`${IRV}|${H}`));
  assert.equal(rec.failStreak, 2);
  assert.equal(rec.version, 2);
  assert.equal(applyRows(rec, [row(IRV, [H])], at(5)).claims.length, 0);
});

test("migrate fills missing v2 fields", () => {
  assert.deepEqual(migrate({ version: 2 }, T0), emptyRecord());
});

test("migrate rejects non-objects", () => {
  for (const bad of [null, [], "x"]) assert.throws(() => migrate(bad, T0), /unknown format/);
});

test("toRows keeps only storeDays and storeTimings of Apple's hours", () => {
  const store = {
    storeName: "Irvine Spectrum",
    retailStore: {
      storeHours: [
        { storeDays: "Fri-Sat", voStoreDays: "Friday to Saturday", storeTimings: "10:00 AM-10:00 PM" },
        { storeDays: "Sun", voStoreDays: "Sunday", storeTimings: "11:00 AM-7:00 PM" },
      ],
    },
  };
  const rows = toRows([store]);
  assert.deepEqual(rows[0].hours, [
    { storeDays: "Fri-Sat", storeTimings: "10:00 AM-10:00 PM" },
    { storeDays: "Sun", storeTimings: "11:00 AM-7:00 PM" },
  ]);
  assert.equal(rows[1].hours, null);
});

const test = require("node:test");
const assert = require("node:assert/strict");
const { WINDOWS, pacific, parseHours, formatDuration, summarize } = require("../history");

const E = "MK1E4LL/A";
const H = "MK1H4LL/A";
const IRV = "Irvine Spectrum";
const SCP = "South Coast Plaza";

const h = (storeDays, storeTimings) => ({ storeDays, storeTimings });
const REAL_HOURS = {
  "Irvine Spectrum": [h("Fri-Sat", "10:00 AM-10:00 PM"), h("Mon-Thu, Sun", "10:00 AM-9:00 PM")],
  "South Coast Plaza": [h("Sun", "11:00 AM-7:00 PM"), h("Mon-Thu", "10:00 AM-8:00 PM"), h("Fri-Sat", "10:00 AM-9:00 PM")],
  "Mission Viejo": [h("Sun", "11:00 AM-7:00 PM"), h("Mon-Sat", "10:00 AM-8:00 PM")],
  "Fashion Island": [h("Mon-Sat", "10:00 AM-8:00 PM"), h("Sun", "11:00 AM-6:00 PM")],
  "Brea Mall": [h("Sun", "11:00 AM-7:00 PM"), h("Mon-Thu", "10:00 AM-8:00 PM"), h("Fri-Sat", "10:00 AM-9:00 PM")],
  "Los Cerritos": [h("Sun", "11:00 AM-7:00 PM"), h("Mon-Sat", "10:00 AM-9:00 PM")],
  "Victoria Gardens": [h("Sun", "11:00 AM-7:00 PM"), h("Mon-Thu", "10:00 AM-8:00 PM"), h("Fri-Sat", "10:00 AM-9:00 PM")],
};

// A restock starting at a Pacific (PDT, UTC-7) wall-clock time, lasting `min`
// minutes (null = still open). Only valid before the Nov 1 change.
const pdt = (day, hh, mm) => new Date(Date.UTC(2026, 9, day, hh + 7, mm)).toISOString();
function rs(store, day, hh, mm, min, parts = [E]) {
  const start = pdt(day, hh, mm);
  const out = min === null ? null : new Date(Date.parse(start) + min * 60000).toISOString();
  return { store, parts: Object.fromEntries(parts.map((p) => [p, { in: start, out }])) };
}
const rec = (restocks, hours = {}) => ({ version: 2, failStreak: 0, hours, restocks });

test("pacific uses Pacific time across the DST change", () => {
  assert.equal(pacific("2026-11-01T08:30:00Z").minutes, 90);
  assert.equal(pacific("2026-11-01T09:30:00Z").minutes, 90);
  const p = pacific("2026-10-27T14:12:00Z");
  assert.equal(p.label, "Tue Oct 27, 7:12 AM");
  assert.equal(p.weekday, 2);
  assert.equal(p.day, "Oct 27");
  assert.ok(!p.label.includes(" "));
});

test("parseHours reads all seven real stores", () => {
  const open = (store) => parseHours(REAL_HOURS[store]);
  assert.deepEqual(open(IRV), [600, 600, 600, 600, 600, 600, 600]);
  assert.deepEqual(open(SCP), [660, 600, 600, 600, 600, 600, 600]);
  assert.deepEqual(open("Mission Viejo"), [660, 600, 600, 600, 600, 600, 600]);
  assert.deepEqual(open("Fashion Island"), [660, 600, 600, 600, 600, 600, 600]);
  assert.deepEqual(open("Brea Mall"), [660, 600, 600, 600, 600, 600, 600]);
  assert.deepEqual(open("Los Cerritos"), [660, 600, 600, 600, 600, 600, 600]);
  assert.deepEqual(open("Victoria Gardens"), [660, 600, 600, 600, 600, 600, 600]);
});

test("parseHours skips unknown formats", () => {
  const none = [null, null, null, null, null, null, null];
  assert.deepEqual(parseHours([{ storeDays: "Nov 27", storeTimings: "Closed" }]), none);
  assert.deepEqual(parseHours(null), none);
});

test("parseHours handles wrapping ranges and 12 o'clock", () => {
  const got = parseHours([h("Sat-Mon", "12:30 PM-6:00 PM"), h("Wed", "12:00 AM-1:00 AM")]);
  assert.deepEqual(got, [750, 750, null, 0, null, null, 750]);
});

test("formatDuration", () => {
  assert.equal(formatDuration(0), "1 min");
  assert.equal(formatDuration(25), "25 min");
  assert.equal(formatDuration(60), "1 hr");
  assert.equal(formatDuration(95), "1.5 hr");
  assert.equal(formatDuration(120), "2 hr");
});

test("no restocks", () => {
  const s = summarize(rec([]));
  assert.equal(s.count, 0);
  assert.equal(s.basis, null);
  assert.equal(s.best, null);
  assert.equal(s.learning, "No restocks seen yet. This fills in as the checker spots them.");
  assert.equal(s.grid.length, 7);
  assert.ok(s.grid.every((g) => g.total === 0 && g.counts.length === 5 && g.counts.every((c) => c === 0)));
  assert.deepEqual(s.log, []);
});

test("still learning below 3", () => {
  const two = summarize(rec([rs(IRV, 26, 8, 0, 10), rs(IRV, 27, 8, 0, 10)]));
  assert.equal(two.best, null);
  assert.equal(two.learning, "Still learning: 2 restocks seen so far.");
  const one = summarize(rec([rs(IRV, 26, 8, 0, 10)]));
  assert.equal(one.learning, "Still learning: 1 restock seen so far.");
  assert.equal(one.basis, "Based on 1 restock seen since Oct 26.");
});

test("tie at the top", () => {
  const rows = [26, 27, 28].flatMap((d) => [rs(IRV, d, 8, 0, 10), rs(SCP, d, 8, 0, 10)]);
  const s = summarize(rec(rows));
  assert.equal(s.best, null);
  assert.equal(
    s.learning,
    "No clear favorite yet: Irvine Spectrum and South Coast Plaza have 3 restocks each."
  );
  assert.equal(s.basis, "Based on 6 restocks seen since Oct 26.");
});

const irvineWeek = () =>
  rec(
    [
      rs(IRV, 26, 7, 0, 10),
      rs(IRV, 27, 7, 30, 20),
      rs(IRV, 28, 8, 0, 25),
      rs(IRV, 29, 8, 30, 30),
      rs(IRV, 30, 10, 15, 40),
    ],
    { [IRV]: REAL_HOURS[IRV] }
  );

test("best bet with before-opening and usual duration", () => {
  const { best, learning } = summarize(irvineWeek());
  assert.equal(learning, null);
  assert.equal(best.title, "Best bet: Irvine Spectrum, 6 to 9 AM");
  assert.equal(
    best.detail,
    "4 of its 5 restocks showed up before it opens at 10 AM, and they usually last about 25 min."
  );
});

test("mixed opening times drop the time", () => {
  const rows = [25, 26, 27].map((d) => rs(SCP, d, 8, 0, 20));
  const { best } = summarize(rec(rows, { [SCP]: REAL_HOURS[SCP] }));
  assert.equal(best.title, "Best bet: South Coast Plaza, 6 to 9 AM");
  assert.equal(best.detail, "3 of its 3 restocks showed up before it opens, and they usually last about 20 min.");
});

test("unknown hours drop the before-opening part", () => {
  const { best } = summarize(rec([26, 27, 28].map((d) => rs(IRV, d, 8, 0, 20))));
  assert.equal(best.detail, "Its restocks usually last about 20 min.");
});

test("before-opening only, and neither", () => {
  const hours = { [IRV]: REAL_HOURS[IRV] };
  const open = summarize(rec([26, 27, 28].map((d) => rs(IRV, d, 8, 0, null)), hours));
  assert.equal(open.best.detail, "3 of its 3 restocks showed up before it opens at 10 AM.");
  const neither = summarize(rec([26, 27, 28].map((d) => rs(IRV, d, 8, 0, null))));
  assert.equal(neither.best.detail, "");
  const late = summarize(rec([26, 27, 28].map((d) => rs(IRV, d, 11, 0, null)), hours));
  assert.equal(late.best.detail, "");
});

test("usual duration uses the mean of the middle two when even", () => {
  const rows = [10, 20, 30, 40].map((m, i) => rs(IRV, 26 + i, 11, 0, m));
  assert.match(summarize(rec(rows)).best.detail, /usually last about 25 min\.$/);
});

test("opening time with minutes is shown in full", () => {
  const hours = { [IRV]: [h("Mon-Sun", "10:30 AM-9:00 PM")] };
  const rows = [26, 27, 28].map((d) => rs(IRV, d, 8, 0, null));
  assert.match(summarize(rec(rows, hours)).best.detail, /before it opens at 10:30 AM\.$/);
});

test("grid counts by window and sorts", () => {
  const { grid, count } = summarize(irvineWeek());
  assert.equal(count, 5);
  assert.deepEqual(WINDOWS, ["12-6a", "6-9a", "9a-12", "12-5p", "5p-12"]);
  assert.deepEqual(grid[0], { store: IRV, counts: [0, 4, 1, 0, 0], total: 5 });
  assert.deepEqual(grid.at(-1), { store: "Victoria Gardens", counts: [0, 0, 0, 0, 0], total: 0 });
  assert.equal(grid[1].store, SCP);
});

test("log is newest first", () => {
  const rows = [rs(IRV, 26, 8, 0, 10), rs(SCP, 27, 9, 0, null, [E, H])];
  rows[1].parts[E].out = "2026-10-27T17:00:00.000Z";
  const { log } = summarize(rec(rows));
  assert.equal(log[0].store, SCP);
  assert.equal(log[0].lasted, "still in stock");
  assert.equal(log[0].open, true);
  assert.equal(log[0].minutes, null);
  assert.equal(log[0].models, "256GB Star White, 512GB Night Sky");
  assert.equal(log[1].when, "Mon Oct 26, 8:00 AM");
  assert.equal(log[1].lasted, "lasted ~10 min");
  assert.equal(log[1].minutes, 10);
});

test("duration across the DST change is real time", () => {
  const r = rec([{ store: IRV, parts: { [E]: { in: "2026-11-01T08:50:00Z", out: "2026-11-01T09:10:00Z" } } }]);
  assert.equal(summarize(r).log[0].minutes, 20);
});

test("out before in clamps to zero", () => {
  const r = rec([
    { store: IRV, parts: { [E]: { in: "2026-10-27T14:00:00Z", out: "2026-10-27T13:57:00Z" } } },
  ]);
  const [entry] = summarize(r).log;
  assert.equal(entry.minutes, 0);
  assert.equal(entry.lasted, "lasted ~1 min");
});

test("log and basis follow start time, not array order", () => {
  const r = rec([rs(IRV, 28, 8, 0, 10), rs(SCP, 27, 8, 0, 10)]);
  const s = summarize(r);
  assert.equal(s.log[0].when, "Wed Oct 28, 8:00 AM");
  assert.equal(s.log[1].when, "Tue Oct 27, 8:00 AM");
  assert.equal(s.basis, "Based on 2 restocks seen since Oct 27.");
});

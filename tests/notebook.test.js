const test = require("node:test");
const assert = require("node:assert/strict");
const { emptyRecord } = require("../record");
const notebook = require("../notebook");
const { fakeGitHub, installFetch } = require("./fakes");

const NOW = "2026-10-26T18:00:00.000Z";
const TOKEN = "ghp_faketoken_for_tests";
let gh;
let api;

test.beforeEach(() => {
  gh = fakeGitHub({});
  installFetch({ github: gh });
  api = { repo: "giuseppi/duo-stock", token: TOKEN, branch: "main" };
});

const withRestock = (record, id) => ({
  ...record,
  restocks: [...record.restocks, { id }],
});

test("read of a missing file gives an empty record", async () => {
  const { record, sha } = await notebook.readRecord(api, NOW);
  assert.equal(sha, null);
  assert.equal(record.restocks.length, 0);
});

test("write then read round-trips", async () => {
  const record = withRestock(emptyRecord(), "a");
  const sha = await notebook.writeRecord(api, record, null, "first");
  assert.equal(gh.puts.length, 1);
  assert.equal("sha" in gh.puts[0], false);
  assert.equal(gh.puts[0].branch, "main");
  const back = await notebook.readRecord(api, NOW);
  assert.equal(back.sha, sha);
  assert.deepEqual(back.record, record);
});

test("update writes only when changed", async () => {
  const out = await notebook.update(api, (record) => ({ record, changed: false, note: 1 }), { nowIso: NOW });
  assert.equal(gh.puts.length, 0);
  assert.equal(out.result.note, 1);
});

test("update retries on a conflict with fresh data", async () => {
  gh.setFile(withRestock(emptyRecord(), "theirs"));
  gh.beforeNextPut(() => gh.setFile(withRestock(gh.file(), "other-checker")));
  let runs = 0;
  const seen = [];
  await notebook.update(api, (record) => {
    runs += 1;
    seen.push(record.restocks.map((r) => r.id));
    return { record: withRestock(record, "mine"), changed: true };
  }, { nowIso: NOW });
  assert.equal(runs, 2);
  assert.deepEqual(seen[1], ["theirs", "other-checker"]);
  assert.deepEqual(gh.file().restocks.map((r) => r.id), ["theirs", "other-checker", "mine"]);
});

test("update gives up after 5 conflicts with lastResult attached", async () => {
  gh.setFile(emptyRecord());
  const bump = () => { gh.setFile(withRestock(gh.file(), "x")); gh.beforeNextPut(bump); };
  gh.beforeNextPut(bump);
  let runs = 0;
  await assert.rejects(
    notebook.update(api, (record) => {
      runs += 1;
      return { record, changed: true, run: runs };
    }, { nowIso: NOW }),
    (err) => err.conflict === true && err.lastResult.run === 5
  );
  assert.equal(runs, 5);
});

test("invalid JSON on GitHub is never overwritten", async () => {
  gh.setRaw("{oops");
  await assert.rejects(
    notebook.update(api, (record) => ({ record, changed: true }), { nowIso: NOW }),
    /not valid JSON/
  );
  assert.equal(gh.puts.length, 0);
});

test("HTTP errors name the status, not the token", async () => {
  gh.failNext("GET", 500);
  await assert.rejects(notebook.readRecord(api, NOW), (err) => {
    assert.match(err.message, /GET .* answered HTTP 500/);
    assert.ok(!err.message.includes(TOKEN));
    return true;
  });
});

test("dispatchCheck posts to the check workflow", async () => {
  await notebook.dispatchCheck(api);
  assert.equal(gh.dispatches, 1);
});

test("apiFromGh parses ssh and https remotes", () => {
  const make = (remote) => (cmd) => (cmd === "gh" ? "tok123\n" : remote + "\n");
  for (const remote of [
    "git@github.com:giuseppi/duo-stock.git",
    "https://github.com/giuseppi/duo-stock.git",
    "https://github.com/giuseppi/duo-stock",
  ]) {
    assert.deepEqual(notebook.apiFromGh(make(remote)), { repo: "giuseppi/duo-stock", token: "tok123", branch: "main" });
  }
});

test("apiFromGh explains a missing login without the token", () => {
  assert.throws(() => notebook.apiFromGh(() => { throw new Error("boom"); }), /gh/);
});

test("apiFromEnv requires both variables", () => {
  assert.deepEqual(
    notebook.apiFromEnv({ GITHUB_REPOSITORY: "a/b", GITHUB_TOKEN: "t" }),
    { repo: "a/b", token: "t", branch: "main" }
  );
  assert.throws(() => notebook.apiFromEnv({ GITHUB_TOKEN: "t" }), /GITHUB_TOKEN and GITHUB_REPOSITORY must be set/);
  assert.throws(() => notebook.apiFromEnv({ GITHUB_REPOSITORY: "a/b" }), /must be set/);
});

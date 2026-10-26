// Shared setup for the check.js tests: a temp folder, fake Apple/GitHub/ntfy,
// an injected clock, and a secrets check after every run. Not a test file.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { main } = require("../check");
const { claimedKeys } = require("../record");
const { appleSays, fakeGitHub, installFetch, captureConsole } = require("./fakes");

const TOPIC = "fake-topic-for-tests-7q2x"; // the real one only lives in the repo secret
const TOKEN = "ghs_fake_token_for_tests";
const ENV = { GITHUB_TOKEN: TOKEN, GITHUB_REPOSITORY: "giuseppi/duo-stock" };
const BUY = "https://www.apple.com/shop/buy-iphone/iphone-duo/7.6-inch-display-";
const [W256, N256, W512, N512] = ["MK1E4LL/A", "MK1F4LL/A", "MK1G4LL/A", "MK1H4LL/A"];
const START = Date.parse("2026-10-26T18:00:00.000Z");

process.env.NTFY_TOPIC = TOPIC;

// Call inside a test file: sets up fresh fakes before every test and returns
// the context the tests use. ctx.run() is one check.js run.
function setup() {
  const ctx = {
    apple: appleSays(), // next Apple answer: a body, or an HTTP status number
    ntfyUp: true,
    clock: START,
    gh: null,
    pushes: null,
    advance: (minutes) => { ctx.clock += minutes * 60 * 1000; },
    run,
  };

  test.beforeEach(() => {
    process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "duo-test-")));
    ctx.apple = appleSays();
    ctx.ntfyUp = true;
    ctx.clock = START;
    ctx.gh = fakeGitHub({});
  });

  // Also asserts neither secret reaches the console, status.json or state.json.
  async function run() {
    const net = installFetch({ apple: () => ctx.apple, github: ctx.gh, ntfyUp: ctx.ntfyUp });
    ctx.pushes = net.pushes;
    const con = captureConsole();
    try {
      await main({ now: () => new Date(ctx.clock), env: ENV });
    } finally {
      con.restore();
      const statusText = fs.existsSync("status.json") ? fs.readFileSync("status.json", "utf8") : "";
      let stateText = "";
      try { stateText = JSON.stringify(ctx.gh.file()) || ""; } catch { /* raw invalid JSON on purpose */ }
      for (const text of [con.text(), statusText, stateText]) {
        for (const secret of [TOPIC, TOKEN]) assert.ok(!text.includes(secret), "secret leaked");
      }
      ctx.logs = con.text();
    }
    return {
      record: ctx.gh.file(),
      status: JSON.parse(fs.readFileSync("status.json", "utf8")),
      logs: ctx.logs,
    };
  }
  return ctx;
}

const cell = (status, store, part) => status.stores.find((s) => s.name === store).parts[part];
const openKeys = (record) => [...claimedKeys(record)].sort();

module.exports = { setup, cell, openKeys, TOPIC, TOKEN, ENV, BUY, W256, N256, W512, N512, appleSays };

#!/usr/bin/env node
// One stock check for the iPhone Duo models and stores in duo.js. Meant for
// GitHub Actions: runs once, sends an ntfy push for anything that just came
// into stock, writes status.json for the GitHub Pages page, and keeps
// state.json so you aren't pinged again every 5 minutes for the same thing.
// The workflow commits state.json only when it changes.

const fs = require("fs");
const { MODELS, toRows, fetchRows, notify, alertNew } = require("./duo");

const FAIL_ALERT_AT = 6; // one heads up after ~30 min of failures, not one every run

function readState() {
  try {
    const s = JSON.parse(fs.readFileSync("state.json", "utf8"));
    return { inStock: Array.isArray(s.inStock) ? s.inStock : [], failStreak: Number(s.failStreak) || 0 };
  } catch (e) {
    // no file is the normal first run; anything else is worth seeing in the log
    if (e.code !== "ENOENT") console.error(`state.json unreadable, starting fresh: ${e.message}`);
    return { inStock: [], failStreak: 0 };
  }
}

function save(state, status) {
  fs.writeFileSync("state.json", JSON.stringify(state, null, 2) + "\n");
  fs.writeFileSync("status.json", JSON.stringify(status, null, 2) + "\n");
}

async function main() {
  const state = readState();
  const status = { checkedAt: new Date().toISOString(), ok: true, models: MODELS };

  let rows;
  try {
    rows = await fetchRows();
  } catch (e) {
    // Exit 0 on purpose: a red run every 5 min would mean a GitHub email
    // every 5 min. The page shows the error and the push below tells you.
    console.log(`::error title=Apple check failed::${e.message}`);
    let streak = state.failStreak + 1;
    if (streak === FAIL_ALERT_AT) {
      const told = await notify(
        "Duo checker is failing",
        `${FAIL_ALERT_AT} checks in a row failed: ${e.message}. Alerts won't work until this clears.`,
        { priority: "default" }
      );
      if (!told) streak = FAIL_ALERT_AT - 1; // try again on the next failed run
    }
    // Stop counting once you've been told, so a long outage doesn't change
    // state.json (and make a commit) on every run.
    state.failStreak = Math.min(streak, FAIL_ALERT_AT);
    save(state, { ...status, ok: false, error: e.message, failStreak: state.failStreak, stores: toRows([]) });
    return;
  }

  if (state.failStreak >= FAIL_ALERT_AT) {
    await notify("Duo checker is back", "Apple is answering again.", { priority: "default" });
  }
  state.failStreak = 0;
  state.inStock = await alertNew(rows, state.inStock);

  for (const r of rows) {
    const cells = MODELS.map((m) => {
      const c = r.parts[m.part];
      return `${m.name}: ${c ? (c.available ? "AVAILABLE" : "no") : "?"}`;
    });
    console.log(`${r.name}${r.found ? "" : " (not in Apple's response)"}: ${cells.join(", ")}`);
  }
  save(state, { ...status, stores: rows });
}

if (require.main === module) {
  main().catch((e) => {
    console.error("check crashed:", e);
    process.exit(1);
  });
}

module.exports = { main, FAIL_ALERT_AT };

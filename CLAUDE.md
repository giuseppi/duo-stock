# duo-stock

Personal iPhone Duo pickup-stock alert bot. Setup and layout: README.md. Models and stores: duo.js.

- Public repo. The ntfy topic comes only from the `NTFY_TOPIC` secret / env var. Never hardcode or log it; `node --test` fails if it reaches logs or the JSON files.
- No npm dependencies. Node built-ins only (fetch, node:test).
- Use `/shop/retail/pickup-message`. `/shop/fulfillment-messages` returns HTTP 541 for everyone.
- Only `state.json` is committed by the bot, and only on change. `status.json` is published straight to Pages (source: GitHub Actions).
- Both checkers (check.js, duo-watch.js) share `state.json` through the GitHub contents API, writing with compare-and-swap on the file SHA (`notebook.js`). A restock is claimed in the record before its push.
- `record.js` and `history.js` are pure and hold the rules. A restock that ends and returns within 10 minutes is one restock (`FLAP_MS` in `record.js`).
- Workflow actions are pinned to commit SHAs; bump the SHA and the tag comment together.

## Issue Log

- **Bot committed on every run.** Found 2026-10-26. Resolved 2026-10-26. status.json held a per-run timestamp, so every run committed (~288/day), past the Pages branch-build soft limit of 10/hour, and bot pushes made with `GITHUB_TOKEN` may not trigger branch builds at all. Resolution: publish Pages from the workflow; commit only state.json, only when it changes; stop counting failures after the alert so a long outage stops committing. If Apple blocks only some runner IPs, failStreak flips 0/1 and still commits each flip.
- **Does Apple block GitHub Actions IPs?** Found 2026-10-26. Resolved 2026-10-26. Resolution: no; the first two Actions runs got full answers for all 7 stores. If that changes, the page shows the error and one push goes out after 6 failed checks.
- **Double pings between laptop and GitHub.** Found 2026-10-26. Resolved 2026-10-26. The laptop and Actions each kept their own memory, so both pinged for one restock. Resolution: one shared record in state.json; each restock is claimed there before its push.
- **GitHub's schedule stopped firing.** Found 2026-10-26. Resolved 2026-10-26. The `*/5` cron ran once in over 2 hours with no GitHub incident, so with the laptop off nothing checked and the page went stale. Resolution: a cron-job.org job calls workflow_dispatch every 5 min with a fine-grained token (this repo, Actions read and write only; README Setup step 6). GitHub's cron stays as a backup. The token expires; renew it.
- **Unknown state.json format could wipe the history.** Found 2026-10-26. Resolved 2026-10-26. `migrate` treated anything not exactly v2 as v1, so a hand edit or a future version became an empty record that the next write saved over the history. Resolution: `migrate` in `record.js` accepts only v1 or well-formed v2 and otherwise throws, so the file is left alone and the run fails visibly.

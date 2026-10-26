# duo-stock

Personal iPhone Duo pickup-stock alert bot. Setup and layout: README.md. Models and stores: duo.js.

- Public repo. The ntfy topic comes only from the `NTFY_TOPIC` secret / env var. Never hardcode or log it; `node --test` fails if it reaches logs or the JSON files.
- No npm dependencies. Node built-ins only (fetch, node:test).
- Use `/shop/retail/pickup-message`. `/shop/fulfillment-messages` returns HTTP 541 for everyone.
- Only `state.json` is committed by the bot, and only on change. `status.json` is published straight to Pages (source: GitHub Actions).
- Workflow actions are pinned to commit SHAs; bump the SHA and the tag comment together.

## Issue Log

- **Bot committed on every run.** Found 2026-10-26. Resolved 2026-10-26. status.json held a per-run timestamp, so every run committed (~288/day), past the Pages branch-build soft limit of 10/hour, and bot pushes made with `GITHUB_TOKEN` may not trigger branch builds at all. Resolution: publish Pages from the workflow; commit only state.json, only when it changes; stop counting failures after the alert so a long outage stops committing. If Apple blocks only some runner IPs, failStreak flips 0/1 and still commits each flip.
- **Does Apple block GitHub Actions IPs?** Found 2026-10-26. Resolved 2026-10-26. Resolution: no; the first two Actions runs got full answers for all 7 stores. If that changes, the page shows the error and one push goes out after 6 failed checks.

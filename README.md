# duo-stock

Watches Apple in-store pickup stock for the iPhone Duo 256GB and 512GB in Star
White and Night Sky (MK1E4LL/A, MK1F4LL/A, MK1G4LL/A, MK1H4LL/A) at Irvine
Spectrum, South Coast Plaza, Mission Viejo, Fashion Island, Brea Mall, Los
Cerritos and Victoria Gardens. Pushes to ntfy when one comes in stock, and
publishes a status grid to GitHub Pages.

Models and stores live in `duo.js`.

## Setup

1. Make an empty **public** GitHub repo (Actions minutes are free for public
   repos).
2. Settings > Pages > Source: **GitHub Actions**. The workflow publishes the
   page itself on every run. Do this before pushing, or the first scheduled
   runs fail at the deploy step.
3. Settings > Secrets and variables > Actions > New repository secret:
   `NTFY_TOPIC` = your ntfy topic. Anyone who knows a topic can read and send
   to it, so use a long random one, and keep it out of the code and logs.
4. Push these files.
5. Actions tab > "Check iPhone Duo stock" > Run workflow, to test it right
   away instead of waiting for the schedule.

Both GitHub Actions and your laptop (if you run it) share one record,
`state.json` on GitHub. They read and write it through the GitHub API, and only
write when something changes. A new restock is claimed in the record before its
push goes out, so only one of them pings. `status.json` is rebuilt every run and
published straight to Pages.

The page has two tabs. Now shows the current stock grid. History lists past
restocks. Apple's answer has no quantity, so History counts restocks, not
phones. A restock that ends and comes back within 10 minutes counts as one.

GitHub turns off scheduled workflows in public repos after 60 days with no
repository activity. If the page says the checker looks stalled, check the
Actions tab and re-enable it.

## Local

- `node --test` runs the tests (mocked Apple and ntfy, no network). They live
  in `tests/`.
- `node check.js` is meant for Actions. It needs `GITHUB_TOKEN` and
  `GITHUB_REPOSITORY`, and it writes `state.json` to GitHub.
- `NTFY_TOPIC=your-topic node duo-watch.js` loops on your laptop. It gets the
  repo and token from the `gh` CLI, so run `gh auth login` first with write
  access to the repo. Without `gh`, or logged out, it prints a warning and
  pings on its own, so GitHub may ping again for the same restock. If GitHub is
  unreachable mid-run, it pings from its own memory and hands over what is still
  in stock when GitHub is back. A restock that came and went in that gap is not
  added to History. After each write it asks GitHub to run the workflow, so the
  page updates soon after.
- `INTERVAL_SEC` sets the seconds between laptop checks (default 120). Use 60
  or more, so Apple is less likely to block your laptop. GitHub's own schedule
  cannot go below 5 minutes.
- `DUO_EXTRA_HEADERS` (JSON) adds request headers to Apple calls. `--no-test`
  skips the test push on startup.

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

Only `state.json` is committed by the bot, and only when stock or the
failure streak changes. `status.json` is rebuilt every run and published
straight to Pages.

GitHub turns off scheduled workflows in public repos after 60 days with no
repository activity. If the page says the checker looks stalled, check the
Actions tab and re-enable it.

## Local

- `node --test` runs the tests (mocked Apple and ntfy, no network).
- `node check.js` runs one real check. It overwrites `state.json`, which the
  bot owns, so run `git checkout state.json` afterwards instead of committing it.
- `NTFY_TOPIC=your-topic node duo-watch.js` loops every ~2 min on your laptop.
  It keeps its own memory of what it already pushed, so while both run you
  can get the same alert from each.

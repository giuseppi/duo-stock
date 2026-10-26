# Shared notebook and restock history: design

Date: 2026-10-26. Status: draft for approval.

## Why

The owner wants to get an iPhone Duo by ordering it for in-store pickup the moment it shows up, or by lining up before a store opens if stock is that scarce. Two things get in the way today:

1. The GitHub checker runs every 5 to 15 minutes (GitHub's floor is 5). The laptop script checks every ~1-2 minutes but only while the laptop is open. The two keep separate memories, so when both run the owner can get the same ping twice, and a restock that sells out between two GitHub checks is never recorded even if the laptop saw it.
2. There is no record of past restocks, so there is nothing to base "which store, what time" on.

Success: one ping per restock no matter which checker saw it first, and a History tab on the page that tells the owner which store to watch and at what time of day, backed by every restock either checker saw.

## Goals

- GitHub keeps checking on its schedule all the time. The laptop script is an optional faster checker on top. Both share one record.
- No double pings: a given restock of a given model at a given store produces exactly one ping, whichever checker sees it first.
- No missed restocks in the history: anything either checker saw is recorded. One accepted exception, below: a restock the laptop saw start and end while it couldn't reach GitHub.
- A History tab with three parts, top to bottom (layout chosen from mockups):
  1. **Recommendation** ("Best bet: Irvine Spectrum, 6 to 9 AM"), with a line like "4 of its 5 restocks showed up before it opens at 10 AM, and they usually last about 20 min", and a small "Based on N restocks seen since <date>" note.
  2. **Time-of-day grid**: stores down the side, five time windows across (12-6a, 6-9a, 9a-12, 12-5p, 5p-12), the number of restocks in each cell, shaded darker for more, plus a total per store. Stores with the most restocks on top.
  3. **Restock log**: every restock, newest first: store, day and time it showed up, which models, how long it lasted, and a bar whose length shows how long it lasted.
- The existing Now tab (current grid, last check time, failure and stalled banners) stays as it is.

## Non-goals

- Unit counts. Apple's pickup response has no quantity field (checked against a real response); "how many" means number of restocks, never number of phones.
- History from before the bot started. Apple publishes no restock history; the log starts at the first sighting after this ships.
- Faster GitHub checks. The 5-minute floor and GitHub's terms for Actions rule out looping jobs.
- New models, sizes or stores beyond the existing 4 models and 7 stores.
- Any npm dependency.

## Anti-goals (would count as failure even if it works)

- Two pings for the same restock because both checkers saw it.
- The ntfy topic or any GitHub token appearing in code, logs, the repo or the page.
- A commit on every run again. Writes happen only when something actually changes.
- A recommendation that sounds confident on almost no data.

## Constraints

- Public repo; Node 20 built-ins only (fetch, node:test, child_process); GitHub Pages page reads only files the workflow publishes (it cannot call apple.com).
- The workflow stays least-privilege with actions pinned to commit SHAs (see the existing check.yml).
- Files stay under ~300 lines; split modules rather than grow duo.js past that.
- Existing behavior that stays: per store+model alerts, push title "<model> at <stores>", Click opens that model's buy page, one push per model per check, "checker is failing" after 6 failed GitHub checks and "back" on recovery, 541/403 reported as blocked, other stores ignored, unknown (missing) cells keep what was known.

## Decided by the owner

- Connect the two checkers so there are no double pings and no missed restocks.
- The shared record lives in the repo. The laptop updates it using the owner's existing GitHub login on the laptop (`gh`), which is only ever sent to GitHub. A stricter repo-only key is a possible later change, not part of this.
- **Claim before ping**: whoever sees a new restock first records it as claimed in the shared record before pinging. If both try at the same moment, only one write is accepted; the other sees the claim and stays quiet. If the ping then fails to send, the claim is undone so the next check retries.
- When the laptop records a change, it also triggers a GitHub check right away so the page updates in about a minute.
- If the laptop can't reach GitHub, it pings anyway from its own memory (a double ping beats a missed restock).
- When GitHub is reachable again, the laptop hands over whatever it pinged that is still in stock, with the time it first saw it, as claims and restock entries, so GitHub doesn't ping again. Restocks that started and ended entirely while GitHub was unreachable are not backfilled into the history; that gap is accepted. The laptop's offline memory can be in-memory only (lost if the script restarts during the outage).
- The laptop's updates show in the repo history under the owner's name; accepted.
- History tab layout: the three parts above, in that order.

## How it works (decided in design; the builder may refine details, not behavior)

**One shared record.** `state.json` in the repo holds what is currently claimed (in stock and already pinged), the GitHub checker's failure streak, and the restock history. Both checkers read it at the start of every check.

**Safe concurrent writes.** Both checkers write it through GitHub's contents API with the file's current SHA (compare-and-swap). A write based on an out-of-date read is rejected; the writer re-reads, re-applies its observation to the fresh record, and tries again (a few retries). This replaces the workflow's git commit/push step: the GitHub checker also writes through the API using the workflow's `GITHUB_TOKEN`. A check that changes nothing writes nothing.

**Order of operations per check:** fetch Apple, read the record, work out what changed, write the record (claims included), then send pings for the claims that write made, then undo any claim whose ping failed.

**What a restock is.** A restock starts when a watched store goes from none of the 4 models in stock to at least one. Models that come in at that store while it still has stock join the same restock. It ends when all its models are gone. "Lasted" is from first seen in to first seen out, so it is only as precise as the checks (about a minute with the laptop open, 5-15 minutes without).

**Flapping.** (My call.) If a model sells out and comes back at the same store within 10 minutes, treat it as the same restock continuing: no new ping and no new log entry. This keeps a flickering Apple answer, or two checkers seeing slightly different moments, from causing repeat pings. A different model joining an open restock still pings for that model.

**Failure streak.** Only the GitHub checker counts failures and sends "failing"/"back". The laptop keeps its own blocked backoff and its "watcher is blocked" alert as today.

**Page.** The GitHub checker writes the history summary into the files it publishes each run. The recommendation, grid and log numbers are computed in Node (testable), not in the browser.

## Recommendation rules (my calls)

- Shown only when the top store has at least 3 restocks and strictly more than any other store. Otherwise the spot says it is still learning and shows how many restocks it has seen so far (or "no clear favorite yet" when the top two are tied). This keeps a store with a single restock from being crowned.
- Best store: most restocks. Time window: that store's window with the most restocks (ties go to the earlier window).
- "Before it opens": a restock counts if it first showed up before that store's opening time on that day of the week (Pacific). If hours can't be read for that day, leave the before-opening part out rather than guess. If the store opens at different times on different days, say "before it opens" without a time.

**Where store hours come from** (verified against a real response on 2026-10-26). Each entry in `body.stores[]` has `retailStore.storeHours`, an array of `{storeDays, voStoreDays, storeTimings}`, and `retailStore.timezone` (`America/Los_Angeles` for all 7). Real values for the 7 stores:

| Store | `storeDays`: `storeTimings` |
|---|---|
| Irvine Spectrum Center | Fri-Sat: 10:00 AM-10:00 PM; Mon-Thu, Sun: 10:00 AM-9:00 PM |
| South Coast Plaza | Sun: 11:00 AM-7:00 PM; Mon-Thu: 10:00 AM-8:00 PM; Fri-Sat: 10:00 AM-9:00 PM |
| Mission Viejo | Sun: 11:00 AM-7:00 PM; Mon-Sat: 10:00 AM-8:00 PM |
| Fashion Island | Mon-Sat: 10:00 AM-8:00 PM; Sun: 11:00 AM-6:00 PM |
| Brea Mall | Sun: 11:00 AM-7:00 PM; Mon-Thu: 10:00 AM-8:00 PM; Fri-Sat: 10:00 AM-9:00 PM |
| Los Cerritos | Sun: 11:00 AM-7:00 PM; Mon-Sat: 10:00 AM-9:00 PM |
| Victoria Gardens | Sun: 11:00 AM-7:00 PM; Mon-Thu: 10:00 AM-8:00 PM; Fri-Sat: 10:00 AM-9:00 PM |

`storeDays` uses three-letter day names, ranges with `-`, and lists with `, `. There is also `storeHours.hours[]` on each store with the same data and a trailing colon on `storeDays` ("Fri-Sat:"); use `retailStore.storeHours`. No holiday or special-hours example has been seen yet, so anything that doesn't match this format must be skipped, not guessed. Use the latest response's hours for all past restocks.
- "Usually lasts": the median duration of that store's finished restocks; left out if none have finished.
- All times shown in Pacific time regardless of the viewer's time zone.

## Left to the builder

- Exact shape of the data in `state.json` (it must migrate the current `{inStock, failStreak}` file without re-pinging what is already claimed).
- How the laptop finds the repo and gets its token (`gh auth token` is expected), and how it behaves if `gh` is missing or logged out (fall back to local memory with a clear warning).
- How many retries on write conflicts, and how a write that keeps failing is reported (the laptop falls back to pinging; the GitHub checker should make its run visibly fail).
- Tab switching (a URL hash like `#history` is fine), the empty History state, how many log entries to show before collapsing the rest, and the duration bar scale.
- Chart styling, following the dataviz guidance: one blue sequential scale for the grid, numbers always visible in cells, separate dark-mode steps, checked at phone width.
- Tests (node:test, mocked fetch for Apple, ntfy and the GitHub API) covering at least: two checkers racing on the same restock (one ping), a failed ping undoing its claim, laptop fallback when GitHub is unreachable, restock grouping and the 10-minute flap rule, durations, recommendation thresholds and ties, store-hour parsing, Pacific-time buckets across a daylight-saving change, and that no token or topic reaches logs or files.

# Shared Notebook and Restock History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the GitHub checker and the laptop script share one record in the repo (no double pings, no missed restocks) and add a History tab built from that record.

**Architecture:** `state.json` in the repo becomes a shared record that both checkers read and write through GitHub's contents API with compare-and-swap on the file SHA. Pure logic (`record.js`, `history.js`) decides claims and summaries; `notebook.js` does the GitHub I/O; `check.js` and `duo-watch.js` orchestrate. The page renders a Node-computed summary from `status.json`.

**Tech Stack:** Node 20 built-ins only (fetch, node:test, node:assert, child_process), static HTML/CSS/JS, GitHub Actions + Pages.

**Spec:** `project-docs/2026-10-26-restock-history-design.md` (read it before any task).

## Global Constraints

- No npm dependencies. Code must run on Node 20 (CI) and Node 24 (laptop).
- Public repo: the ntfy topic (`NTFY_TOPIC`) and any GitHub token (`GITHUB_TOKEN`, `gh auth token`) must never appear in code, logs, error messages, `state.json`, `status.json` or the page.
- No file over 300 lines, no function over 50 lines. Match the existing style: CommonJS, 2-space indent, double quotes, sparse comments that explain why.
- Never use the em dash character in code, copy or commit messages; use "-".
- Commit messages: plain imperative sentence, no prefixes like "feat:", no AI attribution or co-author lines.
- Times shown to the user are Pacific (`America/Los_Angeles`). Durations are computed from UTC milliseconds.
- Kept behavior: per store+model claims; push title `<model name> at <store, store>`; Click opens that model's buy page; one push per model per check; "Duo checker is failing" after 6 failed GitHub checks, "Duo checker is back" on recovery, both priority `default`; 541/403 reported as "Apple blocked the request (HTTP n)"; other stores ignored; unknown (null) cells keep what was known.
- `FLAP_MS = 10 * 60 * 1000`. Best bet needs the top store to have at least 3 restocks and strictly more than every other store.
- Tests run with `node --test` from the repo root. All test files live in `tests/` and are named `*.test.js`; shared fakes live in `tests/fakes.js`.

## Review Focus

1. Apple sends store hours in a format nobody has seen (holiday text like `{storeDays: "Nov 27", storeTimings: "Closed"}`): parsing must skip it, the summary must still render, and the before-opening line must be left out. Test in Task 2.
2. `state.json` on GitHub is hand-edited into invalid JSON: nothing may overwrite it. The GitHub checker fails visibly; the laptop falls back to local memory. Tests in Task 3 and Task 5.
3. The laptop's GitHub login is expired or rate-limited (401/403): the laptop keeps pinging from local memory and prints a warning naming the HTTP status, never the token. Test in Task 5.
4. A restock spans the daylight-saving change (2026-11-01) or midnight: its duration is real elapsed time, and its window comes from its Pacific start time. Test in Task 2.
5. The laptop clock is a few minutes behind GitHub's, so a restock's out time comes before its in time: the duration clamps to 0 and displays as "1 min", never negative. Test in Task 2.

## File Structure

| File | Responsibility |
|---|---|
| `duo.js` (modify) | Config, Apple fetch, ntfy. `toRows` gains store hours; `alertNew` is replaced by `pushClaims`. |
| `record.js` (create) | Pure rules for the shared record: migrate, claim, close, flap, undo. |
| `history.js` (create) | Pure summary for the page: Pacific time, store hours, recommendation, grid, log, exact copy. |
| `notebook.js` (create) | GitHub contents API read/write with SHA compare-and-swap, retry loop, workflow dispatch, token lookup. |
| `check.js` (rewrite) | One GitHub Actions check using the above; writes `status.json`. |
| `duo-watch.js` (modify) | Laptop loop using the shared record, local fallback, handover, dispatch. |
| `index.html` (modify) | Now and History tabs; History renders `status.history`. |
| `.github/workflows/check.yml` (modify) | Drop the git save step; give the check step `GITHUB_TOKEN`. |
| `tests/*.test.js`, `tests/fakes.js` (create) | Replace root `check.test.js`. |

## Shared record shape (`state.json`, version 2)

```json
{
  "version": 2,
  "failStreak": 0,
  "hours": { "Irvine Spectrum": [{ "storeDays": "Fri-Sat", "storeTimings": "10:00 AM-10:00 PM" }] },
  "restocks": [
    { "store": "Irvine Spectrum",
      "parts": { "MK1H4LL/A": { "in": "2026-10-27T14:12:00.000Z", "out": null } } }
  ]
}
```

A restock's start is the earliest `in`; its end is `null` while any part has `out: null`, otherwise the latest `out`. `restocks` is in chronological order; a store's latest restock is the last one with that store. A key is `"<store>|<part>"` using the short store names from `STORES`.

---

### Task 1: Record rules (`record.js`) and store hours in rows

**Files:**
- Create: `record.js`, `tests/record.test.js`
- Modify: `duo.js` (`toRows` only)

**Interfaces:**
- Consumes: `STORES`, `MODELS`, `toRows` from `duo.js`.
- Produces (all exported from `record.js`):
  - `FLAP_MS: number`
  - `emptyRecord(): Record` -> `{ version: 2, failStreak: 0, hours: {}, restocks: [] }`
  - `migrate(raw: object, nowIso: string): Record` - v1 `{inStock: string[], failStreak}` becomes v2 with each key as an open part (`in: nowIso`), grouped one restock per store; v2 gets missing fields filled; anything that is not a plain object throws `Error("state.json has an unknown format")`.
  - `restockStart(r): string`, `restockEnd(r): string | null`
  - `claimedKeys(record): Set<string>` - keys whose part has `out: null` in that store's latest restock.
  - `applyRows(record, rows, nowIso, { pinged }?: { pinged?: Map<string, string> }): { record, claims: Array<{store, part, prevOut: string | null}>, changed: boolean }` - never mutates its input. `pinged` maps keys the laptop already pinged offline to their first-seen ISO time: those keys are recorded (with that time as `in`) but produce no claim.
  - `unclaim(record, claims): { record, changed }` - `prevOut: null` deletes that part (and the restock if it has no parts left); otherwise restores `out = prevOut`.
- `duo.js` `toRows` rows gain `hours: Array<{storeDays, storeTimings}> | null` taken from Apple's `retailStore.storeHours` (keep only those two fields).

**applyRows rules** (for each found row; skip null cells):
- Hours: if `row.hours` is non-null and differs from `record.hours[row.name]`, store it (counts as a change).
- Available part, store's latest restock is open or ended within `FLAP_MS` of now:
  - part present with `out: null`: nothing.
  - part present with `out` set: set `out: null`; emit a claim with `prevOut` only if `now - out > FLAP_MS` (otherwise it is a flap: no claim).
  - part absent: add `{in: now, out: null}`, claim with `prevOut: null`.
- Available part, no such restock: append a new restock for the store; later parts in the same call join it. Claim each.
- Unavailable part present in an open latest restock with `out: null`: set `out: now`.

- [ ] **Step 1: Write failing tests in `tests/record.test.js`** with `const T0 = "2026-10-27T14:00:00.000Z"` and helper `at(min)` = T0 plus `min` minutes, and rows built as `{ name, city, miles, found: true, hours: null, parts: { [part]: { available, quote: "" } | null } }` for the 4 parts. Tests and their key assertions:
  - `new stock opens a restock and claims it`: Irvine Spectrum MK1H4LL/A available -> `claims` deep-equals `[{store: "Irvine Spectrum", part: "MK1H4LL/A", prevOut: null}]`, one restock, `changed === true`.
  - `same stock again changes nothing`: applying the same rows to the result -> `claims.length === 0`, `changed === false`.
  - `two models at one store are one restock`: MK1E4LL/A and MK1H4LL/A together -> 2 claims, `restocks.length === 1`.
  - `a model joining an open restock is claimed`: E at `at(0)`, then E+H at `at(5)` -> one claim for H, still one restock.
  - `sold out closes the part and ends the restock`: H at `at(0)`, none at `at(25)` -> `restockEnd === at(25)`, `claimedKeys` empty.
  - `back within 10 minutes is a flap`: in `at(0)`, out `at(20)`, in `at(29)` -> no claim, one restock, `restockEnd === null`.
  - `back after more than 10 minutes is a new restock`: in `at(0)`, out `at(20)`, in `at(31)` -> one claim, two restocks.
  - `a model returning after 10+ minutes inside an open restock is claimed again`: E+H in at `at(0)`, H out at `at(5)`, H in at `at(20)` while E stays -> claim `{part: "MK1H4LL/A", prevOut: at(5)}`.
  - `unknown cells keep what was known`: H in, then H cell `null` -> no change, key still claimed; row with `found: false` likewise.
  - `pinged keys are recorded without a claim`: `pinged = new Map([["Brea Mall|MK1E4LL/A", at(-7)]])`, Brea E available -> `claims.length === 0`, part `in === at(-7)`.
  - `unclaim removes a new part and an empty restock`: undo the first test's claim -> `restocks.length === 0`.
  - `unclaim restores a returning part`: undo the `prevOut: at(5)` claim -> that part's `out === at(5)`.
  - `hours are stored once and only change when Apple's do`.
  - `applyRows does not mutate its input` (deep-equal a `structuredClone` taken before).
  - `migrate turns v1 inStock into open claims`: `{inStock: ["Irvine Spectrum|MK1H4LL/A"], failStreak: 2}` -> `claimedKeys` has that key, `failStreak === 2`, `version === 2`; applying rows with H still available yields no claim.
  - `migrate rejects non-objects`: `null`, `[]`, `"x"` throw `/unknown format/`.
  - In `duo.js` terms: `toRows([apiStoreWithHours])[0].hours` deep-equals `[{storeDays: "Fri-Sat", storeTimings: "10:00 AM-10:00 PM"}, ...]` and is `null` for a missing store.
- [ ] **Step 2: Run** `node --test tests/record.test.js` - expect failures (module not found).
- [ ] **Step 3: Implement `record.js`** and the `toRows` change. Clone with `structuredClone` before mutating.
- [ ] **Step 4: Run** `node --test` - expect all tests to pass, including the existing root `check.test.js`.
- [ ] **Step 5: Commit** `git add record.js duo.js tests/record.test.js && git commit -m "Add shared record rules for claims, flaps and restocks"`

### Task 2: History summary (`history.js`)

**Files:**
- Create: `history.js`, `tests/history.test.js`

**Interfaces:**
- Consumes: `restockStart`, `restockEnd` from `record.js`; `STORES`, `MODELS` from `duo.js`.
- Produces (exported from `history.js`):
  - `WINDOWS = ["12-6a", "6-9a", "9a-12", "12-5p", "5p-12"]` (window starts at 0, 360, 540, 720, 1020 minutes after Pacific midnight).
  - `pacific(iso): { weekday: 0-6 (0 = Sunday), minutes: 0-1439, day: "Oct 27", label: "Tue Oct 27, 7:12 AM" }` - build from `Intl.DateTimeFormat(...).formatToParts` with `timeZone: "America/Los_Angeles"`; join hour, minute and day period with a plain space (Node's ICU may emit U+202F otherwise).
  - `parseHours(storeHours): Array<number | null>` of length 7, the opening minute for each weekday. Days look like `"Mon-Thu, Sun"` (three-letter names, `-` ranges that may wrap, `, ` lists); timings like `"10:00 AM-9:00 PM"`. Entries that don't match are skipped; never throws.
  - `formatDuration(minutes): string` -> under 60: `"<n> min"` with n = max(1, round); otherwise hours rounded to the nearest half: `"1 hr"`, `"1.5 hr"`, `"2 hr"`.
  - `summarize(record): { count, basis, best, learning, grid, log }`:
    - `basis`: `"Based on 14 restocks seen since Oct 26."` (singular "restock" when 1); `null` when count is 0.
    - `grid`: one row per store in `STORES`, `{ store, counts: number[5], total }`, by restock start window, sorted by total descending then `STORES` order.
    - `best`: `null` unless the top total >= 3 and strictly greater than the second. Otherwise `{ title, detail }`:
      - `title`: `"Best bet: <store>, <phrase>"` with phrases `["midnight to 6 AM", "6 to 9 AM", "9 AM to noon", "noon to 5 PM", "5 PM to midnight"]` for that store's busiest window (ties: earlier window).
      - before-opening part: only if `record.hours[store]` gives an opening time for the weekday of every one of that store's restocks, and at least one started before it: `"<n> of its <total> restocks showed up before it opens"` plus `" at 10 AM"` when every one of those weekdays opens at the same time (format `"10 AM"`, or `"10:30 AM"` when minutes are not 0).
      - usual part: median minutes of that store's finished restocks (even count: mean of the middle two).
      - `detail`: both -> `"<before>, and they usually last about <d>."`; before only -> `"<before>."`; usual only -> `"Its restocks usually last about <d>."`; neither -> `""`.
    - `learning` (only when `best` is null): count 0 -> `"No restocks seen yet. This fills in as the checker spots them."`; top total < 3 -> `"Still learning: <n> restock(s) seen so far."`; otherwise (a tie) -> `"No clear favorite yet: <A> and <B> have <n> restocks each."`
    - `log`: every restock, newest start first: `{ store, when: pacific(start).label, models: names in MODELS order joined ", ", open, minutes, lasted }` with `lasted` = `"still in stock"` when open, else `"lasted ~<formatDuration>"`; `minutes` is null when open. Durations clamp at 0.

- [ ] **Step 1: Write failing tests in `tests/history.test.js`**:
  - `pacific uses Pacific time across the DST change`: `pacific("2026-11-01T08:30:00Z").minutes === 90` (1:30 AM PDT) and `pacific("2026-11-01T09:30:00Z").minutes === 90` (1:30 AM PST); `pacific("2026-10-27T14:12:00Z").label === "Tue Oct 27, 7:12 AM"`, `weekday === 2`.
  - `parseHours reads all seven real stores`: each row of the store-hours table in the spec. For example Irvine -> all seven days `600`; South Coast Plaza -> Sunday `660`, Monday `600`; Fashion Island -> Sunday `660`.
  - `parseHours skips unknown formats`: `[{storeDays: "Nov 27", storeTimings: "Closed"}]` -> seven nulls; `null` input -> seven nulls.
  - `formatDuration`: `0 -> "1 min"`, `25 -> "25 min"`, `60 -> "1 hr"`, `95 -> "1.5 hr"`, `120 -> "2 hr"`.
  - `no restocks`: `learning` is the exact count-0 copy, `basis === null`, grid has 7 rows of zeros.
  - `still learning below 3`: 2 restocks -> `"Still learning: 2 restocks seen so far."`; 1 -> `"... 1 restock seen so far."`
  - `tie at the top`: Irvine 3, South Coast Plaza 3 -> `"No clear favorite yet: Irvine Spectrum and South Coast Plaza have 3 restocks each."`
  - `best bet with before-opening and usual duration`: Irvine with 5 finished restocks on Mon-Fri of the week of 2026-10-26, 4 starting between 7:00 and 8:30 AM Pacific and 1 at 10:15 AM, durations 10, 20, 25, 30, 40 min, Irvine hours from the spec -> `title === "Best bet: Irvine Spectrum, 6 to 9 AM"`, `detail === "4 of its 5 restocks showed up before it opens at 10 AM, and they usually last about 25 min."`
  - `mixed opening times drop the time`: South Coast Plaza (spec hours) with 3 finished 20-minute restocks at 8:00 AM on Sun 2026-10-25, Mon 2026-10-26 and Tue 2026-10-27 -> `detail === "3 of its 3 restocks showed up before it opens, and they usually last about 20 min."`
  - `unknown hours drop the before-opening part`: best store with no `record.hours` entry and finished restocks -> `detail` starts with `"Its restocks usually last about"`.
  - `grid counts by window and sorts`: Irvine first with `counts` `[0, 4, 1, 0, 0]`, `total === 5`; Los Cerritos last with zeros.
  - `log is newest first`: first entry is the latest; an open restock has `lasted === "still in stock"`; a restock E+H shows `models === "256GB Star White, 512GB Night Sky"`.
  - `duration across the DST change is real time`: in `2026-11-01T08:50:00Z`, out `2026-11-01T09:10:00Z` -> `minutes === 20`.
  - `out before in clamps to zero`: out 3 minutes before in -> `minutes === 0`, `lasted === "lasted ~1 min"`.
- [ ] **Step 2: Run** `node --test tests/history.test.js` - expect failures.
- [ ] **Step 3: Implement `history.js`.**
- [ ] **Step 4: Run** `node --test` - all pass.
- [ ] **Step 5: Commit** `git add history.js tests/history.test.js && git commit -m "Add restock history summary with recommendation, grid and log"`

### Task 3: GitHub notebook I/O (`notebook.js`) and shared test fakes

**Files:**
- Create: `notebook.js`, `tests/notebook.test.js`, `tests/fakes.js`

**Interfaces:**
- Consumes: `emptyRecord`, `migrate` from `record.js`.
- Produces (`notebook.js`):
  - `apiFromEnv(env): { repo, token, branch: "main" }` from `GITHUB_REPOSITORY` and `GITHUB_TOKEN`; throws `Error("GITHUB_TOKEN and GITHUB_REPOSITORY must be set")`.
  - `apiFromGh(run = execFileSync): { repo, token, branch: "main" }` - token from `gh auth token`, repo from `git remote get-url origin` (accept `git@github.com:owner/repo.git` and `https://github.com/owner/repo(.git)`); throws a plain-English error without the token.
  - `readRecord(api, nowIso): { record, sha: string | null }` - `GET /repos/{repo}/contents/state.json?ref={branch}`; 404 -> `{ record: emptyRecord(), sha: null }`; content that is not valid JSON throws `Error("state.json on GitHub is not valid JSON, so it was left alone. Fix or delete it.")`.
  - `writeRecord(api, record, sha, message): string` - `PUT` with base64 of `JSON.stringify(record, null, 2) + "\n"`, `sha` (omitted when null), `branch`; returns the new content SHA; 409 or 422 throws an error with `conflict: true`.
  - `update(api, fn, { message = "Update stock state", tries = 5, nowIso }): Promise<{ record, result }>` - read, `result = fn(record)` (which returns `{ record, changed, ... }`), write only if `result.changed`, on conflict re-read and re-run `fn`; after `tries` conflicts or on any other error, throw with `err.lastResult = result` (undefined if the read failed).
  - `dispatchCheck(api): Promise<void>` - `POST /repos/{repo}/actions/workflows/check.yml/dispatches` with `{ ref: branch }`, expects 204.
  - Every request sends `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`, `User-Agent: duo-stock`, and has a 15 s timeout. Error messages read `GitHub API <METHOD> <path> answered HTTP <status>` and never include the token.
- Produces (`tests/fakes.js`, used by Tasks 4 and 5):
  - `APPLE_STORES` - the 12 stores from the existing root `check.test.js`, the 7 watched ones carrying `retailStore.storeHours` with the real values from the spec table.
  - `appleSays(inStock = {}, stores = APPLE_STORES)` - same shape as the existing helper, plus hours.
  - `fakeGitHub({ repo = "giuseppi/duo-stock" })` -> `{ handle(url, opts), file(): object | null, setFile(obj), setRaw(text), puts, dispatches, failNext(method, status, times = 1), beforeNextPut(fn) }`. It implements GET/PUT contents with real SHA checks (a PUT with a stale SHA gets 409), workflow dispatch (204), and lets a test run `fn` right before the next PUT is accepted, to simulate the other checker writing first.
  - `installFetch({ apple, github, ntfyUp })` -> `{ pushes }` - routes `api.github.com` to `github.handle`, `ntfy.sh` to a recorder of `{url, title, body, click, priority}`, Apple's pickup URL to `apple()` (a body, or a number for an HTTP status) and buy pages to a 200 with no cookies.
  - `captureConsole()` -> `{ text(), restore() }`.

- [ ] **Step 1: Write failing tests in `tests/notebook.test.js`**:
  - `read of a missing file gives an empty record`: `sha === null`, `record.restocks.length === 0`.
  - `write then read round-trips` and the PUT body has no `sha` the first time.
  - `update writes only when changed`: fn returning `changed: false` makes 0 PUTs.
  - `update retries on a conflict with fresh data`: `beforeNextPut` writes another record first -> fn runs twice, the second time seeing the other write; the final file has both changes.
  - `update gives up after 5 conflicts with lastResult attached`.
  - `invalid JSON on GitHub is never overwritten`: `setRaw("{oops")` -> `update` rejects with `/not valid JSON/`, `puts.length === 0`.
  - `HTTP errors name the status, not the token`: GET 500 -> message matches `/GET .* answered HTTP 500/` and does not contain the token.
  - `dispatchCheck posts to the check workflow`: `dispatches === 1`.
  - `apiFromGh parses ssh and https remotes` using a fake `run`.
  - `apiFromEnv requires both variables`.
- [ ] **Step 2: Run** `node --test tests/notebook.test.js` - expect failures.
- [ ] **Step 3: Implement `notebook.js` and `tests/fakes.js`.**
- [ ] **Step 4: Run** `node --test` - all pass.
- [ ] **Step 5: Commit** `git add notebook.js tests/notebook.test.js tests/fakes.js && git commit -m "Add GitHub notebook I/O with compare-and-swap writes"`

### Task 4: GitHub checker on the shared record (`check.js`, `duo.js`, workflow)

**Files:**
- Modify: `check.js` (rewrite), `duo.js` (replace `alertNew` with `pushClaims`), `.github/workflows/check.yml`
- Create: `tests/check.test.js` (one or two files if needed to stay under 300 lines)
- Delete: root `check.test.js` (its scenarios move into `tests/`)

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces:
  - `duo.js`: `pushClaims(claims: Array<{store, part}>, rows): Promise<Array<{store, part, prevOut}>>` - one push per model (MODELS order) with title `"<model name> at <stores in STORES order joined ', '>"`, body lines `"<store> (<city>): <quote or 'Available'>"`, Click = model buy page, priority urgent; pushes run with `Promise.all`; returns the claims whose push failed.
  - `check.js`: `main({ now = () => new Date(), env = process.env } = {}): Promise<void>`; exports `{ main, FAIL_ALERT_AT }`; runs only when `require.main === module`, exiting 1 on rejection.
- Flow of `main`:
  1. `api = apiFromEnv(env)`; fetch Apple.
  2. Apple failed: `update` bumps `failStreak` (capped at 6). If the new streak is exactly 6, send "Duo checker is failing" (existing copy); if that push fails, `update` sets the streak back to 5. Write `status.json` with `ok: false`, `error`, `failStreak`, `stores: toRows([])`, `history: summarize(record)`. Resolve normally (exit 0).
  3. Apple answered: `update` applies `applyRows` and resets `failStreak` to 0 (a change only if it was not 0). If the old streak was >= 6, send "Duo checker is back". `pushClaims` the claims; if any failed, `update` with `unclaim`. Write `status.json` with `ok: true`, `stores: rows`, `history: summarize(record)`.
  4. Reading the record fails: send nothing, write `status.json` with `ok: false` and the error, then reject. Saving fails after a read: push `err.lastResult.claims`, then reject.
- Workflow: give the "Check stock" step `GITHUB_TOKEN: ${{ github.token }}`; delete the "Save state" step; drop checkout's `with: ref` block and its comment; the check job's permission comment becomes `# update state.json through the API`.

- [ ] **Step 1: Write failing tests** in `tests/check.test.js` using `tests/fakes.js`, a temp-dir `chdir` per test, `env = { GITHUB_TOKEN: "ghs_fake_token_for_tests", GITHUB_REPOSITORY: "giuseppi/duo-stock" }`, `NTFY_TOPIC = "fake-topic-for-tests-7q2x"`, and an injected clock. After every run, assert neither secret appears in captured console text, `status.json` or the fake's stored file. Port every scenario from the root `check.test.js` (same titles, push titles, bodies, Click links and priorities), adapting state assertions to `fakeGitHub().file()`. Then add:
  - `first run creates state.json with no sha` (PUT without `sha`).
  - `no change means no write`: second identical run -> `puts.length` unchanged.
  - `back within 10 minutes is not a new ping`; `back after 11 minutes pings again`.
  - `the other checker claimed it first`: `beforeNextPut` writes a claim for the same key -> 0 pushes.
  - `a failed push undoes its claim` -> next run pushes it.
  - `v1 state.json is migrated without re-pinging`: `setFile({inStock: ["Irvine Spectrum|MK1H4LL/A"], failStreak: 0})` with that model still available -> 0 pushes.
  - `GitHub unreadable: no pushes and the run fails`: `failNext("GET", 500)` -> `assert.rejects(main(...))`, 0 pushes.
  - `GitHub unwritable: pushes go out and the run fails`: `failNext("PUT", 500, 5)` -> 1 push, rejects.
  - `status.json carries the history summary`: `status.history.grid.length === 7`.
- [ ] **Step 2: Run** `node --test tests/check.test.js` - expect failures.
- [ ] **Step 3: Implement** `pushClaims`, the new `check.js`, the workflow change; delete the root `check.test.js` and `alertNew`.
- [ ] **Step 4: Run** `node --test` - all pass; `grep -n alertNew *.js` finds nothing.
- [ ] **Step 5: Commit** `git add -A && git commit -m "Run the GitHub checker on the shared record"` (check `git status` first: only the files of this task).

### Task 5: Laptop watcher on the shared record (`duo-watch.js`)

**Files:**
- Modify: `duo-watch.js`
- Create: `tests/watch.test.js`

**Interfaces:**
- Consumes: Tasks 1-4.
- Produces: `createWatcher({ api, now = () => new Date() }): { checkOnce(extraHeaders = {}): Promise<void>, offline: Map<string, string> }`, exported from `duo-watch.js`. Startup (the `apiFromGh()` lookup, banner, test push, loop) runs only when `require.main === module`. The cookie warm-up, `DUO_EXTRA_HEADERS`, the blocked backoff and the "Duo watcher is blocked" alert stay in the loop as they are; the loop calls `checkOnce(headers)`.
- `checkOnce` behavior:
  - GitHub usable (`api` set, read succeeds): `update` with `applyRows(record, rows, now, { pinged: offline })`, then clear `offline`; remember the record's `claimedKeys` as `lastKnown`; `pushClaims` the claims; `unclaim` failures; if the record changed, call `dispatchCheck` (a failure there is a warning only).
  - GitHub not usable (`api` null, or read/write throws): print once per outage `GitHub unreachable (<message>), pinging from this laptop's memory until it's back`; if the error carries `lastResult`, its claims count as new. For each available key not in `offline` or `lastKnown`, push it (one push per model, same format) and on success add it to `offline` with the current time. Remove from `offline` any key now unavailable.
  - Log line per check as today (AVAILABLE list or "nothing yet", plus missing stores).
- If `apiFromGh` fails at startup, print `Can't use GitHub (<reason>). Pings will come from this laptop only, so GitHub may ping again for the same restock.` and run with `api = null`.

- [ ] **Step 1: Write failing tests in `tests/watch.test.js`** with `tests/fakes.js` and `api = { repo: "giuseppi/duo-stock", token: "gho_fake_laptop_token", branch: "main" }`:
  - `new stock: claim, one push, one dispatch`.
  - `already claimed by GitHub: no push, no write, no dispatch`.
  - `nothing changed: no write, no dispatch`.
  - `GitHub down: pings from memory once`: `failNext("GET", 500, 2)` -> first check 1 push, second check 0 pushes.
  - `expired login (401) falls back and names the status`: captured text matches `/HTTP 401/` and does not contain the token.
  - `invalid JSON on GitHub: falls back, never writes` (`puts.length === 0`).
  - `reconnect hands over still-in-stock pings`: offline push at `t0`, GitHub back at `t0 + 3 min` with the stock still there -> 0 pushes, the file has that part with `in === t0`, `offline.size === 0`, 1 dispatch.
  - `offline restock that sold out is not backfilled`: offline push, stock gone, GitHub back -> no restock in the file.
  - `no api at all behaves like GitHub down`.
- [ ] **Step 2: Run** `node --test tests/watch.test.js` - expect failures.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `node --test` - all pass. Then smoke-run the real script against a fake: `NTFY_TOPIC=x INTERVAL_SEC=600 node -e "require('./duo-watch.js')"` must not start the loop (prints nothing, exits).
- [ ] **Step 5: Commit** `git add duo-watch.js tests/watch.test.js && git commit -m "Connect the laptop watcher to the shared record"`

### Task 6: History tab (`index.html`)

**Files:**
- Modify: `index.html`

**Interfaces:**
- Consumes: `status.history` from Task 4: `{ count, basis, best: {title, detail} | null, learning: string | null, grid: [{store, counts[5], total}], log: [{store, when, models, open, minutes, lasted}] }` and `WINDOWS` labels `["12-6a", "6-9a", "9a-12", "12-5p", "5p-12"]` (hard-code them in the page).
- Produces: nothing for later tasks.

Layout (approved mockup, top to bottom): a segmented Now / History control under the heading; Now = everything the page shows today, unchanged. History =
1. A green box (reuse `.banner.yes` colors) with `best.title` bold and `best.detail` as the small line; when `best` is null, a neutral `.banner` with `learning`.
2. `basis` as a muted line (omit when null).
3. "Restocks by time of day": a table with the store name, five cells with the count and a total column. Cell level = `0` when the count is 0, else `Math.ceil(4 * count / maxCount)`. Colors (validated with the dataviz ordinal check, both PASS):
   - light: level 0 `#f0efec` with muted text; 1 `#86b6ef` with `#1a1a1a` text; 2 `#3987e5`, 3 `#1c5cab`, 4 `#0d366b` with white text.
   - dark: level 0 `#383835` with muted text; 1 `#184f95`, 2 `#256abf`, 3 `#3987e5` with `#eee` text; 4 `#86b6ef` with `#111` text.
   - Define them as CSS custom properties on `:root`, overridden in the existing dark media query. Each cell has a `title` like `"Irvine Spectrum, 6-9a: 4 restocks"`.
4. "Every restock, newest first": cards with the store bold, `when` on the right, `models · lasted` muted, and a 6px bar whose width is `minutes / max(minutes of finished entries)` (minimum 4px; no bar when open; open entries show `lasted` in the green ink). Show the first 10; a "Show <n> older" button reveals the rest.
- The selected tab follows the URL hash (`#history`), and the back button works. Every string from `status.json` goes through the existing `esc()`. Keep the 60-second refresh, and re-render the active tab.

- [ ] **Step 1: Build fixtures** under the session scratchpad (not the repo): run the real `check.js` against `tests/fakes.js` to produce `status.json` files for: no restocks yet, still learning (2), a tie, a best bet with 14 restocks, and an Apple failure.
- [ ] **Step 2: Implement** the tabs and the History tab in `index.html`; keep it under 300 lines.
- [ ] **Step 3: Verify** the inline script parses (`node -e` that extracts the `<script>` and runs `new Function` on it) and `node --test` still passes.
- [ ] **Step 4: Commit** `git add index.html && git commit -m "Add the History tab"`. Screenshots at 375 px and 1280 px, light and dark, are taken by the orchestrator in review.

### Task 7: Docs and local verification

**Files:**
- Modify: `README.md`, `CLAUDE.md`, `.gitignore` if needed

- [ ] **Step 1: README**: the laptop now shares GitHub's record (needs `gh` logged in; otherwise it pings on its own and says so); `node check.js` needs `GITHUB_TOKEN` and `GITHUB_REPOSITORY` and is meant for Actions; tests live in `tests/`; the History tab and what "how many" means (restocks, not phones). Remove the "you can get the same alert from each" and "git checkout state.json" notes, which are no longer true.
- [ ] **Step 2: CLAUDE.md**: one line each: shared record via the contents API with SHA compare-and-swap; `record.js` and `history.js` are pure and hold the rules; the 10-minute flap rule. Add an Issue Log entry "Double pings between laptop and GitHub" (Found 2026-10-26, Resolved on the merge date, Resolution: shared record with claim before ping).
- [ ] **Step 3: Run** `node --test` and `node --check` on every `.js` file; all pass.
- [ ] **Step 4: Commit** `git add README.md CLAUDE.md && git commit -m "Document the shared record and History tab"`. Do not push: the orchestrator asks the owner first.

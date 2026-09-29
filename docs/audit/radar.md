# Control audit — radar.html (operator tool, no ARB ticket)

Per docs/05 section 1. Every control on the page, and the Playwright test that exercises it. Radar is
the owner's own tool for Freelancer.com work: `apps/web/src/radar.html`, `radar.js`, the modules in
`apps/web/src/radar/` and `apps/web/src/styles/radar.css`. It is separate from the Arbitron
pipeline pages and from the demo, and no ARB ticket covers it (docs/04-PROJECT-BOARD.md, the Radar row).

The specs are in `e2e/radar-*.spec.ts`. Every call to Freelancer.com is answered inside the test by
the stand-in in `e2e/radar-helpers.ts`, from responses recorded on 27/09/2026 and trimmed
(`e2e/fixtures/radar/`), so no run depends on Freelancer.com being up. In the last two columns a test
name begins with its spec's short name: **feed** = `radar-feed.spec.ts`, **rank** = `radar-rank.spec.ts`,
**bid** = `radar-bid.spec.ts`, **bids** = `radar-bids.spec.ts`, **dev** = `radar-developers.spec.ts`,
**alerts** = `radar-alerts.spec.ts`, **token** = `radar-token.spec.ts`, **place** = `radar-place.spec.ts`,
**safety** = `radar-safety.spec.ts` and **setup** = `radar-setup.spec.ts`. A name ending in "…" is the
leading part of a longer test title. A test name shown as "none" means no spec exercises that control.

Pass column: ✅ means a test clicks or fills the control and asserts the result. "Partly" says what is
asserted and what is not. "No" means no test exercises it.

## 1. What Radar does, and what it does not

Does:

- Reads Freelancer.com's public project search (`GET /api/projects/0.1/projects/active/`, up to
  three pages of 100) from the browser, with no server, no key and no sign-in, and lists the projects.
- Ranks each project from 0 to 100 from four parts, Skill fit, Budget, Freshness and Competition,
  using the skills and weights the owner enters. The detail panel shows each part and why.
- Fills the owner's own template into a proposal and an opening price (a percentage of the project's
  maximum, kept inside its range). It writes no wording of its own, calls no model and ships no default
  template.
- Offers two bid paths (section 3), logs each bid with its price, days, template and score, and keeps
  the owner's marks for replies and awards, with totals, reply and win rates and margin.
- Searches Freelancer.com's public freelancer directory for developers to shortlist, and can show a
  browser notification for a fresh top-ranked project while the tab is open.
- Shows a setup line (Skills, In-house ticks, Template, Monthly limit, Fee %, USD→ZAR, Token, Last
  export), each as set or not set. It never blocks browsing.

Does not:

- Bid automatically. Every bid needs the owner's own press: the paste path, or Place now with its
  confirm. An automatic bidding loop is held in draft pull request #57, which is not merged and stays
  unmerged until Freelancer.com's api-support answers in writing. Radar on `main` has none of that code.
- Use the API, Supabase, the workers, Telegram or `LIVE_MODE`. It is not wired to any of them, and its
  log is not the pipeline's bid records.
- Drive a browser signed in to Freelancer.com, or use a session cookie. It reads the public search and,
  for Place now, calls the API with the owner's Personal Access Token (`scripts/check-no-browser-automation.sh`
  runs in CI).
- Show sample or demo money figures. The header holds the name "Arbitron" and no link, so there is no
  way from the page to a demo page (R-05).
- Verify clients or show client history: see the limits in section 6.
- Prove earnings. The measure of success is rand earned by Logi-Ink from Freelancer.com work, with a bid
  record. Nothing has been earned through the software (R0), and no live bid is known to have been placed
  with Place now.

## 2. What is stored, and where

Radar keeps everything in this browser's `localStorage`, under `radar.*` (`apps/web/src/radar/store.js`).
Every read and write is wrapped: a private window or blocked site data leaves the page working without
memory, and the page says so.

| Key | Holds | In Export | Written by Import |
|---|---|---|---|
| `radar.settings` | Skills, in-house skills, filters, weights, price percentage, delivery days, monthly limit, USD→ZAR, fee %, developer filters, alert settings, refresh interval | Yes | Yes |
| `radar.templates` | The owner's templates | Yes | Yes |
| `radar.log` | The bid log, with awards and notes | Yes | Yes |
| `radar.dismissed` | Dismissed project numbers | Yes | Yes |
| `radar.shortlist` | Shortlisted developers, with the owner's rate and note | Yes | Yes |
| `radar.token` | The Personal Access Token, its account, save time and last check | No | No |
| `radar.lastExport` | The time of the last Export | No | No |
| `radar.notified` | Project numbers already notified (the last 500) | No | No |
| `radar.skillsCache` | Freelancer.com's skills list, reused for 7 days | No | No |
| `radar.probe` | A test write that tells the page whether the browser keeps data | No | No |

- **Export** downloads `radar-backup-DD-MM-YYYY.json` (dated in SAST) holding the five backed-up keys
  and `exportedAt`. Test: bids, "Export downloads everything; Import puts it back after a confirm" checks
  the file's keys; setup, "Export records the time, clears the warning, and still leaves the token out"
  checks the file holds neither the token nor `lastExport`; token, "a pasted token is checked with
  Freelancer.com, masked and kept in this browser only" checks the file holds no part of the token.
  Unit test: `account.test.ts`, "the token never leaves in a backup".
- **Import** reads the file, refuses anything that is not a version 1 radar backup (with the reason),
  then asks for a confirm before it replaces the five keys and reloads. `restore()` writes only those
  five keys, so it never writes `radar.token`, `radar.lastExport` or `radar.notified`. No spec imports a
  file and then reads the token back, so that part rests on the code and not on a test.
- The **token** is kept as `radar.token`, shown only as dots and its last four characters, and sent only
  to Freelancer.com, in the `freelancer-oauth-v1` header. Remove token deletes it from this browser; the
  token itself still works on Freelancer.com until it runs out, and is revoked there. It lasts 30 days
  from when Freelancer.com generated it; the page counts from when it was pasted and warns 5 days before.
- The **last-export time** is kept outside the backup, and Import does not write it. The page shows "Never exported" or "Last export: DD/MM/YYYY" and warns after 7 days
  (and when nothing has been exported and the browser holds a template or a logged bid).
- The browser holds the only copy. Clearing site data, changing browser or changing device loses it
  unless there is an Export file.

## 3. The two bid paths, and what refuses them

Both start in the project's detail panel, "Your bid". Both need a template, a price above 0, delivery
days as a whole number from 1 to 365, and a proposal that is not empty.

**Bid on Freelancer** (the paste path) sends nothing to Freelancer.com:

1. Copies the proposal to the clipboard (if the browser refuses, the text is selected and the page says
   "Copy failed — press Ctrl+C").
2. Opens the project on Freelancer.com in a new tab, cut off from this page.
3. Shows the price and days to enter, with Copy price.
4. The owner pastes and submits the bid on Freelancer.com, then comes back and presses **I placed the
   bid**, which logs it with status Sent. **Cancel** logs nothing.

**Place now** appears only when a token was accepted by Freelancer.com at its last check, is not
expired, and the project has no bid in the log:

1. Refuses first, on the page, in the same place as the paste path, if a check fails (below).
2. Asks for a confirm: "Place this bid on Freelancer.com now?", naming the project, the account, the
   price, the days and that it counts against the month. Cancel sends nothing.
3. Asks Freelancer.com for an earlier bid of the owner's on the project (`GET /projects/0.1/bids/`).
   If there is one, it sends nothing and logs that bid.
4. Otherwise sends the bid (`POST /projects/0.1/bids/`, with `milestone_percentage` 100) and logs it
   with Freelancer.com's bid id and the answer's status, and `placedBy` set to `manual`.
5. If Freelancer.com refuses, the answer is shown in the detail panel and nothing is logged. A 401 or
   403 adds "Check the token in Settings."

What refuses a bid:

| Check | Bid on Freelancer | Place now | Message |
|---|---|---|---|
| Price not a number above 0 | Refuses | Refuses | "Enter your price, a number above 0." |
| Days not a whole number from 1 to 365 | Refuses | Refuses | "Enter the delivery days, a whole number from 1 to 365." |
| Proposal empty | Refuses | Refuses | "The proposal is empty." |
| A `{placeholder}` left in the text, of any name, including `{skills}` when none of the project's skills is ticked in-house (R-01) | Refuses; nothing copied, no tab opened | Refuses; no lookup, no POST. `placeBid` refuses again before any call | "Fill or remove {skills} before bidding." (names each one left) |
| Bids logged this SAST month have reached the monthly limit in Settings (R-06) | Not applied | Refuses; no lookup, no POST | "The monthly limit in Settings is reached (N of M bids logged this month), so Place now is off." |
| No token, an unchecked, refused or expired token, or a bid already logged on the project | Not applicable | The button is not shown | — |

A blank monthly limit means no check. The count is the bids in Radar's log this SAST month, from either
path; it is not the count Freelancer.com holds.

## 4. Every control

### Bar, notes and messages (above the tabs)

| Control | Label text | Expected action | Actual action | Loading state | Success state | Error state | Disabled state rule | Keyboard reachable | Playwright test name | Pass |
|---|---|---|---|---|---|---|---|---|---|---|
| Text (no control) | Arbitron (header) | Name the app; link nowhere | The header holds the brand name only: no link, no nav (R-05) | — | — | — | — | Not applicable | setup: R-05 › the header links nowhere, and no link on the page reaches another app page unlabelled | ✅ |
| Section (no control) | Setup | Show which of eight items are set | `ul#setup`, one `li` per item with `data-state` set, unset or warn, in this order: Skills, In-house ticks, Template, Monthly limit, Fee %, USD→ZAR, Token, Last export. Token reads saved, not saved, expiring, expired, refused or not checked | — | Each item turns to set as it is set, and stays so after a reload | — | Never blocks browsing, bidding or Export | Not applicable | setup: U-01 › on fresh storage every item is not set, in order, and browsing is not blocked; setup: U-01 › each item turns to set as it is set, and stays so after a reload; setup: U-01 › saving the token in Settings turns Token to saved at once, and removing it turns it back; setup: U-01 › a token accepted at its last check, with days to run, shows as saved; setup: U-01 › a token saved 26 days ago shows as “Token: expiring” (and 31 days, and refused) | ✅ |
| Button | Refresh now | Read the feed again now | `fetchProjects` for the watched skills (up to 3 pages of 100); the list, count and ranking rebuilt; alerts checked | "Reading Freelancer.com…"; button disabled, aria-busy | "Read N projects from Freelancer.com." and "Last updated HH:MM SAST" | Freelancer.com's message, then "Trying again at HH:MM SAST." (backs off 4, 8, 16, then 30 minutes) or, when refresh is manual, "Press Refresh now to try again." | While a read is running | Yes | feed: reads again every 2 minutes, or only on Refresh now when set to manual; feed: an error from Freelancer.com shows, and the next try backs off; feed: reads the newest projects from Freelancer.com and lists them | ✅ |
| Text (no control) | Bids this month: N / M | Show the month's count against the owner's limit | Counts log entries in the current SAST month; "/ M" only when a limit is set | — | As stated | — | — | Not applicable | bid: Bid on Freelancer copies the proposal, opens the project, and I placed the bid logs it; bid: bidding settings are checked and saved; a blank limit shows no limit | ✅ |
| Text (no control) | Last updated | Say when the feed was last read | "Not updated yet", then "Last updated HH:MM SAST" | — | As stated | — | — | Not applicable | feed: reads the newest projects from Freelancer.com and lists them | ✅ |
| Text (no control) | Never exported / Last export: DD/MM/YYYY | Say when Export was last pressed | From `radar.lastExport`; rewritten by Export | — | As stated | — | — | Not applicable | setup: U-02 › a first visit shows Never exported and does not nag when nothing is saved; setup: U-02 › up to 7 days ago there is no warning; after, there is | ✅ |
| Alert (no control) | "You have not exported yet…" / "Your last export was N days ago (DD/MM/YYYY)…" | Warn when a copy is due | Shown when nothing was ever exported and the browser holds a template or a logged bid, or the last Export is over 7 days old; hidden otherwise | — | Cleared by Export | — | Not shown on a first visit with nothing saved | Not applicable | setup: U-02 › never exported, with something saved, warns; setup: U-02 › up to 7 days ago there is no warning; after, there is; setup: U-02 › Export records the time, clears the warning, and still leaves the token out | ✅ |
| Button | Export | Save everything as a file | Downloads `radar-backup-DD-MM-YYYY.json` (five keys, no token); records `radar.lastExport` | — | "Exported everything to radar-backup-DD-MM-YYYY.json. Keep it somewhere safe." | — | Never | Yes | bids: Export downloads everything; Import puts it back after a confirm; setup: U-02 › Export records the time, clears the warning, and still leaves the token out; token: a pasted token is checked with Freelancer.com, masked and kept in this browser only | ✅ |
| Button, hidden file input | Import | Choose a backup file to restore | Opens the file chooser; reads the file with `parseBackup`; asks the confirm "Replace everything here with this backup?" (section 4, confirms); on Replace writes the five keys and reloads | — | After the reload: "Imported <file>, exported DD/MM/YYYY HH:MM SAST." | "That file is not a radar backup." (or not JSON, wrong version, a missing list); "This browser would not keep the backup (private window or blocked site data)." | Never | Yes | bids: Export downloads everything; Import puts it back after a confirm | Partly: the test sets the hidden file input directly, so the Import button that opens the file chooser is not clicked; the refusal, the confirm's Cancel and Replace, and the restored bids are asserted |
| Alert (no control) | "This browser is not keeping what you save here (private window or blocked site data)." | Warn when storage refuses | Shown when a write to `localStorage` fails | — | — | — | Hidden while writes succeed | Not applicable | none (the fall-back of `readJson` and `writeJson` is unit tested in `feed.test.ts`, "falls back quietly when storage is missing or refuses") | No |
| Alert (no control) | "Your Freelancer token runs out on DD/MM/YYYY, in N days…" / "…ran out on DD/MM/YYYY…" | Warn 5 days before the 30 run out, then when they have | Shown on every tab from 5 days before expiry | — | — | — | Hidden for no token or more than 5 days left | Not applicable | token: 5 days before the 30 run out the page warns on every tab, then says it has run out | ✅ |
| Live region | (status line under the bar) | Say what the last action did | `role="status"`, `aria-live="polite"`; every action writes its result here | — | As each control states | As each control states | — | Not applicable | Asserted by every test above | ✅ |

### Tabs

| Control | Label text | Expected action | Actual action | Loading state | Success state | Error state | Disabled state rule | Keyboard reachable | Playwright test name | Pass |
|---|---|---|---|---|---|---|---|---|---|---|
| Tabs ×5 (`role="tab"`) | Feed / Bids / Developers / Templates / Settings | Show that panel and hide the others | `aria-selected` and `tabindex` follow the choice; the Bids tab redraws its figures when opened | — | The panel shows | — | Never | Yes: the selected tab is a tab stop and Left and Right arrows move between tabs | setup: U-01 › on fresh storage every item is not set, in order, and browsing is not blocked (opens Bids); token: a pasted token is checked with Freelancer.com, masked and kept in this browser only (opens Settings); bid: with no template the detail panel says to add one, and takes you there (checks `aria-selected` on Templates); dev: searches the directory and shows the developers who meet the filters, best first (opens Developers) | Partly: clicking each tab is exercised across the specs. No spec presses the arrow keys, so the keyboard handler is not tested |

### Feed panel

| Control | Label text | Expected action | Actual action | Loading state | Success state | Error state | Disabled state rule | Keyboard reachable | Playwright test name | Pass |
|---|---|---|---|---|---|---|---|---|---|---|
| Alert (no control) | "Ranking is incomplete until you pick skills and tick what Logi-Ink delivers in-house." (R-03) | Say when the rank has no skills to work from | Shown while no skills are picked or no in-house skill is ticked; hides when both are set | — | — | — | Hidden once both are set | Not applicable | safety: R-03 › shows on fresh storage, goes once both are set, and returns when one is taken away | ✅ |
| Disclosure (`details > summary`) | Filters | Open or close the filter form | Toggles the form | — | — | — | Never | Yes | feed: filters narrow the feed and are saved | ✅ |
| Select | Type | Show fixed, hourly or both | Saved in settings as typed; the feed redraws | — | "Showing N of the M projects read." | — | Never | Yes | feed: filters narrow the feed and are saved | ✅ |
| Input | Minimum budget, fixed (USD) | Hide fixed projects worth less | Saved; the feed redraws | — | As above | "Enter a number of 0 or more in: <label>." with `aria-invalid` | Never | Yes | feed: filters narrow the feed and are saved | ✅ |
| Input | Minimum rate, hourly (USD) | Hide hourly projects paying less | As above | — | As above | As above | Never | Yes | feed: filters narrow the feed and are saved | ✅ |
| Input | Most bids already placed | Hide projects with more bids | As above | — | As above | As above (asserted for this field) | Never | Yes | feed: filters narrow the feed and are saved | ✅ |
| Input | Oldest, in hours | Hide projects older than this | As above | — | As above | As above | Never | Yes | feed: filters narrow the feed and are saved | ✅ |
| Input | Leave out titles with | Hide titles containing any of these words | Comma-separated, any case; saved | — | As above | — | Never | Yes | feed: filters narrow the feed and are saved | ✅ |
| Checkbox | Hide projects already bid on or dismissed | Hide acted-on projects | Saved; on by default | — | Rows return with a "Bid placed" or "Dismissed" badge when unticked | — | Never | Yes | feed: Dismiss hides a project and remembers it; Restore brings it back; bid: Bid on Freelancer copies the proposal, opens the project, and I placed the bid logs it | ✅ |
| Text (no control) | Showing N of the M projects read. / No project passes the filters. Loosen them to see more. / No projects read yet. | Count and explain the list | Rewritten on each draw | — | As stated | — | — | Not applicable | feed: reads the newest projects from Freelancer.com and lists them (the count line). none for the two empty messages | Partly |
| Button (per row, the project's title) | <project title> | Open the detail panel | Delegated click on the row opens the panel | — | The dialog opens | — | Never | Yes | feed: a row opens its full description, and Close shuts it | Partly: the tests click the row's meta line, which runs the same handler; the title button itself is not clicked |
| Text (per row) | Score badge, "N out of 100"; budget, bids, age; skills; NDA, Sealed, Urgent, Featured, Bid placed, Dismissed badges | Show the rank and what the client asked | Rows sorted highest score first, newest first on a tie | — | — | — | — | Not applicable | rank: every row has a score, highest first; feed: reads the newest projects from Freelancer.com and lists them | ✅ |
| Link (per row) | Open (aria-label "Open <title> on Freelancer.com") | Open the project on Freelancer.com | New tab, `rel="noopener"` | — | — | — | Never | Yes | feed: reads the newest projects from Freelancer.com and lists them | Partly: the address, `target` and accessible name are asserted; the link is not clicked |
| Button (per row) | Dismiss / Restore | Hide or bring back the project | Saved to `radar.dismissed`; the row leaves or returns | — | "Dismissed “<title>”." / "Restored “<title>”." | — | Never | Yes | feed: Dismiss hides a project and remembers it; Restore brings it back | ✅ |

### Detail dialog (opens from a row, from an alert, or from Add a template)

| Control | Label text | Expected action | Actual action | Loading state | Success state | Error state | Disabled state rule | Keyboard reachable | Playwright test name | Pass |
|---|---|---|---|---|---|---|---|---|---|---|
| Button | Close | Close the panel | `dialog.close()` | — | Dialog hidden | — | Never | Yes | feed: a row opens its full description, and Close shuts it; bid: Cancel logs nothing | ✅ |
| Link | Open on Freelancer.com | Open the project | New tab, `rel="noopener"` | — | — | — | Never | Yes | feed: a row opens its full description, and Close shuts it | Partly: the address is asserted; the link is not clicked |
| Section (no control) | Rank score N of 100, and the table of Skill fit, Budget, Freshness, Competition with points and the reason | Show why the project ranks where it does | Rebuilt on open. With nothing ticked in-house, Skill fit names the empty setting (U-03) | — | — | — | — | Not applicable | rank: the detail panel shows the score and each part of it; rank: an in-house skill lifts the projects that need it; setup: U-03 › with nothing ticked as in-house, Skill fit says which setting is empty; setup: U-03 › once a skill is ticked that the project does not need, it stops blaming the setting; setup: U-03 › with a matching skill ticked it reads as before | ✅ |
| Text (no control) | Description | Show the client's full description | Plain text | — | — | — | — | Not applicable | feed: a row opens its full description, and Close shuts it | ✅ |
| Alert (no control) | "You logged a bid on this project on DD/MM/YYYY HH:MM SAST." | Say a bid is already logged | Shown when the log holds a bid on this project | — | — | — | — | Not applicable | bid: Bid on Freelancer copies the proposal, opens the project, and I placed the bid logs it | ✅ |
| Text and button (no template) | "Add your first template to write a proposal here." / Add a template | Take the owner to the Templates tab | Closes the dialog, selects Templates, focuses Name | — | The Templates tab is open with Name focused | — | Shown only while there is no template | Yes | bid: with no template the detail panel says to add one, and takes you there | ✅ |
| Select | Template | Choose which template to fill | Rewrites the proposal from the chosen template; the default is marked "(default)" | — | — | — | Hidden with the form while there is no template | Yes | bid: Bid on Freelancer copies the proposal, opens the project, and I placed the bid logs it (asserts the default is chosen) | Partly: choosing another template is not tested |
| Input | Price (<currency>) / Price per hour (<currency>) | Set the price | Opens at the price percentage of the project's maximum, kept in its range; rewrites the proposal; hint shows the budget and the price in USD | — | The proposal follows | `aria-invalid` when not a number above 0 | Never | Yes | bid: the price is the owner’s to change, shown in USD too, and checked | ✅ |
| Input | Delivery days | Set the days | Opens at the default in Settings; rewrites the proposal | — | The proposal follows | `aria-invalid` when not a whole number from 1 to 365 | Never | Yes | bid: the price is the owner’s to change, shown in USD too, and checked | ✅ |
| Textarea | Proposal | Edit the text | The character count follows. Changing the template, price or days writes the text again | — | "N characters" | — | Never | Yes | bid: Bid on Freelancer copies the proposal, opens the project, and I placed the bid logs it | ✅ |
| Text (no control) | Error line under the proposal | Say what is wrong | Joins the checks in section 3 in one line | — | Hidden when nothing is wrong | See section 3 | — | Not applicable | bid: the price is the owner’s to change, shown in USD too, and checked; safety: R-01 › {skills} with no in-house overlap: neither copied nor placed, and nothing is sent; safety: R-06 › at the limit it refuses, with the count, and sends nothing; the paste path is unchanged | ✅ |
| Button | Bid on Freelancer | Copy the proposal and open the project | Section 3, the paste path. Nothing is sent to Freelancer.com | Not applicable | "Proposal copied. Paste it into your bid on Freelancer.com." then the bid panel | "Copy failed — press Ctrl+C" with the text selected; the section 3 refusals | Not shown until a template exists | Yes | bid: Bid on Freelancer copies the proposal, opens the project, and I placed the bid logs it; bid: when the clipboard refuses, the text is selected to copy by hand; safety: R-01 › a placeholder typed into the text is refused by name, until it is taken out | ✅ |
| Button | Place now | Place the bid on Freelancer.com | Section 3, Place now | "Placing the bid on Freelancer.com…"; button disabled, aria-busy | "Placed your bid on “<title>” on Freelancer.com (bid N). It is logged." / "Freelancer.com already has your bid N on “<title>”, so nothing new was sent. It is logged." | Freelancer.com's refusal in the panel, "Freelancer.com refused placing the bid (HTTP 400: …)"; the section 3 refusals | Hidden without an accepted, unexpired token, and once a bid on the project is logged; disabled while sending | Yes | place: without a token there is no Place now, only Bid on Freelancer; place: Place now checks for an earlier bid, sends the bid, and logs it with Freelancer’s id; place: when Freelancer.com already has his bid, nothing new is sent and the bid is logged; place: a refused bid is shown on the page and not logged; safety: R-01 › with the skill ticked as in-house, {skills} is filled and Place now sends it; safety: R-06 › at the limit it refuses, with the count, and sends nothing; the paste path is unchanged | ✅ |
| Text (no control) | "Place now sends this bid to Freelancer.com with your token, straight from this page." | Say what Place now does | Shown with the button | — | — | — | Same as the button | Not applicable | place: without a token there is no Place now, only Bid on Freelancer (hidden without a token) | Partly: shown or hidden with the button is not asserted separately |
| Button (bid panel) | Copy price | Copy the price to the clipboard | Copies the number | — | "Price N copied." | "Copy failed — the price is N." | Shown after Bid on Freelancer | Yes | bid: Bid on Freelancer copies the proposal, opens the project, and I placed the bid logs it; bid: when the clipboard refuses, the text is selected to copy by hand | ✅ |
| Button (bid panel) | I placed the bid | Log the bid as placed | Adds a log entry with status Sent (price, days, text and template as copied); closes the dialog | — | "Logged your bid on “<title>”." The counter and the feed update | — | Shown after Bid on Freelancer | Yes | bid: Bid on Freelancer copies the proposal, opens the project, and I placed the bid logs it | ✅ |
| Button (bid panel) | Cancel | Log nothing | Hides the panel | — | "Nothing was logged." | — | Shown after Bid on Freelancer | Yes | bid: Cancel logs nothing | ✅ |
| Link (bid panel) | Open it on Freelancer.com | Open the project again | New tab, `rel="noopener"` | — | — | — | Shown after Bid on Freelancer | Yes | bid: Bid on Freelancer copies the proposal, opens the project, and I placed the bid logs it | Partly: the address is asserted; the link is not clicked |

### Confirm dialogs (`confirmAction`, `apps/web/src/lib/ui.js`)

Each is a modal dialog with a Cancel button and a confirm button. Cancel has focus when it opens, so a
stray Enter cancels. Escape and closing the dialog also cancel.

| Control | Label text | Expected action | Actual action | Loading state | Success state | Error state | Disabled state rule | Keyboard reachable | Playwright test name | Pass |
|---|---|---|---|---|---|---|---|---|---|---|
| Buttons ×2 | Place this bid on Freelancer.com now? — Cancel / Place the bid | Confirm or refuse a real bid | Cancel sends nothing; Place the bid runs the lookup and the POST | — | As Place now | As Place now | Never | Yes | place: Place now checks for an earlier bid, sends the bid, and logs it with Freelancer’s id (Cancel, then Place the bid); safety: R-06 › with room under a limit of 3 it goes on to its confirm | ✅ |
| Buttons ×2 | Delete this template? — Cancel / Delete | Confirm or refuse deleting a template | Cancel leaves it; Delete removes it from this browser. Bids already logged keep their text | — | "Deleted “<name>”." | — | Never | Yes | bid: templates are added, checked, edited, made default and deleted | ✅ |
| Buttons ×2 | Remove the Freelancer token? — Cancel / Remove | Confirm or refuse removing the token | Cancel leaves it; Remove deletes `radar.token` | — | "The token is removed from this browser." | — | Never | Yes | token: a pasted token is checked with Freelancer.com, masked and kept in this browser only; setup: U-01 › saving the token in Settings turns Token to saved at once, and removing it turns it back | Partly: Remove is clicked; Cancel is not |
| Buttons ×2 | Replace everything here with this backup? — Cancel / Replace | Confirm or refuse an Import | Cancel: "Nothing was imported."; Replace writes the five keys and reloads | — | "Imported <file>, exported DD/MM/YYYY HH:MM SAST." | "This browser would not keep the backup…" | Never | Yes | bids: Export downloads everything; Import puts it back after a confirm | ✅ |

### Bids tab

| Control | Label text | Expected action | Actual action | Loading state | Success state | Error state | Disabled state rule | Keyboard reachable | Playwright test name | Pass |
|---|---|---|---|---|---|---|---|---|---|---|
| Section (no control) | This month / All time | Show bids, replies, reply rate, awards, win rate, awarded value, delivery cost and margin | Worked from the log by `computeTotals`; rand shown only when USD→ZAR is set; margin says "(fee not set)" until the fee is set | — | As stated | — | — | Not applicable | bids: lists every logged bid, newest first, with totals for this month and all time; bids: status buttons, the award’s figures, the fee and the rand rate | ✅ |
| Disclosures ×2 (`details > summary`) | Reply and win rates this month, by template and rank / of all time, by template and rank | Show the split tables | This month's is open; all time's opens on click | — | The tables show | — | Never | Yes | bids: status buttons, the award’s figures, the fee and the rand rate (clicks the all-time summary); bids: the Bids tab works at 380 px wide | Partly: the all-time summary is clicked; the month's is open by default and only read |
| Text (no control) | "No bids logged yet. After you bid on Freelancer.com, press I placed the bid." | Say the log is empty | Shown while the log is empty | — | — | — | — | Not applicable | bids: Export downloads everything; Import puts it back after a confirm | ✅ |
| Link (per bid) | <project title> | Open the project | New tab, `rel="noopener"` | — | — | — | Never | Yes | bids: lists every logged bid, newest first, with totals for this month and all time | Partly: the address is asserted; the link is not clicked |
| Buttons ×5 (per bid, `role="group"`, `aria-pressed`) | Replied / Awarded / Lost / No reply / Back to sent | Mark where the bid stands | Sets the status; Replied and Awarded mark a reply; the figures redraw | — | "“<title>” is marked <status>." | — | Never | Yes | bids: status buttons, the award’s figures, the fee and the rand rate | ✅ |
| Select (awarded bids) | Delivered by | Choose in-house or a shortlisted developer | Starts the delivery cost from the developer's rate, or 0 in-house | — | The margin line updates | — | Only on an awarded bid | Yes | dev: an awarded bid takes its delivery cost from a shortlisted developer | ✅ |
| Input (awarded bids) | Agreed value (<currency>) | Enter what was agreed | Saved as typed | — | The margin line updates | "Enter the agreed value and the delivery cost as numbers (0 for in-house)." | Only on an awarded bid | Yes | bids: an award’s figures must be numbers; bids: status buttons, the award’s figures, the fee and the rand rate | ✅ |
| Input (awarded bids) | Delivery cost (USD) | Enter the cost of delivering | Saved as typed | — | The margin line updates | As above | Only on an awarded bid | Yes | bids: status buttons, the award’s figures, the fee and the rand rate; dev: an awarded bid takes its delivery cost from a shortlisted developer | ✅ |
| Textarea (awarded bids) | Note | Keep a note on the award | Saved as typed | — | Kept after a reload | — | Only on an awarded bid | Yes | bids: status buttons, the award’s figures, the fee and the rand rate | ✅ |

### Developers tab

| Control | Label text | Expected action | Actual action | Loading state | Success state | Error state | Disabled state rule | Keyboard reachable | Playwright test name | Pass |
|---|---|---|---|---|---|---|---|---|---|---|
| Input | Search Freelancer.com’s freelancers | Type what to search for | Sent as `query` with `limit` 50, `reputation` and `country_details` | — | — | "Type what to search for, for example wordpress." with `aria-invalid` | Never | Yes | dev: searches the directory and shows the developers who meet the filters, best first; dev: an empty search, or an error from Freelancer.com, says so | ✅ |
| Text (no control) | "Shows freelancers with at least N % of jobs completed and at least M reviews, best rated first. Change this in Settings." | State the owner's filters | Follows the Developer finder settings | — | — | — | — | Not applicable | dev: searches the directory and shows the developers who meet the filters, best first; dev: the filters are the owner’s settings | ✅ |
| Button (submit) | Search | Search the directory | `GET` the directory; results filtered by completion rate and reviews, best rated first | "Searching Freelancer.com…"; button disabled, aria-busy | "Found N freelancers for “<query>”; K meet your filters." | Freelancer.com's message, for example "Freelancer.com answered HTTP 503: Service unavailable." | While searching | Yes | dev: searches the directory and shows the developers who meet the filters, best first; dev: an empty search, or an error from Freelancer.com, says so | ✅ |
| Link (per result) | <username> | Open the freelancer's profile | New tab, `rel="noopener"` | — | — | — | Never | Yes | dev: searches the directory and shows the developers who meet the filters, best first | Partly: the address and `target` are asserted; the link is not clicked |
| Button (per result) | Shortlist (aria-label "Shortlist <name>"); Shortlisted once listed | Add the developer to the shortlist | Saved to `radar.shortlist` with their own rate | — | "Shortlisted <name>." | — | Disabled once shortlisted ("<name> is shortlisted") | Yes | dev: the shortlist keeps developers with the owner’s rate and note | ✅ |
| Text (no control) | "No developer shortlisted yet…" | Say the shortlist is empty | Shown while it is empty | — | — | — | — | Not applicable | dev: the shortlist keeps developers with the owner’s rate and note | ✅ |
| Link (per shortlisted) | <username> | Open the profile | New tab, `rel="noopener"` | — | — | — | Never | Yes | none | No |
| Input (per shortlisted) | Your price or rate for them (USD) | Enter the owner's own figure | Saved as typed; a bad number keeps the last good one and sets `aria-invalid` | — | Kept after a reload | `aria-invalid` | Never | Yes | dev: the shortlist keeps developers with the owner’s rate and note | Partly: a number is tested; an invalid entry is not |
| Input (per shortlisted) | Note | Keep a note | Saved as typed | — | Kept after a reload | — | Never | Yes | dev: the shortlist keeps developers with the owner’s rate and note | ✅ |
| Button (per shortlisted) | Remove (aria-label "Remove <name> from the shortlist") | Take the developer off | Removed from `radar.shortlist` | — | "Removed <name> from the shortlist." | — | Never | Yes | dev: the shortlist keeps developers with the owner’s rate and note | ✅ |

### Templates tab

| Control | Label text | Expected action | Actual action | Loading state | Success state | Error state | Disabled state rule | Keyboard reachable | Playwright test name | Pass |
|---|---|---|---|---|---|---|---|---|---|---|
| Text (no control) | Placeholders: `{title}`, `{skills}`, `{budget}`, `{price}`, `{timeline_days}`, `{first_line}` | Say what each placeholder fills | `{skills}` is the project's skills ticked in-house; `{first_line}` is the first sentence, cut at a whole word with "…" over 160 characters. Anything else in braces is left as written, and then refuses the bid | — | — | — | — | Not applicable | bid: with no template the detail panel says to add one, and takes you there (the six names); safety: R-01 › {skills} with no in-house overlap: neither copied nor placed, and nothing is sent | ✅ |
| Text (no control) | "Add your first template…" | Say there is no template | Shown while there is none | — | — | — | — | Not applicable | bid: with no template the detail panel says to add one, and takes you there | ✅ |
| Input | Name | Name the template | Trimmed; compared without case | — | — | "Give the template a name." / "Another template has this name."; `aria-invalid`; focus goes to the field | Never | Yes | bid: templates are added, checked, edited, made default and deleted | ✅ |
| Textarea | Text | The owner's own wording | Trimmed | — | — | "Write the text of the template." | Never | Yes | bid: templates are added, checked, edited, made default and deleted | ✅ |
| Checkbox | Use this template first | Make it the default | Saved as the default; the others are cleared. The first template added is the default anyway | — | Badge "Default" | — | Never | Yes | none | No |
| Button (submit) | Add the template / Save the template | Add or save | Saved to `radar.templates`; the form resets | — | "Added “<name>”." / "Saved “<name>”." | The field errors above | Never | Yes | bid: templates are added, checked, edited, made default and deleted | ✅ |
| Button | Cancel editing | Leave edit mode | Resets the form to Add a template | — | Heading returns to "Add a template" | — | Shown only while editing | Yes | bid: templates are added, checked, edited, made default and deleted | ✅ |
| Button (per template) | Edit (aria-label "Edit: <name>") | Load it into the form | Fills the form; heading "Edit “<name>”"; Name focused | — | — | — | Never | Yes | bid: templates are added, checked, edited, made default and deleted | ✅ |
| Button (per template) | Make default (aria-label "Make default: <name>") | Make it the default | Only that template is the default | — | "“<name>” is now the default template." | — | Not shown on the default | Yes | bid: templates are added, checked, edited, made default and deleted | ✅ |
| Button (per template) | Delete (aria-label "Delete: <name>") | Delete after a confirm | Opens "Delete this template?" (see the confirms) | — | "Deleted “<name>”." | — | Never | Yes | bid: templates are added, checked, edited, made default and deleted | ✅ |

### Settings tab

Every field is saved as it is typed, to `radar.settings`. An entry that fails its rule is not saved: the
last good value stays, the field is marked `aria-invalid`, and the rule is written in the line under the
form ("<label>: a whole number from 1 to 100.").

| Control | Label text | Expected action | Actual action | Loading state | Success state | Error state | Disabled state rule | Keyboard reachable | Playwright test name | Pass |
|---|---|---|---|---|---|---|---|---|---|---|
| Input (password) | Paste a token | Enter the Personal Access Token | Not shown after saving; `autocomplete="off"` | — | — | "Paste the token first." / "A token has no spaces in it. Paste it again, on its own." / "That is too short to be a token. Paste the whole of it." | Never | Yes | token: what is not a token is caught before anything is sent; token: a pasted token is checked with Freelancer.com, masked and kept in this browser only | ✅ |
| Button (submit) | Save and check (Replace and check once a token is saved) | Ask Freelancer.com whose token it is, and keep it if accepted | `GET /users/0.1/self/`; the token is kept only once accepted; the field is cleared | "Asking Freelancer.com whose token this is…"; buttons disabled, aria-busy | "Freelancer.com accepted the token: you are <name> (user N)." Token line shows dots, last four characters, pasted and expiry dates, and the account | "Token rejected (HTTP 401: …). Generate a new one at accounts.freelancer.com/settings/develop." The token is not kept | While checking | Yes | token: a pasted token is checked with Freelancer.com, masked and kept in this browser only; token: a token Freelancer.com refuses is not kept, and the page says what to do | ✅ |
| Button | Check again | Recheck the saved token | As above, keeping the original save date | As above | "Freelancer.com accepted the token…" | The refusal is stored on the token and shown | Hidden until a token is saved; while checking | Yes | token: a pasted token is checked with Freelancer.com, masked and kept in this browser only | Partly: an accepted recheck is tested; a refused recheck is not |
| Button | Remove token | Forget the token (after a confirm) | Opens "Remove the Freelancer token?" | — | "The token is removed from this browser." | — | Hidden until a token is saved; while checking | Yes | token: a pasted token is checked with Freelancer.com, masked and kept in this browser only | ✅ |
| Link | accounts.freelancer.com/settings/develop | Open where a token is made | New tab, `rel="noopener"` | — | — | — | Never | Yes | setup: R-05 › the header links nowhere, and no link on the page reaches another app page unlabelled | Partly: the destination is asserted; the link is not clicked |
| Input | Find a skill | Search Freelancer.com's skills to watch | Filters the list (first 30 matches); the list is read once and kept 7 days | — | Matches with checkboxes | "Could not load Freelancer's skills list. …"; "No skill has that in its name." | Never | Yes | feed: picking skills to watch reads their projects; removing one reads again | Partly: matches are tested; the two messages are not |
| Checkboxes (per match) | <skill name> | Watch or stop watching a skill | Saved; the feed is read again 1,5 seconds after picking pauses; the setup line and the rank note update | — | The skill appears as a chip | — | Never | Yes | feed: picking skills to watch reads their projects; removing one reads again | ✅ |
| Buttons (per chip) | × (aria-label "Remove <skill>") | Stop watching | Removes the chip; reads again | — | The chip goes | — | Never | Yes | feed: picking skills to watch reads their projects; removing one reads again | ✅ |
| Input | Find an in-house skill | Search skills Logi-Ink delivers itself | As Find a skill | — | Matches with checkboxes | As Find a skill | Never | Yes | rank: an in-house skill lifts the projects that need it | Partly: as Find a skill |
| Checkboxes (per match) and chip × | <skill name>; Remove <skill> | Tick or untick an in-house skill | Saved; the feed and every score redraw; fills `{skills}` | — | The chip appears or goes | — | Never | Yes | rank: an in-house skill lifts the projects that need it; safety: R-03 › shows on fresh storage, goes once both are set, and returns when one is taken away | ✅ |
| Inputs ×4 | Skill fit / Budget / Freshness / Competition (rank weights) | Set the points each part is worth | Whole numbers 0 to 100, scaled so the best score is 100 | — | The feed re-ranks | "<label>: a whole number from 0 to 100." | Never | Yes | rank: the weights are the owner’s, checked, saved and applied | ✅ |
| Input | Opening price, % of the project’s maximum | Set the opening price | Whole number 1 to 100 | — | New bids open at that price | "…: a whole number from 1 to 100." | Never | Yes | bid: bidding settings are checked and saved; a blank limit shows no limit; bid: the price is the owner’s to change, shown in USD too, and checked | ✅ |
| Input | Delivery days, unless you change them | Set the default days | Whole number 1 to 365 | — | New bids open with these days | "…: a whole number from 1 to 365." | Never | Yes | bid: bidding settings are checked and saved; a blank limit shows no limit | ✅ |
| Input | Bids your membership allows a month | Set the monthly limit | Whole number 1 to 100 000, or blank. The header counter reads "Bids this month: N / M"; Place now refuses at the limit (R-06). The limit is typed by the owner; Radar does not read it from the account | — | The counter and the setup line update | "…: a whole number from 1 to 100000, or blank." | Never | Yes | bid: bidding settings are checked and saved; a blank limit shows no limit; safety: R-06 › at the limit it refuses, with the count, and sends nothing; the paste path is unchanged | Partly: setting, clearing and the refusal are tested; an invalid entry is not |
| Input | Rand for one US dollar | Set the rate for rand figures | A number 0,01 to 1000, or blank. Nothing here looks the rate up | — | Rand shown beside USD on the Bids tab | "…: a number from 0.01 to 1000, or blank." | Never | Yes | bids: status buttons, the award’s figures, the fee and the rand rate | Partly: a value is tested; an invalid entry is not |
| Input | Freelancer.com’s fee on an award, % | Set the fee | A number 0 to 100, or blank (blank: the margin says the fee is not set) | — | The margin follows | "…: a number from 0 to 100, or blank." | Never | Yes | bids: status buttons, the award’s figures, the fee and the rand rate | Partly: a value is tested; an invalid entry is not |
| Input | Lowest completion rate, % | Filter the developer search | A number 0 to 100 | — | The Developers hint and results follow | "…: a number from 0 to 100." | Never | Yes | dev: the filters are the owner’s settings | Partly: a value is tested; an invalid entry is not |
| Input | Fewest reviews | Filter the developer search | Whole number 0 to 100 000 | — | As above | "Fewest reviews: a whole number from 0 to 100000." | Never | Yes | dev: the filters are the owner’s settings | ✅ |
| Checkbox | Notify me when a new top project appears | Turn alerts on or off | Asks the browser for permission; saved only if granted | — | "Alerts are on." / "Alerts are off." | Blocked: "Notifications are blocked for this site in your browser’s settings, so alerts stay off." | Never disabled; it stays unticked where the browser cannot show notifications | Yes | alerts: turning alerts on asks the browser, then notifies each fresh top project once; alerts: with alerts off, or at a threshold nothing reaches, nothing is shown; alerts: when the browser refuses, alerts stay off and the page says why | ✅ |
| Input | Lowest rank score to notify | Set the alert threshold | Whole number 0 to 100 | — | "Alerts are on for projects scoring N or more." | "…: a whole number from 0 to 100." | Never | Yes | alerts: turning alerts on asks the browser, then notifies each fresh top project once | Partly: a value is tested; an invalid entry is not |
| Text (no control) | Alerts state | Say whether alerts work | Follows the checkbox and the browser's permission | — | As stated | — | — | Not applicable | alerts: turning alerts on asks the browser, then notifies each fresh top project once | ✅ |
| Browser notification | Radar N: <title> | Tell the owner of a fresh top project | One per project at or above the threshold and under 15 minutes old, while the tab is open. Clicking it opens the project's panel | — | — | "This browser shows notifications only from installed apps, so alerts cannot show here." | — | Not applicable | alerts: turning alerts on asks the browser, then notifies each fresh top project once | Partly: which notifications are shown is tested; clicking a notification is not |
| Select | Read the feed again | Set the refresh interval | Every 2, 5 or 10 minutes, or only on Refresh now | — | "The feed is read every N minutes." / "The feed is read only when you press Refresh now." | — | Never | Yes | feed: reads again every 2 minutes, or only on Refresh now when set to manual | Partly: 2 (default), 5 and manual are tested; 10 is not |
| Text (no control) | Settings error line | List every field that failed | Joins the rules of the failing fields; hidden when there are none | — | Hidden | As stated | — | Not applicable | bid: bidding settings are checked and saved; a blank limit shows no limit; rank: the weights are the owner’s, checked, saved and applied | ✅ |

## 5. Figures

Radar shows money as the tracker computes it (`apps/web/src/radar/tracker.js`). The hand-worked expected
values are in `tracker.test.ts`. The page recalculates only for display.

- A project's budget is shown in its own currency with USD beside it. USD figures use the rate Freelancer.com
  gives for that currency at the time of the read.
- Rand figures appear only when the owner has typed a rate. Radar does not look the rate up, and shows no
  timestamp for it because the owner's number is not a fetched rate.
- The margin is the agreed value less the delivery cost less the fee; with no fee set it says "(fee not
  set)" and leaves the fee out.
- Reply rate is replies over bids; win rate is awards over replies. With nothing to divide by, the page
  says "No data (0 of 0)" and never 0 %.
- Months turn at 00:00 SAST on the 1st.

## 6. Limits

- **Browser storage only.** What Radar keeps is in this browser on this device. Nothing is sent to a
  server of ours, and nothing is shared between devices. Export and Import move it as a file. If site
  data is cleared, the bid log goes with it.
- **The tab must be open** for the feed to refresh and for alerts to appear. A closed tab reads nothing
  and notifies nothing. Some phone browsers show notifications only from an installed app.
- **The token lasts 30 days**, counted from when it was pasted, with a warning 5 days before. After that
  Place now is not offered until a new one is pasted. A token pasted on one device is not on another.
- **No automatic bidding.** Every bid is the owner's own press. Freelancer.com's developer documentation
  treats automatic bidders as needing its approval; the loop on draft pull request #57 stays unmerged
  until api-support answers in writing (docs/02-BLOCKERS.md, T-01).
- **The feed carries no client data.** The public search returns no client verification or client
  history: its owner fields come back empty without a token (found on 29/09/2026, LI-AUDIT-BPOMAX-20260929).
  Radar does not score on client quality and does not show it.
- **The monthly limit is the owner's setting.** Radar counts the bids in its own log this SAST month. It
  does not read the limit from the account, and it does not count bids placed on Freelancer.com outside
  Radar. The limit applies to Place now only.
- **Freelancer.com decides what it accepts.** A bid it refuses is shown as it answers and is not logged.
  Radar shows whether Freelancer.com calls the account limited; it does not know whether the account is
  ID-verified. A read can be refused or rate limited (429); the page then waits 4, 8, 16, then 30 minutes.
- **Reads are capped** at three pages of 100 projects. The developer search returns at most 50.
- **No wording, skill, price, fee or rate is supplied.** The owner types every one. Until skills are
  picked and ticked in-house, ranking is incomplete and the page says so (R-03).
- **Keyboard.** Controls are native buttons, inputs, selects and links, and the tabs move with the arrow
  keys. No Radar spec presses a key, so keyboard reachability is by construction and not proved by a test.
- **No `events` rows.** Radar has no server, so a confirmed action (delete, Place now, Import) is not
  written to the Arbitron `events` table. The bid log in the browser is Radar's record.

## 7. Tests

Playwright, in `e2e/` (run in CI as `pnpm exec playwright test --config e2e/playwright.config.ts`, after
`pnpm build:web:e2e`):

| Spec | Covers |
|---|---|
| `radar-feed.spec.ts` | The live read, rows, the detail panel, Dismiss and Restore, filters, watched skills, refresh timing and back-off, the content security policy, 380 px |
| `radar-rank.spec.ts` | Scores, the breakdown, in-house skills, weights |
| `radar-bid.spec.ts` | Templates, the proposal, price and days, Bid on Freelancer, I placed the bid, Cancel, the clipboard refusal, bidding settings, 380 px |
| `radar-place.spec.ts` | Place now: no token, the confirm, the earlier-bid lookup, the POST, the refusal |
| `radar-token.spec.ts` | The token field: check, mask, refusal, expiry warning, Export leaves it out, Remove token |
| `radar-bids.spec.ts` | The Bids tab: totals, status buttons, awards, Export and Import, 380 px |
| `radar-developers.spec.ts` | The developer search, filters, shortlist, delivery cost from a shortlisted developer, 380 px |
| `radar-alerts.spec.ts` | Alerts: permission, one notification per fresh top project, refusal |
| `radar-safety.spec.ts` | R-01 (no unfilled placeholder is copied or placed), R-06 (Place now stops at the monthly limit), R-03 (the rank note) |
| `radar-setup.spec.ts` | R-05 (no unlabelled route to sample data), U-01 (the setup line), U-02 (the export reminder), U-03 (Skill fit names the empty setting) |

Unit tests (Vitest, `pnpm test`, in `apps/web/src/radar/`):

| File | Covers |
|---|---|
| `account.test.ts` | The token: account, format, masking, the 30 days and the 5-day warning; Export carries no token |
| `alerts.test.ts` | Which projects earn an alert |
| `developers.test.ts` | The directory search, filters and order, the shortlist's starting rate |
| `feed.test.ts` | The search URL, reading a project, paging, errors, refresh timing, filters, how amounts and ages read, what the browser keeps |
| `placing.test.ts` | `placeBid` refuses an unfilled placeholder before any call |
| `proposal.test.ts` | The opening price, `{first_line}` (R-02), placeholders left in a text (R-01), `buildProposal`, the bid log and the SAST month |
| `score.test.ts` | The rank score, hand-worked; U-03's reasons; weights; ranking |
| `setup.test.ts` | The export reminder's 7-day rule (U-02) and the setup line (U-01) |
| `tracker.test.ts` | Totals and splits, status buttons, Export and Import, the monthly limit on Place now (R-06) |

## 8. Where this stands

- Pull request #58 (https://github.com/logiagenesis/bpomax/pull/58, branch `claude/new-session-ca8mqi`, from
  `main` at `9dddad0`) adds R-01, R-02, R-03, R-06, R-05, U-01, U-02 and U-03. A commit cannot contain
  the SHA of its own merge, and the checks for the final head cannot be known before that head exists, so
  this file names neither: the merge commit and its checks are listed on that pull request's page.
- Controls with no test, or a test that does not reach them, are marked "none", "No" or "Partly" above and
  are not passed. The ones with no test at all: the storage warning, the shortlist's profile link, and
  the "Use this template first" checkbox.
- Place now is built and tested against the stand-in only. No live bid is known to have been placed with
  it, and nothing has been earned through the software (R0). The first live bid needs the owner's token
  and the owner's decision to bid.
- A screenshot of Radar's live read, dated 27/09/2026, is kept as `docs/audit/radar-live-27-09-2026.png`.

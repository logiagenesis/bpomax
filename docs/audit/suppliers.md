# Control audit — suppliers.html (ARB-200)

Per docs/05 section 1. Every control on the page, and the Playwright test (in
`e2e/suppliers.spec.ts`) that exercises it. The API is an in-memory copy, at the network
edge, of `apps/api/src/routes/suppliers.ts` (tested against real Postgres in
`routes/suppliers.test.ts`): `GET /v1/suppliers`, `GET /v1/suppliers/template.csv`,
`GET /v1/suppliers.csv`, `POST /v1/suppliers/import`; and of `GET /v1/service-categories`.
The rule the page checks a file with is `validateSupplierCsv` from `@arbitron/core`, the
same one the API runs (tested in `packages/core/src/suppliers.test.ts`).

| Control | Label text | Expected action | Actual action | Loading state | Success state | Error state | Disabled state rule | Keyboard reachable | Playwright test name | Pass |
|---|---|---|---|---|---|---|---|---|---|---|
| Link, nav links ×10, Sign out | as dashboard.md | as dashboard.md | `aria-current="page"` on Suppliers | — | — | — | — | Yes | lists suppliers with their rate cards…, and every link goes somewhere | ✅ |
| Button | Refresh | Read the database again | `GET /v1/suppliers` | Spinner, aria-busy, disabled | "Loaded N suppliers." / "No suppliers yet." | "Not signed in…" / "Could not reach the API…" / the API's message | While busy | Yes | lists suppliers…; an empty database says what to do next | ✅ |
| Button | Download the template | Save the CSV template | `GET /v1/suppliers/template.csv`; saved under the name the API gives it | Spinner, aria-busy, disabled | "Downloaded the template. Replace its sample line with your suppliers." | as Refresh | While busy | Yes | Download the template saves the file the API serves | ✅ |
| Button | Export CSV | Save the database as a CSV with the template's columns | `GET /v1/suppliers.csv`; saved under the API's name; row count from `x-export-rows` | Spinner, aria-busy, disabled | "Exported N suppliers." | as Refresh | While busy | Yes | Export CSV saves the database as the API serves it, and says how many | ✅ |
| File input | CSV file | The file to import | Read as text in the browser; wins over the pasted text | — | — | "Choose a file or paste the CSV first." when both are empty | For a viewer the buttons beside it are off | Yes | Import the file sends a chosen file as text… | ✅ |
| Textarea | Or paste the CSV | The file's text, pasted | Used when no file is chosen | — | — | as the file input | — | Yes | a file with problems is refused on the page…; Check the file… | ✅ |
| Button | Check the file | Check every line without writing | The page's own check first (`validateSupplierCsv`); then `POST /v1/suppliers/import` with `dryRun: true` | Spinner, aria-busy, disabled | "The file is fine: N suppliers and M rate cards would be imported." | Every problem listed as "Line N, field: message." and "N lines have problems; nothing was imported."; the API's own list shown the same way | For a viewer (title says so); while busy | Yes | Check the file asks the API to check without writing; a file with problems is refused on the page… | ✅ |
| Button (submit) | Import the file | Write the file, all or nothing | The page's own check first; then `POST /v1/suppliers/import`; the list re-read | Spinner, aria-busy, disabled | "Imported N suppliers and M rate cards (X new, Y updated)." | as Check the file | For a viewer (title says so); while busy | Yes | Import the file sends a chosen file as text, reports the counts and reloads the list; the API's own line problems are shown the same way; a viewer can read and download but not import… | ✅ |
| Link (per supplier) | Profile | Open the supplier's profile page in a new tab | `href` is the stored URL, `rel="noopener"` | — | — | — | Only shown when a URL is stored | Yes | lists suppliers with their rate cards… | ✅ |

Figures (docs/05 section 3): every rate is `formatMoney` of the stored minor units
(`R1 500,00 fixed`, `R350,50 an hour`); quality is the stored score over 100; on-time
is the stored rate as a percentage; the count line is the rows on screen. The import
parses amounts as text into minor units (`parseAmountText`, no float); the export
writes them as `1500.00` so a spreadsheet reads a number and the import reads it back.

Nothing on this page is a destructive action in docs/05 section 1.3's sense: an import
adds and updates suppliers by name and rate cards by category and currency, deletes
nothing, and is one event (`supplier.imported`) with the counts.

Page-level: no session → login with `next`; 401 → login; no horizontal scroll at 380 px.

Rule 6 (keyboard, re-walked for ARB-210): Refresh, Download the template, Export CSV, the
file input, the paste box, Check the file and Import the file are reached with Tab in
that order; both inputs have their labels attached; Check the file works with Enter —
"the controls are reached by keyboard in reading order, labelled, and Check works from
the keyboard".

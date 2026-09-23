# Control audit — templates.html (ARB-340)

Per docs/05 section 1. Every control on the page, and the Playwright test (in
`e2e/templates.spec.ts`) that exercises it. The API is an in-memory copy, at the network
edge, of `apps/api/src/routes/templates.ts` (tested against real Postgres, with each
variant's figures checked against a hand count and raw SQL over the base tables, in
`routes/templates.test.ts`): `GET /v1/templates`, `POST /v1/templates`,
`PATCH /v1/templates/:id`, `POST /v1/templates/:id/variants` and
`PATCH /v1/template-variants/:id`. Every form is checked on the page with
`validateTemplateChange` or `validateVariantChange` from `@arbitron/core`, the API's own
rule, before anything is sent.

| Control | Label text | Expected action | Actual action | Loading state | Success state | Error state | Disabled state rule | Keyboard reachable | Playwright test name | Pass |
|---|---|---|---|---|---|---|---|---|---|---|
| Link, nav links ×11, Sign out | as dashboard.md | as dashboard.md | `aria-current="page"` on Templates | — | — | — | — | Yes | shows each variant’s rate as the API worked it, the template’s total, and every link goes somewhere | ✅ |
| Button | Refresh | Read the templates again | `GET /v1/templates`; the cards rebuilt | Spinner, aria-busy, disabled | "Showing N templates." / "No templates yet." | The API's message | While busy | Yes | shows each variant’s rate…; with no templates, the page says a bid needs one | ✅ |
| Input | Name (new template) | The template's name | Sent as typed; trimmed by the rule | — | — | "Must not be blank." / "Is already used by another template." on the field | Disabled for a viewer | Yes | Create the template checks the fields first…; a name already used comes back on its field | ✅ |
| Select | Category (new template) | General, or one service category | Sent as `categorySlug`; General is none | — | — | "Is not a service category." on the field (API) | Disabled for a viewer | Yes | Create the template checks the fields first… | ✅ |
| Textarea | Description (optional) (new template) | A note on when to use it | Sent as typed; blank is none | — | — | "Must be 500 characters or fewer." on the field | Disabled for a viewer | Yes | Create the template checks the fields first… | ✅ |
| Button (submit) | Create the template | Create it | `POST /v1/templates`; the new card at the top; the form cleared | Spinner, aria-busy, disabled | "Created “X”. Add its first variant below." | The field errors, first field focused; "Some fields need attention…" | Disabled for a viewer, with the reason as its title | Yes | Create the template checks the fields first…; a viewer reads the figures… | ✅ |
| Button (per template) | Edit the template | Open its form | Shows the name, category and description, name focused | — | — | — | Disabled for a viewer | Yes | Edit the template saves the changes…; Edit the template works from the keyboard | ✅ |
| Input, select, textarea (per template) | Name, Category, Description (optional) | The template's fields | Sent with Save | — | — | The field errors on the fields | — | Yes | Edit the template saves the changes… | ✅ |
| Button (submit, per template) | Save the template | Save the changes | `PATCH /v1/templates/:id` with the three fields | Spinner, aria-busy, disabled | "Saved “X”." | The field errors, first field focused | — | Yes (Enter in a field submits) | Edit the template saves the changes…; Edit the template works from the keyboard | ✅ |
| Button (per template) | Cancel | Close the form | Hides it; focus back on Edit the template | — | — | — | Never | Yes | (same handler as the variant form's Cancel) an unsent variant’s words can change; Cancel closes the form | ✅ |
| Button (per template) | Switch the template off / on | Stop or restart drafting from it | `PATCH /v1/templates/:id` `{ active }`; the badge and label change | Spinner, aria-busy, disabled | "Switched off “X”; no bid is drafted from it." / "Switched on “X”; bids are drafted from it again." | The API's message | Disabled for a viewer | Yes | Edit the template saves the changes, and the template can be switched off and on | ✅ |
| Button (per variant) | Edit (named "Edit variant L") | Open the variant form | Label focused; the words disabled with the lock sentence when the variant has been sent | — | — | — | Disabled for a viewer | Yes | a sent variant’s words are locked…; an unsent variant’s words can change… | ✅ |
| Input, textarea (variant form) | Label, Words | The variant's label and words | Sent with Save; the words only when unlocked and changed | — | — | The field errors on the fields; 409 with the lock sentence if the words are sent while locked | Words disabled once sent (D-064) | Yes | a sent variant’s words are locked…; an unsent variant’s words can change… | ✅ |
| Button (submit, variant form) | Save the variant | Save the changes | `PATCH /v1/template-variants/:id` | Spinner, aria-busy, disabled | "Saved variant L." | The field errors / the API's message | — | Yes | a sent variant’s words are locked…; an unsent variant’s words can change… | ✅ |
| Button (variant form) | Cancel | Close the form | Hides it; focus back on the variant's Edit | — | — | — | Never | Yes | an unsent variant’s words can change; Cancel closes the form | ✅ |
| Button (per variant) | Switch off / Switch on (named "Switch off variant L") | Stop or restart drafting from it | `PATCH /v1/template-variants/:id` `{ active }`; the row's state and the card's note change | Spinner, aria-busy, disabled | "Switched off variant L; bids are drafted from the other switched-on variants." / "Switched on variant L; it takes its turn with the others." | The API's message | Disabled for a viewer | Yes | a sent variant’s words are locked…, and a variant can be switched off | ✅ |
| Input, textarea (per template) | Label, Words (Add a variant) | A new variant | Sent with Add | — | — | "Must not be blank." / "Is already used in this template." on the field | Disabled for a viewer | Yes | Add the variant checks its fields… | ✅ |
| Button (submit, per template) | Add the variant | Add it | `POST /v1/templates/:id/variants`; the new row at no data | Spinner, aria-busy, disabled | "Added variant L to “X”." | The field errors, first field focused | Disabled for a viewer | Yes | Add the variant checks its fields…; a viewer reads the figures… | ✅ |

Figures (docs/05 section 3): each rate is shown with its numerator and denominator
("66,7 % (2 of 3)"), and a variant nothing has been sent from says "No data (0 of 0)",
never 0 %. A template's rate adds its variants' sends and replies before dividing (2 of 4
= 50,0 %, not the mean of the variants' rates). The page recalculates nothing.

Page-level: no session → login with `next`; 401 → login; no horizontal scroll at 380 px.
A viewer reads the same figures and every change control is disabled with the reason.
The card's note says how many variants are switched on and whether the template can be
drafted from at all. Demo parity: `e2e/demo.spec.ts` opens the page and adds a variant
against the demo's rules.

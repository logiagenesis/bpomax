# Control audit — approvals.html (ARB-061)

Per docs/05 section 1. Every control on the page, and the Playwright test (in
`e2e/approvals.spec.ts`) that exercises it. The API is an in-memory copy, at the network
edge, of `apps/api/src/routes/proposals.ts` (tested against real Postgres in
`routes/pages.test.ts`): `GET /v1/proposals`, `POST …/:id/approve`, `POST …/:id/reject`,
`PATCH …/:id`, `POST /v1/proposals/bulk`.

| Control | Label text | Expected action | Actual action | Loading state | Success state | Error state | Disabled state rule | Keyboard reachable | Playwright test name | Pass |
|---|---|---|---|---|---|---|---|---|---|---|
| Link, nav links ×5, Sign out | as dashboard.md | as dashboard.md | `aria-current="page"` on Approvals | — | — | — | — | Yes | shows each waiting bid… | ✅ |
| Select | Show | Waiting / approved / sent / rejected / failed / everything | Sends `status=`; address bar updated | — | — | — | Never | Yes | the filter shows other states… | ✅ |
| Button (submit) | Apply filter | Load the list | `GET /v1/proposals?status=` | Spinner, aria-busy, disabled | "Loaded N bids." / "Nothing is waiting for approval." | API message | While busy | Yes | the filter shows other states… | ✅ |
| Button | Refresh | Ask again | Same request | as Apply | as Apply | as Apply | While busy | Yes | refresh asks again | ✅ |
| Checkbox | Select all shown | Select every selectable bid | Ticks every enabled row box; count updated | — | "N selected." | — | When no row is selectable (viewer, or nothing queued) | Yes | select all, then bulk approve… | ✅ |
| Checkbox (per bid) | Select <job> | Add this bid to the selection | Count updated; bulk buttons enabled | — | "N selected." | — | Unless the bid is queued and the person may approve | Yes | one selected bid, bulk rejected…; a viewer sees the queue… | ✅ |
| Button | Approve selected | Confirm, then approve each selected bid | Modal confirmation; `POST /v1/proposals/bulk {action: approve, ids}`; each outcome reported; list refreshed, message kept | Spinner, aria-busy, disabled | "Approved N of M." + "Not done: <job>: <reason>" for any that moved on | API message | Until something is selected; while busy | Yes | select all, then bulk approve after confirming… | ✅ |
| Button | Reject selected | Ask a reason, then reject each selected bid | Modal form (reason required); `POST /v1/proposals/bulk {action: reject, ids, reason}` | as above | "Rejected N of M." + not-done list | API message | as above | Yes | one selected bid, bulk rejected with a reason… | ✅ |
| Button (per bid) | Approve <job> | Confirm, then approve | Modal naming the price and job; cancel sends nothing; `POST …/approve`; approval names the signed-in person (`approved_via = web`, RLS-enforced); the submit worker is handed the bid | Spinner, aria-busy, disabled | "Approved “<job>”. The sender has it." / "…Bidding is paused, so it waits for /resume." | API message | Unless queued and the person may approve (title says why); while busy | Yes | approve asks for confirmation; cancelling sends nothing; approve, confirmed, posts…; when bidding is paused… | ✅ |
| Button (per bid) | Edit <job> | Open the text for editing | Textarea shown with the current words, focused | — | — | — | Unless the person may approve and the bid is not sent | Yes | edit opens the text… | ✅ |
| Textarea | Bid text | The new words | Checked with `validateProposalEdit` (same rule as the API) | — | — | "Must not be blank." / length | as Edit | Yes | edit opens the text, refuses blank words… | ✅ |
| Button (submit) | Save text | Save the new words | `PATCH /v1/proposals/:id {body}`; bid back to queued with its approval cleared; list refreshed, message kept | Spinner, aria-busy, disabled | "Saved the new text for “<job>”. It needs approval again." | API message; field error attached | While busy | Yes | edit opens the text… | ✅ |
| Button | Cancel | Discard the edit | Original text back, editor closed, focus returned to Edit | — | — | — | Never | Yes | cancelling an edit puts the original text back | ✅ |
| Button (per bid) | Reject <job> | Ask a reason, then reject | Modal form; empty reason keeps the dialog open; `POST …/reject {reason}` | Spinner, aria-busy, disabled | "Rejected “<job>”." | API message | Unless the person may approve and the bid is neither sent nor already rejected | Yes | reject asks for a reason, will not take an empty one, and records it; cancelling a rejection sends nothing | ✅ |

Figures (docs/05 section 3): price, days and milestone count; score with verdict; the
estimate with its method; the projected margin in the deal currency with its percentage,
and in rand at the rate the evaluation stored, with that rate's timestamp
(`USD 500,00 (33,333%) · R9 061,73 in rand at the rate of 21/09/2026 16:00`); the
conversion is whole-number arithmetic rounded half up, worked in the test. A sent bid
shows who approved it and via which channel.

Destructive actions (docs/05 section 1.3): Approve (single and bulk) asks for
confirmation and is logged by the API as `proposal.approved` naming the person; Reject
asks for a reason and is logged as `proposal.rejected` with it. A paused org is shown
with a banner and in the approval message.

Page-level: no session → login with `next`; 401 → login; no horizontal scroll at 380 px.

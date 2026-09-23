# Control audit — privacy.html (ARB-015)

Per docs/05 section 1. Every control on the page, and the Playwright test (in
`e2e/privacy.spec.ts`) that exercises it. The page needs no sign-in. It reads
`privacy-notice.json` from beside itself, checks it with `parsePrivacyNotice` from
`@arbitron/core`, and shows the owner's approved wording, or says the notice is pending
(docs/02 T-06). It writes no wording of its own (D-040).

| Control | Label text | Expected action | Actual action | Loading state | Success state | Error state | Disabled state rule | Keyboard reachable | Playwright test name | Pass |
|---|---|---|---|---|---|---|---|---|---|---|
| Link | Arbitron | Go to the landing page | Goes to index.html | — | — | — | Never | Yes | the brand link and the sign-in link go where they say | ✅ |
| Link | Sign in | Go to the sign-in page | Goes to login.html | — | — | — | Never | Yes | the brand link and the sign-in link go where they say | ✅ |

States, each with its test:

- **Pending** (the committed file): "This notice has not been published yet…" names T-06;
  no wording and no approval line are shown. Test: "the committed notice is pending…".
- **Approved:** each section is a heading with its paragraphs, under "Version v, approved
  by X on DD/MM/YYYY." Test: "approved wording is shown section by section…".
- **Invalid file** (for example, pending with wording in it, or approved without a date):
  nothing from the file is shown, and the status says "The published privacy notice is
  incomplete, so none is shown. The site owner needs to correct it." Test: "a pending
  file that carries wording is refused…".
- **Unreachable:** "The privacy notice could not be loaded (…). Reload the page to try
  again." Test: "a notice that cannot be loaded is reported with what to do".

Page-level: every link is a real page of this app; no horizontal scroll at 380 px; UK
English; the approval date is DD/MM/YYYY. The login page and the landing page link here.

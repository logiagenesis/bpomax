# Control audit — style-guide.html (ARB-060)

Per docs/05 section 1. Every control on the page, and the Playwright test (in
`e2e/style-guide.spec.ts`) that clicks it and checks the result.

| Control | Label text | Expected action | Actual action | Loading state | Success state | Error state | Disabled state rule | Keyboard reachable | Playwright test name | Pass |
|---|---|---|---|---|---|---|---|---|---|---|
| Link | Arbitron | Go to the home page | Goes to index.html | — | — | — | Never | Yes (first Tab stop, focus ring checked) | every link goes somewhere; the first Tab stop is the brand link | ✅ |
| Nav links ×5 | Colours, Buttons, Forms, Data, Feedback | Jump to the section | Jumps; section in viewport | — | — | — | Never | Yes | every link goes somewhere | ✅ |
| Link | like this | Jump to Typography | Jumps to #type | — | — | — | Never | Yes | every link goes somewhere | ✅ |
| Button | Save example | Simulated save | Busy + disabled, then success message | Spinner, aria-busy, disabled | "Saved. This is an example: nothing was stored." | — | While busy | Yes | primary button shows a loading state, then success | ✅ |
| Button | Show an error | Simulated failed save | Busy, then error message | Spinner, aria-busy, disabled | — | "Could not save: … Try again." | While busy | Yes | a failing action says what happened and what to do next | ✅ |
| Button | Delete example | Destructive action with confirmation | Opens dialog; Cancel/Escape keep, Delete confirms | — | "Deleted. …" | "Cancelled. Nothing was deleted." | Never | Yes; dialog focuses Cancel | delete asks for confirmation; cancel keeps, confirm deletes | ✅ |
| Button | Reset form | Clear the form and errors | Clears values and errors, says so | — | "The form has been reset." | — | Never | Yes | reset clears the form and its errors | ✅ |
| Button (disabled) | Submit bid | Shows the disabled style | Cannot be pressed; described by the reason | — | — | — | Always (example of the rule: the reason is its accessible description) | Not focusable, by design | the disabled button cannot be pressed and says why | ✅ |
| Inputs | Scanner name, Daily cap | Validate on submit | Errors attached with aria-describedby; first invalid field focused | — | — | Field-level messages | — | Yes | the form validates, focuses the first problem, and accepts good input | ✅ |
| Select / textarea / checkbox | Category, Notes, Active | Accept input | Accept input; included in the valid submit | — | — | — | — | Yes | the form validates, … | ✅ |
| Input (disabled) | Locked field | Shows the disabled style | Disabled | — | — | — | Always | No, by design | the form validates, … | ✅ |
| Button | Check the form | Submit and validate | Errors, or a success summary | — | "The form is valid: …" | "Some fields need attention…" | Never | Yes | the form validates, … | ✅ |
| Switch | Live mode | Confirm to turn on; turn off without asking | As expected; badge follows | — | Badge "Live" | Cancel leaves it off | Never | Yes | live mode needs confirmation to turn on, none to turn off | ✅ |

Page-level: no horizontal scroll at 380 px (test "at 380 px wide…"); visual snapshots at
1280 px and 380 px; every class in `components.css` present (test "every class…").

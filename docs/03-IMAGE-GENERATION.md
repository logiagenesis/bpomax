# 03 — IMAGE GENERATION (owner produces)

Document: LI-IMG-ARB-0926 v1.0 — 22/09/2026

Owner generates these and drops them into `/brand-assets/` in the repo using the exact file names below. Claude Code uses placeholders until the real files arrive and must not generate its own versions.

Dependency: the product name (02-BLOCKERS D-01) is undecided. Everything below uses the working name ARBITRON. If the name changes, regenerate items 1–4 and 9.

Palette: primary Logi-Ink cyan (confirm hex, D-11), background near-black #0B0F14, surface #121820, text #E6EDF3, accent success #2BD576, warning #F5B400, danger #FF5A5F. Style: clean, technical, angular, flat vector. No 3D, no gradients-heavy, no stock people, no text other than the product name where stated.

| # | Asset | File name | Size / format | Where used | Prompt |
|---|---|---|---|---|---|
| 1 | Primary logo, horizontal | `logo-horizontal.svg` + `logo-horizontal.png` | SVG + PNG 1600×400 transparent | App header, README, emails | Flat vector logo for a software product named "ARBITRON". Angular geometric mark on the left built from two interlocking chevrons forming a flow from left to right, suggesting routing work between two points. Wordmark "ARBITRON" in a bold geometric sans-serif, uppercase, generous letter spacing. Mark in cyan (#00C2FF), wordmark in off-white (#E6EDF3). Transparent background. No gradients, no shadows, no taglines. |
| 2 | Logo mark only | `logo-mark.svg` + `logo-mark.png` | SVG + PNG 1024×1024 transparent | Favicon source, app icon, Telegram avatar | Same angular two-chevron mark as the ARBITRON logo, centred alone on a transparent square canvas, cyan #00C2FF, flat vector, no text, balanced padding of about 15% on all sides. |
| 3 | Logo on dark, stacked | `logo-stacked-dark.png` | PNG 1200×1200 | Social profiles, login screen | ARBITRON angular chevron mark above the wordmark, centred, on solid #0B0F14 background, mark cyan #00C2FF, wordmark #E6EDF3, flat vector. |
| 4 | Favicon set | `favicon.ico`, `favicon-32.png`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png` | ICO 16/32/48; PNG 32, 180, 192, 512 | Browser tabs, PWA | Export from item 2 on #0B0F14 rounded square for the PNG app icons; transparent for favicon.ico. |
| 5 | Telegram bot avatar | `telegram-avatar.png` | PNG 640×640 | @BotFather /setuserpic | Item 2 mark centred on solid #121820 circle-safe square. |
| 6 | Open Graph share image | `og-image.png` | PNG 1200×630 | Link previews of the web app | Dark #0B0F14 background, ARBITRON horizontal logo top-left, a minimal abstract line diagram on the right showing three nodes connected left to right (job → brief → supplier) in cyan thin strokes. No other text. |
| 7 | Empty-state illustration: no jobs | `empty-feed.svg` | SVG, 480×320 viewBox | Feed page with no results | Minimal line illustration, cyan #00C2FF strokes on transparent, a radar sweep circle with no blips. Flat, 2 px strokes, no text. |
| 8 | Empty-state illustration: no suppliers | `empty-suppliers.svg` | SVG, 480×320 viewBox | Suppliers page with no records | Minimal line illustration, cyan strokes on transparent, a globe outline with three empty map pins. Flat, 2 px strokes, no text. |
| 9 | README banner | `readme-banner.png` | PNG 1600×400 | Top of GitHub README | Dark #0B0F14 background, ARBITRON horizontal logo left, thin cyan circuit-line pattern fading to the right. No other text. |

Checks before dropping files in (owner):
1. File names exactly as listed.
2. SVGs open in a browser and contain no embedded raster images.
3. PNG backgrounds transparent where stated.
4. No spelling errors in the wordmark.
5. Commit to the repo under `/brand-assets/` or place in the Drive folder for Claude Code to pick up.

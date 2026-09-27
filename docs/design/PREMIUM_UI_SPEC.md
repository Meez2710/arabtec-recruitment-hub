# Arabtec Recruitment Hub — premium UI specification (v1, for owner review)

One page. What stays, what changes, and the exact values. The Figma file
"Arabtec Workforce UI Direction" shows the same decisions on four screens.
Nothing here changes a business rule; it changes how the same screens read.

## Figma
https://www.figma.com/design/r9MKEUcN99XS4wOhLMP061

| Page | Frame | Node |
|---|---|---|
| 01 Foundations | Colour roles, type ramp, buttons, input, badges, stat tiles, hint, table, knowledge line | `3:3` |
| 02 Screens | Dashboard · Director view (system admin default, view tabs) · 1440 | `5:2` |
| 02 Screens | Hiring request · Workspace (approval status, pipeline board, bulk bar, side rail) · 1440 | `6:2` |
| 02 Screens | Candidate profile (application context, screening, activity, side rail) · 1440 | `7:2` |
| 02 Screens | Candidate profile · Phone 390 | `7:200` |

The mocks use Inter for display because Inter Tight is not installed in the
Figma workspace; the product loads Inter Tight from Google Fonts as specified
below. The logo in the mocks is the real `arabtec-logo.svg` vector.

## Keeps (owner's instruction)
- Company colours: brand red `#D01827` (`--brand`), product green `#008064` / `#00664F` (`--green`, `--green-700`), ink `#1A1A1A`, muted `#6F6A64`, canvas `#F4F5F7`, card white.
- Logo, wordmark and favicon as they are. The logo is never an icon, spinner or avatar.
- Every existing workflow, permission and label.

## The look in one line
Quiet, corporate, precise: white cards with hairline borders on a cool grey canvas, a charcoal sidebar, one green primary action per view, red used only as a hard edge (eyebrow dash, top rule, critical state), tight display headings over small tracked labels, and generous space between groups with tight space inside them.

## Colour roles
| Role | Token | Use |
|---|---|---|
| Primary action, active nav, success | `--green-700` / `--green` | one solid green button per view; green ink for links and selected tabs |
| Brand edge | `--brand` | 6px page top rule, 2×18px eyebrow dash, red full stop on display headings, critical badges only |
| Sidebar | `--ink` (`#1A1A1A`) | charcoal, items at 70% white, active item white with a 3px red bar and 6% white surface |
| Text | `--ink`, `--muted` | body ink, secondary muted; `#8A93A3`-class greys for disabled only |
| Lines | `--line` | 1px hairlines everywhere; no shadows on cards (one soft shadow allowed on floating pills and menus) |
| Semantic | success green, warning amber `#B45309`, info blue `#1D4ED8` | badges and health, never as decoration |

Red stays under 5% of any screen. Green is the working colour.

## Type
Inter Tight 700/800 for display; Inter 400/500/600 for everything else (Google Fonts, with Arial fallback).

| Use | Size / weight / tracking |
|---|---|
| Page title | 28px / 800 / −0.02em, line 1.1 |
| Card title | 17px / 600 / −0.01em |
| Body and UI | 14px / 400, line 1.5 |
| Table cell | 13.5px; numbers `tabular-nums`, right-aligned |
| Meta | 12.5px muted |
| Eyebrow | 11px / 700 / 0.18em uppercase muted, preceded by the red dash |

Every page title carries its eyebrow (the crumb becomes the eyebrow). Body copy never exceeds 68 characters per line.

## Shape and space
- Radius: 10px cards, inputs and buttons; 6px badges; pills only for avatars and the view toggle. (Today: 20px cards and 999px inputs. This is the single biggest "consumer app" signal to remove.)
- Spacing scale 4 · 8 · 12 · 16 · 24 · 32 · 48. Card padding 24 (compact 16). Page gutter 24. Section gap 24. KPI tiles 16 apart.
- Controls 40px tall on desktop, 44px on phone. Buttons: primary green fill; secondary white with 1px border; ghost transparent.
- Tables: uppercase tracked header on `#F5F5F5`, 52px rows, hairline row borders, no zebra, no vertical rules, first column strong.
- Empty state: 24px line icon → 17px heading → one muted line → one button, centred, 48px padding.

## New reusable pieces
- **Eyebrow** (`.eyebrow`): red dash + tracked label. Used above every page title and card group title.
- **Hint** (`.hint`): a one-line helpful note with a 2px green left bar, muted text, optional "Learn more". For facts the product can vouch for ("A request cannot be assigned until it is approved."). Never for opinions.
- **Knowledge line** (shipped): the attributed sentence at the foot of every page.
- **Stat tile**: 32px display number, eyebrow label beneath, one muted meta line, dash when unavailable.

## Layout
Desktop: 256px charcoal sidebar, 64px white top bar with hairline, content on canvas at 24px gutters, 1280px max content width, page head (eyebrow, title, one muted line, actions right), then stat row, then cards. Phone: the existing phone shell; cards full-width with 16px gutters; controls 44px; one action row per card.

## What changes in code (after approval)
1. One new stylesheet layer `arabtec-workforce.css` loaded last: tokens, radius, type, sidebar, tables, buttons, badges, eyebrow, hint, stat tile. No page logic.
2. `PageHead` renders the eyebrow; `KpiCard` adopts the stat tile; `Empty` adopts the new empty-state metrics. Small JSX, no behaviour change.
3. Screen-by-screen review against the Figma frames at 1280, 1440 and 390, each guarded by the layout-rules test.

## Not in scope
Logo or favicon changes, new colours, animation beyond 150ms state transitions, illustrations, and any change to HR rules or workflow.

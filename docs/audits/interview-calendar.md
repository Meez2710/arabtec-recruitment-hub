# Pattern audit — Interview calendar

Date: 28 Sep 2026. Method: `.claude/skills/ats-pattern-consistency-audit`.
Question: before adding a Day / Week / Month calendar as the first screen of
Interviews, what already solves each part of it, and what should be reused?

## Findings

| Need | Existing surface | Where | Variant | Resolves in cascade | Reach | Decision |
|---|---|---|---|---|---|---|
| Switch between views | `ViewToggle` | `app.jsx` (Talent Pool, Pipeline, Requests) | `.view-toggle` / `.view-toggle-btn` pill track | yes (`arabtec-design-system.css`, phone rules in `arabtec-mobile.css`) | every list page | **Reuse.** One toggle: Day · Week · Month · List (Day · List on phones). |
| Page header actions | `PageHead actions` | every page | badge + toggle + primary button | yes | all | **Reuse**; the toggle sits where the other pages put theirs, so the phone rule `.page-head-actions > .view-toggle` applies unchanged. |
| Filters | `FilterToolbar` + status `select` | Interviews list | shared toolbar | yes | Interviews | **Reuse** for both views; the list-only "This week" switch is hidden in calendar views (the week *is* the view). |
| Interview status meaning | `IV_STATUS` + `IvStatusBadge` | Interviews | `Badge` variants | yes | Interviews, candidate profile | **Reuse the vocabulary** (`IV_STATUS[..].label` on each non-scheduled block). Blocks need a filled, edge-marked shape a badge cannot give, so they get `.cal-s-<status>` paint from existing tokens (`--action`, `--warning`, `--danger`, `--line-strong`). |
| Upcoming-interview card | `EventCard` (`.event`) | dashboards | text card | yes | dashboards | Not reused: a list card, not a positioned block. |
| Warning inside a form | `.notice.notice-warn` | Notifications, Pipeline, Requests | left-edge notice | yes | admin + recruiters | **Reuse** for the panel clash warning. |
| Page guidance | `Hint` | premium layer | `aside.hint` with emoji | yes | all | **Reuse** for "click any open half hour". |
| Phone detection | `useIsPhone()` (900px) | shell, Talent Pool, Pipeline | hook | n/a | all | **Reuse**; no second breakpoint. |
| Date helpers | `timeOf`, `fmtWhen`, `daysUntil`, `isToday` | dashboards, Interviews | local-time presentation | n/a | all | **Reuse** `timeOf`/`fmtWhen`; the week arithmetic is new (`cal*` helpers) because nothing did Saturday-first weeks. |
| Chevrons | `ICON_MARKS.chevronDown/Up` | sort, menus | 24-viewBox stroke marks | n/a | all | **Extend** with `chevronLeft/Right` in the same geometry. |
| A calendar | — | — | — | — | — | None existed. New: `InterviewCalendar`, `CalTimeGrid`, `CalMonth`, `CalDayStrip`. |

## Stylesheet placement

The six-stylesheet contract (`ui_gallery_test`) is unchanged. Geometry went
to `claude-system.css`, paint to `arabtec-design-system.css`, and the phone
rail to `arabtec-mobile.css`, following the split `ui_overlays_test` enforces
for `claude-system.css`. No new colour literal: every paint rule references
an existing token. Cache token bumped to `20260928a` in both `index.html` and
`component-gallery.html`.

## Migration list

None. Nothing existing solves this differently, so nothing moves.

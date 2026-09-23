---
name: ats-pattern-consistency-audit
description: Before adding or redesigning ANY screen, control or flow in the Arabtec ATS, find every existing surface that already solves the same problem and recommend which pattern to reuse. Use when proposing a new filter, badge, table, modal, empty state, form control or page layout — and before any UI "polish" change.
---

# Pattern consistency audit (Arabtec ATS)

Adapted from the Claude Academy "Pattern consistency audit" use case. The ATS
has already paid for inconsistency: two different CV Intake pages existed on two
branches, and a local `Pill` emitted a `badge-danger` class the consolidated
palette never defined. Find what exists before building anything new.

## Inputs — the ATS has no Figma or analytics, so use what it does have
- `frontend/public/app.jsx` and the modules `cv-intake.jsx`, `intake-review.jsx`,
  `org-structure.jsx`, `email-settings.jsx`
- The six stylesheets, in load order: `styles.css` → `arabtec-approved-ui.css` →
  `arabtec-design-system.css` → `claude-system.css` → `arabtec-responsive.css` →
  `arabtec-mobile.css`
- `frontend/public/component-gallery.html` — the living component inventory
- Usage signal instead of Amplitude: `audit_log` action counts on production
  (read-only), and which roles can reach each surface (`backend/src/lib/permissions.js`)

## Method
1. **Name the variants.** List every visual approach to the interaction
   (e.g. for status: `<Badge>`, `StatusBadge`, raw `span.badge-*`, local helpers).
2. **Find every instance.** `grep` the JSX and CSS; include the phone shell.
3. **Record ownership and reach** — which page, which roles, which component.
4. **Compare side by side** — a table: surface, file:line, variant, classes used,
   whether the class resolves in the cascade, who can see it.
5. **Recommend one pattern to reuse** and list the surfaces that should migrate.
   A class that does not resolve in the cascade is a defect, not a variant.

## Output
`docs/audits/<pattern-name>.md` with the comparison table, the recommendation,
and the migration list. Change nothing in the same pass — the audit is the
deliverable; migrations follow as their own commits.

# Arabtec ATS UI Readiness Design

## Goal

Ship a production-safe visual stabilization of the current Arabtec Recruitment Hub today. Improve clarity, alignment, responsive behavior, and interface resilience without changing recruitment workflows, permissions, database behavior, or the deployment topology.

## Production surface

The deployed interface is `frontend/public/`, served by `backend/src/server.js`. `frontend-v2/` is not part of the live application and will not be changed.

## Release boundary

This release will:

- Add a React error boundary around the authenticated application surface.
- Establish a clear filled primary action and a distinct destructive action while reserving red for brand and risk states.
- Normalize button height, padding, text wrapping, and icon alignment through the effective last-loaded stylesheet.
- Repair responsive KPI grids, tables, page actions, drawers, modals, and major administrative layouts at desktop, tablet, and mobile widths.
- Raise Candidate Intake typography to a readable scale.
- Correct the Roles page selected-state contrast.
- Make empty and error states visually distinct and render the icon requested by each empty state.
- Improve the shared modal's semantics, keyboard closing, initial focus, focus restoration, and labelled close control.
- Bump frontend cache query versions so Render clients receive the release immediately.

## Implementation approach

Keep the existing three stylesheet files and their load order. Apply targeted additions to `arabtec-design-system.css`, the effective last-loaded layer, and surgical JSX changes in `app.jsx` and `intake-review.jsx`. Avoid broad cascade cleanup today because the current interface depends on source order and runtime branding overrides.

Where a defect is structural, add the smallest reusable behavior needed in the existing monolithic SPA. Do not attempt the complete primitive migration or stylesheet collapse in this release.

## Safety constraints

- No backend route, request or response shape, database schema, seed data, permissions, salary masking, candidate scope, upload behavior, or feature flag changes.
- No changes to `render.yaml`, production secrets, CORS, CSP, JWT settings, or Render resources.
- No changes to CV parsing, AI actions, email, offer-letter content, or tenant plumbing.
- No merge directly to `main`; deliver a reviewable GitHub branch and pull request.
- Run the same backend build Render executes before testing.

## Verification

- Add source-level regression tests for the error boundary, modal accessibility, responsive table coverage, cache-bust versions, and key CSS readiness rules.
- Run each new test red before implementation and green afterward.
- Run `npm run build`, the full backend test suite, and static-serving checks.
- Start the seeded local application and inspect representative recruiter and administrator routes at 1440, 900, and 375 CSS pixels.
- Confirm no horizontal page clipping, unreadable actions, white-screen regressions, or broken core navigation.

## Deferred work

The full component primitive migration, three-stylesheet consolidation, assistant operator, product rebranding, and multi-tenancy remain separate releases. They carry materially higher regression risk and are not required for today's Arabtec production stabilization.

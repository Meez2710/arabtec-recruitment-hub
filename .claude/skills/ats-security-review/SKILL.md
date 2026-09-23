---
name: ats-security-review
description: Review the Arabtec ATS codebase and on-prem deployment for security vulnerabilities, triage them by severity, and produce targeted patches. Use for a security audit, before a release, after adding a route or upload path, or when asked whether the ATS is secure.
---

# Security review (Arabtec ATS)

Adapted from the Claude Academy "Getting started with Claude Security" tutorial.
Claude Security itself needs org-admin setup (Claude GitHub App, premium seats,
admin-console activation) — if that is not in place, run this local method.

## Scope — highest risk first
1. **Auth and RBAC** — every route in `backend/src/routes/*.js` sits behind
   `requireAuth` / `requirePermission`; unauthenticated calls return 401.
2. **Injection** — SQL built by concatenation. Check the `LIKE ?` filters in
   `backend/src/lib/models.js`: user input must be a bound parameter, and `%`/`_`
   inside a value must not widen the match unexpectedly.
3. **Uploads** — `multipart` handling, file-type allow-list, 20 MB cap, stored
   names never taken from the client, no path traversal in `uploadPath()`.
4. **Secrets** — `backend/.env` and `/etc/arabtec-ats/ats.env` are never logged;
   report configuration as SET/MISSING only. Tokens at rest are encrypted with
   `MICROSOFT_TOKEN_ENCRYPTION_KEY` — never rotate it without a re-encrypt plan.
5. **Transport** — the ATS is served over plain HTTP on :4001; HSTS over HTTP is
   meaningless. TLS belongs at the Apache vhost.
6. **Dependencies** — `npm audit --omit=dev` in `backend/`.
7. **Dynamic scan** — run HawkScan (`hawkscan:hawkscan`) when `HAWK_API_KEY` is set.

## Triage
Severity: critical · high · medium · low. For each finding: type, file:line,
how it is reached, and a proof (a request or test that demonstrates it). Dismiss
only with a written reason. No finding is "fixed" until a test fails without the patch.

## Output
`docs/audits/security-<date>.md`, then one commit per fix, each with its test.

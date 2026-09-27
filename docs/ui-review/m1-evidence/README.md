# M1 — Honest loading and recovery: browser evidence

Captured on a loopback-only local instance with synthetic seed data (no company
data, mailbox, email or paid parsing involved). Failures were injected by
intercepting the named API call and answering HTTP 500 with a JSON error, at
1440×900 (desktop) and 390×844 (phone).

| Capture | Scenario |
|---|---|
| `desktop-dash-requests-fail`, `phone-dash-requests-fail` | `/requests` fails, `/interviews` loads. One notice names the failed list and the server reason; request-only figures show a dash, request-only sections say they did not load, mixed lists keep their interview rows with a caveat. No "all clear". |
| `desktop-dash-interviews-fail` | `/interviews` fails, `/requests` loads. Roles render; interview-dependent tiles and queues are marked. |
| `desktop-dash-stale-refresh` | First read succeeds, a later refresh of `/requests` fails. Rows and figures stay; the notice says they may not be current. |
| `desktop-candidate-fail`, `phone-candidate-fail` | `/candidates/:id` fails on first open. Explicit error with Retry; the way back stays available. |
| `desktop-assessment-fail`, `phone-assessment-fail` | `/assessments/meta` fails inside the pipeline drawer. Explicit error with Retry instead of an endless skeleton. |

Retry recovery for each case was asserted in the same run (text of the loaded
record appears, error text disappears) and is covered by `backend/ui_behavior_test.mjs`.

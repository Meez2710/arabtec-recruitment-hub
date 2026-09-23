---
name: ats-bug-fix-pr
description: Take a reported Arabtec ATS bug from report to a draft pull request — reproduce, diagnose the root cause, fix, prove the fix with a test, open a draft PR and check CI. Use for any bug report, regression, "it's broken", or production incident on the ATS.
---

# Bug fix with a draft PR (Arabtec ATS)

Adapted from the Claude Academy "Fix a reported bug with a draft PR" use case.

## Steps
1. **Reproduce first.** Write the failing test before touching the code. If it
   cannot be reproduced, say what was tried — never "fix" a guess.
2. **Diagnose the root cause**, and say it in one sentence. The quick fix at the
   symptom is not the fix (the 11.5 px button needed a shared token, not a new number).
3. **Fix** at the right layer, matching the surrounding code's idiom and comment density.
4. **Prove it.** Revert the fix and confirm the new test fails, then restore it.
   A test that passes either way is not a test.
5. **Run the full suite:** `cd backend && node --experimental-sqlite run_tests.mjs`.
   Any UI change also needs `ui_compile_test.mjs` and a cache-token bump in
   `index.html` and `component-gallery.html`.
6. **Open a draft PR** against `main` — never against a side branch production
   does not track. The body states the symptom, root cause, fix, and proof.
7. **Check CI** with the PR status tools, not by polling `gh`.

## Never
- Merge with a squash when reuniting branches — it breaks the ancestry that the
  containment check relies on.
- Deploy from the PR. Deploying is a separate, explicitly approved step
  (see `ats-launch-readiness`).

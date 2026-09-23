---
name: ats-launch-readiness
description: Produce a red/yellow/green go/no-go call for an Arabtec ATS release or production deploy, with an owner on every line and the blockers named. Use before ANY deploy to 10.20.0.9, before announcing a feature to the HR team, or when asked "is it ready".
---

# Launch readiness sweep (Arabtec ATS)

Adapted from the Claude Academy "Launch readiness sweep" use case. A checklist
without an owner on every line is a wish list.

## Inputs
- The diff being shipped (`git diff <deployed>..<candidate>`)
- `docs/CV_INTAKE_DEPLOYMENT_HANDOFF.md` and any other handoff in `docs/`
- Production state, read-only: `git rev-parse HEAD` on the host, row counts,
  `/api/health/ready`, recent `journalctl -u arabtec-ats` errors
- Prior deploy history — read it, it repeats

## Mandatory gates — each is RED if it fails
1. **Containment.** `git merge-base --is-ancestor <deployed-sha> <candidate-sha>`
   must pass. On 20 Sep 2026 a deploy from `main` silently rolled back CV
   auto-ingest because `main` never contained the production branch. Never again.
2. **Clean tree on the host** — no modified tracked files.
3. **Fresh backup outside the checkout**, verified with `pg_restore --list`.
4. **Full test suite green**, and CI green on the PR.
5. **Schema changes additive only** — no DROP, TRUNCATE or destructive DELETE.
6. **No seed, reset, demo or import script** anywhere in the plan.

## Method
1. List every item, its status (R/Y/G) and a named owner (the user, IT, the
   recruitment team, or the agent).
2. Compare against prior deploys: 14 Sep (Graph `$select` and device-code
   fixes), 17 Sep (auto-ingest; a `limit: 0` script parsed 15 CVs unasked),
   20 Sep (the two-branch rollback), 23 Sep (reunification). Say what repeats.
3. Give one overall call, and name each blocker — never "some concerns".

## Output
A table (item · status · owner · evidence), the overall call, the named
blockers, and the lessons from history that apply to this release.

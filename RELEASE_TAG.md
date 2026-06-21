# Repository Labels / Release Tags

| Tag | Commit | State |
|-----|--------|-------|
| `phase-3-closed` | `ee9a60a` | Phases 1–3 delivered; Phase 3 QA accepted; 146/146 tests passing. |
| `phase-4-closed` | `896a99e` | Phases 1–4 delivered; Phase 4 QA accepted; **214/214 tests passing**. |

## Where the tagged history lives
The mounted output folder does not permit git's internal object writes, so the full git
history (with the annotated tags) is preserved as **git bundles** in this folder:

```
arabtec-recruitment-hub_phase-3-closed.bundle
arabtec-recruitment-hub_phase-4-closed.bundle   ← latest
```

To restore the latest tagged repository on your machine:
```bash
git clone arabtec-recruitment-hub_phase-4-closed.bundle arabtec-recruitment-hub
cd arabtec-recruitment-hub
git checkout phase-4-closed     # the Phase 4 closure snapshot
git tag                         # both phase-3-closed and phase-4-closed are present
```

## Verified at Phase 4 closure
- 46 files tracked; `PHASE4_SUMMARY.md` and `PHASE4_QA_AUDIT.md` committed (alongside all prior phase docs).
- No `.DS_Store`, scratch `dbg*.mjs`, `.env`, `node_modules`, `*.db` / `*.db-journal`, or `data/` files committed (`.gitignore` enforced).
- Annotated tag message: "Phase 4 closed and QA-accepted. 214/214 tests passing. Phase 5 (Offers & Joining) not started."

## Roadmap (governance)
- **Phase 5 = Offers & Joining** (not started)
- **Phase 6 = Dashboards** (not started)

> Note: `.DS_Store`, `dbg*.mjs`, `.env`, and `*.db` files may still exist on disk in the working
> folder (created by earlier tooling / runs and locked by the sandbox), but they are git-ignored and
> are NOT part of any committed snapshot or bundle.

# Arabtec Recruitment Hub — Workable-inspired upgrades (deploy)

Upload these **5 files** to GitHub at the **exact same paths** shown below, then Render will redeploy.

## Files & repo paths

| Upload this file | To this path in the repo |
|---|---|
| `frontend/public/app.jsx` | `frontend/public/app.jsx` |
| `frontend/public/styles.css` | `frontend/public/styles.css` |
| `frontend/public/index.html` | `frontend/public/index.html` |
| `backend/src/lib/models.js` | `backend/src/lib/models.js` |
| `backend/src/routes/requests.js` | `backend/src/routes/requests.js` |

The folder structure in this package mirrors the repo, so on GitHub you can use
**Add file → Upload files** and drag the whole `frontend` and `backend` folders in —
GitHub preserves the paths. Commit message suggestion:
`Workable-inspired upgrades: pipeline funnel, candidate board, reports, profile header + off-white fix`

## How to deploy on Render
After committing on GitHub: Render dashboard → the service → **Manual Deploy → Deploy latest commit**
(the auto-deploy webhook has been unreliable, so trigger it manually).

## What changed (ticket model kept intact)

1. **Pipeline funnel mini-bar on request cards** — each request card now shows total
   candidates and a proportional stacked bar across stages (Sourced → Joined), Workable-style.
   - Backend: `Applications.stageCountsByRequest()` + `pipeline` field on the requests list response.

2. **Candidate board** — new Board/Table toggle, source-attribution segmented tabs with live
   counts (All / LinkedIn / Careers / Referral / Agency / Direct), and colored source chips.
   Per-request pipeline now shows a **Qualified / Disqualified** split strip.

3. **Reports page** (new nav item under Overview) — Hiring Funnel with stage-to-stage
   conversion %, Requests-by-status, Requisition aging, Offer outcomes, Recruiter load,
   plus **Export CSV**. Built entirely on the existing dashboard data (no new backend load).

4. **Layout & design refresh** — tabbed candidate profile header (avatar, headline, meta +
   source chips over the existing record); refined KPI/card rhythm; consistent chip system.

Also included: the **off-white background fix** (page background now owned by the stylesheet;
stale branding values can no longer override it) and a **CSS cache-bust** (`?v=20260628-wk1`)
so browsers pull the new styles immediately.

## Verification done
- `app.jsx` compiles cleanly via Babel (231,780 bytes).
- `models.js` and `requests.js` pass `node --check`.
- End-to-end: booted the server, linked candidates to a request — the `pipeline` field
  returned `{"total":2,"byStage":{"matched":1,"sourced":1}}`; candidate sources flow through.

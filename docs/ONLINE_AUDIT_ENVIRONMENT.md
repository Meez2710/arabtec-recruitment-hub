# Arabtec ATS — Online Audit / UAT Environment

**Environment name:** `arabtec-audit`
**Purpose:** an experienced recruiter or hiring professional auditing the real
product — workflow, recruitment logic, UX and usability.

**This is not production, and it is not a sales demo.** It is a throwaway
environment holding invented data, so an auditor can use the actual application
rather than look at screenshots.

---

## 1. Status

> **The environment is prepared but NOT YET LIVE.**
> Everything needed to bring it up is committed on `audit/arabtec-pilot-online`
> and has been verified end to end locally. The final step — creating the Render
> service — requires Render dashboard access, which the deploying engineer must
> perform once. §3 is that step.
>
> Fill in the URL below once the service is created. **Do not circulate this
> document to an auditor until the URL is real.**

| | |
| --- | --- |
| **URL** | `https://arabtec-audit.onrender.com` *(expected name — confirm after creation)* |
| **Branch** | `audit/arabtec-pilot-online` |
| **Based on** | `pilot/arabtec-ats-v1` @ `b3018fa` |
| **Database** | `arabtec-db-audit` — separate instance, synthetic data only |

---

## 2. What is and is not production

| | Production | This audit environment |
| --- | --- | --- |
| Service | `arabtec` (branch `main`) | `arabtec-audit` (branch `audit/arabtec-pilot-online`) |
| Database | `arabtec-db` | `arabtec-db-audit` — **different instance** |
| Data | Real | **Synthetic only** |
| Demo users | Not seeded | Seeded, shared password |
| Email | Configurable | **Off** — cannot email anyone |
| Error reporting | Sentry | **Off** |
| Auto-deploy | On | **Off** — the build cannot move mid-audit |

The two share no database, no secret and no integration. Nothing done in this
environment can reach production data, and no production credential is present.

---

## 3. Creating the environment (deploying engineer, one time)

The audit branch is pushed. Render reads `render.yaml` by default, so
`render.audit.yaml` is inert until you deliberately use it — this is what keeps
the production blueprint safe.

**Blueprint route (preferred):** Render → **New → Blueprint** → this repository
→ branch `audit/arabtec-pilot-online` → blueprint file `render.audit.yaml`.
It provisions `arabtec-db-audit` and `arabtec-audit` together.

**Manual route:** create a PostgreSQL instance `arabtec-db-audit` (free), then a
Web Service from branch `audit/arabtec-pilot-online` with:

| Setting | Value |
| --- | --- |
| Root directory | `backend` |
| Build command | `npm ci --include=dev && npm run build` |
| Start command | `npm start` |
| Health check | `/api/health` |
| Auto-deploy | **Off** |

Environment variables: `DATABASE_URL` from `arabtec-db-audit`, `JWT_SECRET`
generated, `NODE_ENV=production`, `TRUST_PROXY=1`, `SEED_DEMO_DATA=true`,
`CORS_ORIGINS` = the service URL, and `SEED_ADMIN_PASSWORD` set in the
dashboard. Leave `DOCLING_BASE_URL`, `OCR_BASE_URL`, `OLLAMA_BASE_URL`, `SMTP_*`
and `SENTRY_DSN` unset — see §7.

**Then seed the audit dataset** (plain HTTPS, no shell access needed):

```bash
AUDIT_BASE_URL=https://arabtec-audit.onrender.com node backend/prisma/seed-audit.mjs
```

It refuses to run twice, and prints every record it creates. The app seeds
roles, permissions and demo users by itself on first boot.

**Free-tier note:** the instance sleeps when idle and takes ~30–60 s to answer
the first request. Warm it before the auditor starts.

---

## 4. How to sign in

All audit accounts share the password **`Arabtec@123`**. These are throwaway
credentials for a throwaway database holding invented data.

| Role | Email | Use it to audit |
| --- | --- | --- |
| HR Manager | `hr.manager@arabtec.com` | The main recruiter workflow — start here |
| Recruiter | `recruiter@arabtec.com` | Day-to-day sourcing and pipeline work |
| Recruitment Manager | `rec.manager@arabtec.com` | Oversight and assignment |
| HR Director | `hr.director@arabtec.com` | Approvals |
| Hiring Manager | `hiring.manager@arabtec.com` | The hiring-manager view of a request |
| Interviewer | `interviewer@arabtec.com` | Interview feedback |
| Viewer | `viewer@arabtec.com` | Read-only — shows what permissions withhold |

`admin@arabtec.com` is the bootstrap administrator and is **forced to change its
password at first sign-in** — every route returns `403 PASSWORD_CHANGE_REQUIRED`
until it does. That is deliberate. An auditor does not need it.

Comparing two roles on the same screen is one of the more useful things to do
here: sign in as HR Manager, then as Viewer, and look at what disappears.

---

## 5. Synthetic data policy

**Every person, CV, company and project in this environment is invented.** No
real candidate, employee or customer data has ever been loaded, and none may
be. Contact details use the reserved `example.test` domain and cannot receive
mail.

**Do not upload a real CV.** If you want to exercise CV intake, use a made-up
document. Uploads are stored and parsed exactly as in production, so a real CV
would put real personal data into a throwaway database.

The dataset is deliberately seeded to cover:

- **Requests** — two in `sourcing` (one with a live pipeline), one awaiting
  approval, one `cancelled`.
- **Candidates** — one on a single request, one on two requests, one on none,
  one **exact duplicate** (same email *and* phone as another), and one
  **name-only match** (same name, different identifiers).
- **Execution** — an application moved `sourced → matched → interviewing`, a
  scheduled interview, submitted interview feedback, and a draft offer.
- **History** — request, candidate, interview and offer activity, plus the
  audit log.

Each record was created through the real API, so every state is one the product
can actually reach.

---

## 6. Recommended audit scenarios

Nothing below is simplified for the audit. These are the real flows.

**A. Requisition** — create a hiring request; submit it; approve it as HR
Director; assign a recruiter; edit it and confirm the change lands on the same
request rather than creating a second one; open a cancelled request and note
what it refuses.

**B. Talent Pool and linking** — search the pool; read the **Request** column;
open `Youssef Nabil` (linked to nothing) and use **Link to Request**; judge
whether the **Suggested** request is a sensible suggestion and whether the
reasoning is obvious; try to link a candidate to a request they are already on;
follow a linked request through to its detail page.

**C. Candidate intake review** — Candidate Review → **Upload CV** with a
**made-up** document; confirm no candidate is created by the upload alone; read
the parsed fields, the evidence and the source location; open the original
document; accept some fields and reject others; approve, and check that the
rejected values did **not** reach the candidate record.

**D. Duplicates** — review an intake whose email and phone match an existing
candidate and see the blocking treatment and its override; then look at the
name-only match (`Ahmed Samir` vs `Ahmed Samir`, `CAN-00001` vs `CAN-00005`) and
judge whether a non-blocking amber treatment is the right call.

**E. Execution** — move a candidate through the pipeline and note which
transitions are refused; open the scheduled interview and its feedback; open
the draft offer; then read the request's activity history and the audit log and
judge whether they explain who did what.

**F. Permissions** — repeat part of B and E as `viewer@arabtec.com`, and check
that unavailable actions are hidden rather than failing on click.

Please report **workflow and logic problems, not only visual ones** — a step
in the wrong order, a decision you cannot make with the information shown, or a
state you cannot get out of, is the most valuable thing you can find.

---

## 7. Known limitations

1. **Scanned and image-only documents are not supported.** The Docling sidecar
   needs a container runtime that this hosting plan does not provide, so the
   document pipeline runs its local pdfjs/mammoth parser. **Born-digital PDF,
   DOCX and plain text parse normally. Image-only PDFs, image-only Arabic and
   PNG/JPEG do not.** A document yielding no evidence-supported field raises no
   intake and says so instead of inventing fields. Nothing was faked or
   simulated to hide this.
2. **No AI extraction endpoint is configured.** Extraction is deterministic and
   rule-based — a complete, valid configuration, and what governs which values
   need human review.
3. **Email is off.** Nothing that would notify anyone actually sends.
4. **Free tier sleeps.** First request after idle takes ~30–60 s.
5. **The data is disposable** and may be reset without notice. Do not keep
   anything here that you need.
6. **Not a performance environment.** Free-tier CPU and a small dataset; judge
   workflow and usability, not speed.

---

## 8. Closing the environment

When the audit is finished: delete the `arabtec-audit` service and the
`arabtec-db-audit` database, and rotate `SEED_ADMIN_PASSWORD`. The audit branch
can stay for reference; it deploys nothing once the service is gone.

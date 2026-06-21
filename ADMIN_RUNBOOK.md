# Arabtec Recruitment Hub — Admin Runbook

Operational guide for running, maintaining, and troubleshooting the system.

---

## 1. Requirements

- **Node.js 22.5 or newer** (the app uses Node's built-in SQLite driver, hence the `--experimental-sqlite` flag in every script). Check with `node -v`.
- No database server needed for the demo/dev build — data lives in a single SQLite file. A Postgres DDL (`backend/docs/SCHEMA.sql`) and Prisma schema (`backend/prisma/schema.prisma`) are provided for a production database.

---

## 2. Starting & stopping

**One-click (recommended for non-technical users)**
- macOS / Linux: double-click `start.command` (or `./start.command` in a terminal).
- Windows: double-click `start.bat`.

These check the Node version, install dependencies on first run, seed the database if empty, pick a free port, start the server, and open the browser. Close the window to stop.

**Manual**
```bash
cd backend
npm install        # first time only
npm run seed       # first time only — creates prisma/dev.db with demo data
npm start          # starts on PORT (default 4000)
```
Stop with Ctrl+C.

**Change the port**
```bash
PORT=8080 npm start          # macOS/Linux
set PORT=8080 && npm start   # Windows
```

---

## 3. The database

- Default file: `backend/prisma/dev.db` (SQLite).
- Override location with `DATABASE_URL=file:/absolute/path.db`.
- **Back up**: copy `dev.db` while the server is stopped (or use `sqlite3 dev.db ".backup backup.db"` live).
- **Reset to clean demo data**: `cd backend && npm run reset` (deletes `dev.db` and reseeds).
- Uploaded files (CVs, attachments) are stored under `backend/data/uploads/` — back this up alongside the database.

---

## 4. Demo accounts

Admin `admin@arabtec.com` / `Admin@12345`. All other roles use `<role>@arabtec.com` / `Arabtec@123` (e.g. `recruiter@arabtec.com`). **Change these before any real use** (Admin → Users).

---

## 5. Administration (in-app)

Signed in as Admin, the sidebar exposes:
- **Users** — create/disable accounts, assign roles.
- **Roles & Permissions** — what each role can do (drives every button and visibility rule).
- **Projects / Sites / Departments** — lookup data used by requests.
- **Branding Settings** — company name and the theme colors (the red accent, neutrals). These override the built-in minimal-corporate palette at runtime.
- **Button / Workflow / System Settings** — labels, SLA hours, health thresholds, ID prefixes.
- **Audit Logs** — every state change, post, upload, approval and rejection, searchable.

---

## 6. Health & SLA configuration

Request "health" (green / amber / red) is computed from how long a request has been open versus thresholds stored in System Settings (`health_amber_days`, `health_red_days`). Approval SLA hours live there too. Adjust to your policy.

---

## 7. Tests / regression

A full self-contained test suite (no external services) lives in `backend/*.mjs`:
```bash
cd backend
node --experimental-sqlite thread_test.mjs        # conversation ticket
node --experimental-sqlite hardening_test.mjs     # auth/edge cases
node --experimental-sqlite restructure_test.mjs   # simplified intake + assessment
# …plus phase1–6, stageA/B, static
```
Each seeds a throwaway DB in /tmp, runs API assertions, and exits non-zero on failure. Current status: **393 checks passing across 14 suites.**

---

## 8. Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| App stuck on "Loading…" | React/Babel are vendored locally in `frontend/public/vendor/` — no CDN needed. If blank, check the browser console; ensure the server is serving `/app.jsx` and `/styles.css`. |
| "Cannot find module … experimental-sqlite" or SQLite errors | Node is older than 22.5. Upgrade Node. |
| Port already in use | Another process holds the port. Set a different `PORT`, or stop the other process. The one-click launcher auto-picks a free port. |
| Login fails for everyone | Database wasn't seeded. Run `npm run seed` in `backend/`. |
| Uploaded CV won't open | Check `backend/data/uploads/` exists and is writable; the file is referenced by the post/candidate record. |
| Lost demo data after restart | You ran `npm run reset`, or `dev.db` was deleted. Reseed with `npm run seed`. |
| Want a fresh start | `npm run reset` wipes and reseeds. |

---

## 9. Moving to production (notes)

- Swap SQLite for Postgres using `backend/docs/SCHEMA.sql` (or `prisma migrate` with `prisma/schema.prisma`). Point `DATABASE_URL` at the Postgres instance.
- Put the app behind HTTPS and a reverse proxy; set `CORS_ORIGINS` to your domain.
- Replace demo passwords; enforce your password policy via the auth layer.
- Move uploads to durable storage (e.g. object storage) and back up regularly.
- Tighten the file-upload allowlist and size cap in `backend/src/lib/upload.js` if needed (currently 15 MB; .pdf/.doc/.docx/.png/.jpg/.jpeg/.txt).

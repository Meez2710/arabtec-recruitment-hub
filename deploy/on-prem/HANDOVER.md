# Production user-credential handover — runbook

Goal: replace the shared temporary manager password with a **unique** strong
temporary password for every real Arabtec user, force a first-login change,
verify every credential, and produce a confidential distribution file — **without
any plaintext password touching Git**.

Run this **on `ats@10.20.0.9`** (a sudo-capable login). It talks to the live
`arabtec_ats` PostgreSQL database through the app's own code, so the scripts must
sit at `/opt/arabtec-ats/backend/prisma/` — i.e. the deployed checkout must
include this branch. If it doesn't yet:

```bash
cd /opt/arabtec-ats
sudo -u arabtec-ats git fetch origin
sudo -u arabtec-ats git checkout --detach origin/claude/on-prem-migration-final   # or main, once merged
sudo -u arabtec-ats bash -c 'cd backend && npm ci --include=dev && npm run build'
sudo systemctl restart arabtec-ats
```

## Step 1 — Audit (read-only)

```bash
sudo bash deploy/on-prem/run-handover.sh audit
```

Confirms: 42 human accounts (1 System Admin + 41 to rotate), 17 departments /
17 projects / 459 designations, 0 candidates, 0 recruitment requests, no demo
users, every hash is bcrypt, one `system_admin`. Writes
`/var/lib/arabtec-ats/handover/audit-<ts>.json` (chmod 600). Fix any `FAIL`
before continuing.

## Step 2 — Dry run (no writes)

```bash
sudo bash deploy/on-prem/run-handover.sh rotate-dry
```

Generates 41 unique 16-char passwords (upper/lower/digit/symbol, crypto-random,
never containing a name/email/`arabtec`), hashes them, verifies each hash
locally, and writes the confidential files — but does **not** touch the database.
Expect `credential verification: 41/41 PASS`.

## Step 3 — Rotate (LIVE)

```bash
sudo bash deploy/on-prem/run-handover.sh rotate
```

In one transaction, for every non-admin active user:
`password_hash` ← unique temp (bcrypt), `must_change_password = 1`,
`failed_login_count = 0`, `locked_until = NULL`. The **System Admin is not
touched**. Then it re-reads every row and verifies the plaintext against the
stored hash. It aborts (exit 1) unless verification is `41/41 PASS`.

Writes to `/var/lib/arabtec-ats/handover/` (all chmod 600, owned by
`arabtec-ats`):

| File | Purpose |
|---|---|
| `temporary-credentials-<ts>.md` | the distribution table (Name, Email, Title, Dept, Role, Temp Password, "Password change required") |
| `temporary-credentials-<ts>.csv` | same, for a spreadsheet |
| `Arabtec_ATS_User_Manual_Internal_Handover-<ts>.md` | the repo manual + a confidential credentials appendix |
| `credentials-map-<ts>.json` | machine-readable {id,email,password} for Step 4 — **delete after everyone has logged in** |

Passwords are **never printed to the terminal** — read them from the file.

## Step 4 — Independent verify

```bash
sudo bash deploy/on-prem/run-handover.sh verify
```

Re-checks every credential against the live DB, plus: email uniqueness, all
accounts active, roles + departments intact, 0 candidates, 0 requests, no demo
users, admin excluded from rotation, every rotated user flagged must-change.
Exit 0 = safe to distribute.

## Step 5 — Distribute, then clean up

- Send `temporary-credentials-<ts>.md` / `.csv` (or the private manual) through an
  approved internal channel only. One row per user; do not broadcast the whole
  list to everyone.
- Optional PDF: `pandoc temporary-credentials-<ts>.md -o temporary-credentials-<ts>.pdf`
- Once every user has logged in and changed their password:
  ```bash
  sudo shred -u /var/lib/arabtec-ats/handover/credentials-map-*.json
  ```
  Keep the `.md`/`.csv` only as long as HR needs them, then `shred -u` those too.

## First-login flow (what each user experiences)

1. Open `http://10.20.0.9:4001` on the Arabtec network.
2. Enter company email + the temporary password from the handover file.
3. The app forces a password change (`must_change_password`); only
   `POST /api/auth/change-password` is allowed until it's done.
4. New password must meet policy: ≥12 chars, upper + lower + digit + symbol, not
   the user's name/email, not a known-weak value.
5. On success the flag clears, other sessions are revoked, and the user lands on
   their role-based dashboard. The old temporary password no longer works.

Account lockout is unchanged: 5 failed attempts → 15-minute lock. A locked user
is unlocked by the **System Admin** from **Settings → Users** (self-service reset
is not enabled).

## If something fails

- `rotate` aborts before verify passes → nothing distributed; investigate, re-run
  (it generates fresh passwords for everyone).
- verify fails after a completed rotate → do **not** distribute; the System Admin
  can reset individual accounts from Settings → Users, or re-run `rotate`.
- The scripts never weaken lockout, never change the admin password, and never
  write plaintext outside `/var/lib/arabtec-ats/handover/`.

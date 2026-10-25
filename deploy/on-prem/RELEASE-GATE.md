# Releasing to the on-prem server (Packet 2, 25 Oct 2026)

A release to `10.20.0.9` is an **exact commit on `main` that Moutaz Adly
approved in GitHub within the last 24 hours**. Merging a pull request does not
release anything. The server verifies the approval itself, read-only, before it
touches the running service; if it cannot verify, nothing changes.

## One-time setup (owner)

1. GitHub → Settings → Environments → `onprem-10.20.0.9`: required reviewer
   **Meez2710**, deployment branches **`main` only**. (Created 25 Oct 2026.)
2. Create a **fine-grained personal access token**: resource owner Meez2710,
   repository `arabtec-recruitment-hub` only, permissions **Actions: Read-only**
   and **Deployments: Read-only**, expiry 1 year. Nothing else.
3. Place it on the server yourself (the agent never handles it):
   ```bash
   ssh ats@10.20.0.9 'umask 077; mkdir -p ~/.config/arabtec; cat > ~/.config/arabtec/release-token; chmod 400 ~/.config/arabtec/release-token'
   ```
   paste the token, Enter, Ctrl-D. Put the expiry date in your calendar.

## Every release

1. GitHub → **Actions → Release to on-prem → Run workflow**, paste the full
   40-character SHA from `main`. Anyone with write access may start it.
2. The run pauses. On your phone (GitHub app) or laptop: **Review pending
   deployments → Approve** (or Reject). That approval — your login, the time,
   the SHA, the environment — is the authorisation.
3. On the server:
   ```bash
   ssh ats@10.20.0.9 'cd /opt/arabtec-ats/deploy/on-prem && ATS_REF=<sha> bash 08-redeploy.sh'
   ```
   `08-redeploy.sh` fetches, then runs `10-verify-approval.sh`, which refuses
   unless: a Deployment exists for this SHA and environment; its workflow run
   was approved for this environment by Meez2710; it is less than 24 h old; the
   deploy script and verifier at this SHA hash to what was approved; and this
   approval has not already been used. Only then: backup → reset → build →
   restart → readiness. The release is logged in `~/releases.log`.
4. Retry after a failed build is allowed within the 24 h without a new
   approval; after a successful release the approval is spent.

## Rollback (rule A — strict)

A rollback is a release: run the workflow for the previous SHA, approve it,
then `ATS_REF=<previous sha> bash 08-redeploy.sh`. `08-redeploy.sh` prints the
previous SHA at the end of every release.

## What this does and does not enforce

Enforced: no branch names, no unapproved SHA, no stale or reused approval, no
changed procedure, fail-closed on any API problem. Not enforced: root on the
server, and the holder of the `ats` SSH key editing the scripts in place
(mitigated by the hash binding and the log, not eliminated). Keep that key to
the owner only.

#!/usr/bin/env bash
# Verify that a release SHA was approved in GitHub before the server touches
# the running service (Packet 2, 25 Oct 2026).
#
#   10-verify-approval.sh <sha>            → exit 0 only if approved, else 1
#   10-verify-approval.sh --consume <sha>  → same checks, then mark the
#                                            deployment used (one approval, one release)
#
# What "approved" means, all of it or nothing:
#   1. a GitHub Deployment exists for exactly this SHA and RELEASE_ENV;
#   2. the workflow run named in its payload was approved for RELEASE_ENV by
#      RELEASE_REVIEWER, and that run's head is this SHA;
#   3. the deployment is younger than RELEASE_MAX_AGE_H hours;
#   4. the deploy procedure at this SHA (08-redeploy.sh) and this verifier hash
#      to what was approved — a changed procedure needs a new approval;
#   5. the deployment id has not already been consumed by a successful release.
# Any API error, timeout, missing token or malformed answer is a refusal.
# The token is read-only (Actions: read, Deployments: read) and lives in
# RELEASE_TOKEN_FILE, mode 0400, owned by the service user.
set -euo pipefail
CONSUME=0
if [ "${1:-}" = "--consume" ]; then CONSUME=1; shift; fi
SHA="${1:-}"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "verify-approval: a full 40-character SHA is required" >&2; exit 1; }

: "${GITHUB_API:=https://api.github.com}"
: "${REPO:=Meez2710/arabtec-recruitment-hub}"
: "${RELEASE_ENV:=onprem-10.20.0.9}"
: "${RELEASE_REVIEWER:=Meez2710}"
: "${RELEASE_MAX_AGE_H:=24}"
: "${APP_ROOT:=/opt/arabtec-ats}"
: "${RELEASE_TOKEN_FILE:=$HOME/.config/arabtec/release-token}"
: "${CONSUMED_FILE:=$HOME/.config/arabtec/consumed-deployments}"

[ -r "$RELEASE_TOKEN_FILE" ] || { echo "verify-approval: REFUSED — no release token at $RELEASE_TOKEN_FILE" >&2; exit 1; }
TOKEN="$(tr -d '[:space:]' < "$RELEASE_TOKEN_FILE")"
[ -n "$TOKEN" ] || { echo "verify-approval: REFUSED — empty release token" >&2; exit 1; }

PROC_HASH="$(git -C "$APP_ROOT" show "$SHA:deploy/on-prem/08-redeploy.sh" 2>/dev/null | sha256sum | cut -d' ' -f1)"
VERIFIER_HASH="$(git -C "$APP_ROOT" show "$SHA:deploy/on-prem/10-verify-approval.sh" 2>/dev/null | sha256sum | cut -d' ' -f1)"
[ -n "$PROC_HASH" ] && [ "$PROC_HASH" != "$(printf '' | sha256sum | cut -d' ' -f1)" ] || { echo "verify-approval: REFUSED — $SHA is not fetched or has no deploy/on-prem/08-redeploy.sh" >&2; exit 1; }

export SHA GITHUB_API REPO RELEASE_ENV RELEASE_REVIEWER RELEASE_MAX_AGE_H TOKEN PROC_HASH VERIFIER_HASH CONSUMED_FILE CONSUME
python3 - <<'PY'
import json, os, sys, time, urllib.request, urllib.error
from datetime import datetime, timezone

def refuse(msg):
    print(f"verify-approval: REFUSED — {msg}", file=sys.stderr); sys.exit(1)

def get(path):
    req = urllib.request.Request(os.environ["GITHUB_API"].rstrip("/") + path, headers={
        "Authorization": "Bearer " + os.environ["TOKEN"], "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "arabtec-release-gate"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        refuse(f"GitHub answered {e.code} for {path}")
    except Exception as e:  # network, timeout, bad JSON — all refusals
        refuse(f"GitHub unreachable or unreadable ({type(e).__name__}) for {path}")

sha, repo, env = os.environ["SHA"], os.environ["REPO"], os.environ["RELEASE_ENV"]
reviewer = os.environ["RELEASE_REVIEWER"]; max_age = float(os.environ["RELEASE_MAX_AGE_H"]) * 3600
consumed_file = os.environ["CONSUMED_FILE"]

deps = get(f"/repos/{repo}/deployments?sha={sha}&environment={env}&per_page=10")
if not isinstance(deps, list) or not deps: refuse(f"no GitHub deployment of {sha[:10]} to {env}")
deps.sort(key=lambda d: d.get("created_at", ""), reverse=True)
dep = deps[0]
if dep.get("sha") != sha or dep.get("environment") != env: refuse("deployment record does not match this SHA/environment")
try:
    created = datetime.strptime(dep["created_at"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
except Exception: refuse("deployment has no readable creation time")
age = (datetime.now(timezone.utc) - created).total_seconds()
if age > max_age: refuse(f"approval is {age/3600:.1f} h old (limit {max_age/3600:.0f} h) — approve again")
payload = dep.get("payload") or {}
if isinstance(payload, str):
    try: payload = json.loads(payload)
    except Exception: refuse("deployment payload is not JSON")
if payload.get("sha") != sha or payload.get("environment") != env: refuse("payload does not name this SHA/environment")
if payload.get("procedure_sha256") != os.environ["PROC_HASH"]: refuse("deploy procedure at this SHA differs from the approved one")
if payload.get("verifier_sha256") and payload["verifier_sha256"] != os.environ["VERIFIER_HASH"]: refuse("verifier at this SHA differs from the approved one")
run_id = payload.get("run_id")
if not isinstance(run_id, int): refuse("payload names no workflow run")

run = get(f"/repos/{repo}/actions/runs/{run_id}")
if run.get("head_sha") != sha: refuse("the approved workflow run was for a different commit")
approvals = get(f"/repos/{repo}/actions/runs/{run_id}/approvals")
ok = any(a.get("state") == "approved" and (a.get("user") or {}).get("login") == reviewer
         and any(e.get("name") == env for e in a.get("environments", [])) for a in approvals or [])
if not ok: refuse(f"run {run_id} was not approved for {env} by {reviewer}")
approved_by = next(a for a in approvals if a.get("state") == "approved" and a["user"]["login"] == reviewer)

try:
    consumed = set(l.split()[0] for l in open(consumed_file) if l.strip())   # "<id> <sha> <time>" per line
except FileNotFoundError:
    consumed = set()
if str(dep["id"]) in consumed: refuse(f"deployment {dep['id']} was already released once — approve again")

if os.environ["CONSUME"] == "1":
    os.makedirs(os.path.dirname(consumed_file), exist_ok=True)
    with open(consumed_file, "a") as f: f.write(f"{dep['id']} {sha} {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}\n")
print(f"APPROVED deployment {dep['id']} sha {sha} by {approved_by['user']['login']} at {dep['created_at']} (run {run_id})")
PY

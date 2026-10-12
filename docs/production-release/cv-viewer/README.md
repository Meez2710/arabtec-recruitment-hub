# CV viewer fix (8b148cd) — production recovery dry run

Read-only. Prints aggregate counts only (no names, no credentials). Opens a
`READ ONLY` transaction and rolls it back. Mirrors `backend/src/lib/candidate-cv.js`.

The service credential is in `/etc/arabtec-ats/ats.env` (root:root 600), which
the `ats` account cannot read, so an administrator with root runs it:

```
scp cv-recovery-dryrun.cjs ats@10.20.0.9:/tmp/
ssh ats@10.20.0.9
sudo bash -c 'set -a; . /etc/arabtec-ats/ats.env; set +a; /opt/node22/bin/node /tmp/cv-recovery-dryrun.cjs'; rm -f /tmp/cv-recovery-dryrun.cjs
```

Output fields:
- `candidates`, `withResumePath`, `resumePathBlobMissing` — profile CVs and any whose stored bytes are missing (a separate storage problem, if non-zero).
- `noResumeButCvDoc` — candidates affected by the viewer bug.
- `cvDocRows.resolvable` / `bytesVerified` — rows the fix will open, with bytes present and matching their hash.
- `cvDocRows.unlinked` / `ambiguous` / `no_hash` / `blobMissing` / `hashMismatch` — rows the fix will NOT open; these are the recovery exceptions for an administrator.
- `candidatesThatWillShowACv` — candidates whose profile will show a CV after deployment.

No write, migration or backfill is part of this fix.

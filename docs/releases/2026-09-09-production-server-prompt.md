# Prompt for Claude Code on the production server

Deploy the merged updates from https://github.com/Meez2710/arabtec-recruitment-hub to the EXISTING Arabtec ATS installation. The server's current database and uploads are authoritative production data. Update code and necessary schema; do not import or replace business data.

1. Inspect repository instructions, the running process, checkout, database, uploads, environment, proxy and timers. Expected systemd layout: /opt/arabtec-ats, service arabtec-ats, environment /etc/arabtec-ats/ats.env. Confirm these. If the real installation uses Docker, retain its existing compose project and persistent volumes. Do not create another installation or change deployment architecture. Never print secrets.

2. Record the current SHA and local modifications. Fetch main and pin ONE full commit SHA containing the merged fixes. Verify it contains the production guard in seedOrganizationChartIfEmpty and the orgStructure page entry in app.jsx. Do not deploy the earlier UI commit alone: it can import bundled org-chart records into an empty chart. Preserve local changes; do not discard them with reset --hard or git clean.

3. Confirm NODE_ENV=production, SEED_DEMO_DATA=false, and the SAME existing DATABASE_URL, upload path, JWT secret, MICROSOFT_TOKEN_ENCRYPTION_KEY and mail settings. Do not rotate keys or replace environment files. Confirm expected production users and business records exist. Stop if the database is unexpectedly empty or points elsewhere. Never run seed, fixtures, loadsets, sample SQL, data cleanup, database reset, force-reset, docker compose down -v or volume deletion. Do not copy a database from GitHub/ZIPs/development. New modules may stay empty.

4. Review all startup and schema changes between deployed and target SHA, including ensureSchema, ensureOrganizationChartSchema, bootSeedIfEmpty, feature/permission initialization and package lifecycle scripts. Startup can migrate data without an explicit migration command. Separate required schema additions from business-data changes. Stop before destructive or unexplained migrations. Do not assume every migration is additive or disable compatibility changes blindly.

5. Prepare restricted, dated backups OUTSIDE the checkout: consistent database dump, uploads, environment/proxy/service configuration and deployment metadata. Verify dump/archive readability and record checksums; rehearse restoration in an isolated temporary database if available. Never test restoration over production. Record old SHA and rollback commands.

6. Stage/build the pinned code with Node 22 and the lockfile before cutover where supported. Tests must use isolated disposable databases and synthetic mail configuration, NEVER production DATABASE_URL or mailbox credentials. Record active workers/timers. During maintenance pause user writes and background scans, wait for active jobs, capture baseline counts for candidates, applications, offers, requests, users, departments, sites, projects and organization_node if present, and an uploads manifest. Take the final consistent backup before startup migrations.

7. For confirmed systemd use docs/releases/2026-09-08-approved-ui-onprem.md with the NEW full SHA as RELEASE_SHA/ATS_REF and scripts from that release. Preserve production environment and uploads. Do not rerun 05-install-services.sh or overwrite Apache/Cloudflare configuration with templates. For Docker rebuild/recreate only application containers while retaining the existing database, project, secrets and volumes.

8. Verify readiness, logs and the served commit/assets. Smoke-test login, dashboard, candidates, requests, Offers, Organization Structure, permissions and Email & Mailbox. An empty chart should show Work in progress; existing records must stay visible. Check mailbox status without sending email or starting ingestion. Revalidate browser caches.

9. Before reopening writes compare protected table counts, selected existing record identifiers/fields, uploads and settings against the baseline. Investigate any unexpected difference. Health alone is insufficient. Resume only previously active workers/timers after validation. Do not enable duplicate Power Automate/Graph intake or acknowledgements.

10. On failure keep maintenance mode and roll back code only if schema compatibility permits. Never restore an old database over newer production writes automatically. Report the failure and safe recovery choice.

Deliver: deployed full SHA, health, backup paths/checksums without secrets, schema changes, before/after production-data checks, pages verified, timers restored and remaining issues. Say NOT DEPLOYED if blocked. Continue through authorized safe steps without repeated confirmation requests.

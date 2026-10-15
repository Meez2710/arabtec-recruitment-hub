# System Admin-only deletion — 2026-10-14

Based on authoritative on-premises commit 1330c72. All authenticated DELETE endpoints, candidate erasure and delete-impact previews require the system_admin role, regardless of configurable permissions. Both legacy and typed APIs enforce the boundary. Existing resource permissions continue to apply.

Deletion controls are hidden for other roles in candidate privacy, organization charts (desktop/mobile), custom fields and branding. Resolved delete-button configuration cannot grant another role access. Replacing footer quotes also requires System Admin. Ordinary reads, editing, consent updates and assignments remain available under their existing permissions.

Verification: synthetic API suite 127 assertions passed; typed API/auth suites 37 tests passed; actual JSX rendering 72 assertions passed; TypeScript check passed. The pre-fix API suite reproduced 73 failed policy assertions. No production records were deleted in testing. Frontend cache versions changed for app and organization bundles.

HawkScan preflight could not proceed because the hawk CLI is unavailable. No DAST result is claimed.

Pending separate requirement: request deletion still cascades workflow rows even though candidate records survive. Request-only permanent erasure with detachment of every linked record is not implemented by this release. Broad production readiness is not certified here.

Deployment uses the existing safe-release script with a fresh database backup, isolated build and automatic code rollback. Production remains the source of truth; GitHub is the release record.

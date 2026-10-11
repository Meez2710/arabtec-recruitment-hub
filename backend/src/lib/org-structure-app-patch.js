// Inserts Organization Structure into the ATS shell (nav + page map).
// Applied when serving /app.jsx so the large SPA file does not need a full rewrite.
// With the org_chart_v2 flag on, ArabtecOrgStructureV2Gate (org-structure-v2.jsx) renders the v2 page and
// falls back to the v1 page when the flag is off or the v2 script is missing.
// Idempotent: if app.jsx already contains the nav item, only the page lookup is swapped for the gate.

const V1_PAGE = 'const OrgStructurePage = window.ArabtecOrgStructurePage;';
const GATED_PAGE = 'const OrgStructurePage = window.ArabtecOrgStructureV2Gate || window.ArabtecOrgStructurePage;';

export function withOrgStructurePage(src) {
  if (!src) return src;
  // app.jsx may already carry the nav item and page map; the gate is still swapped in.
  if (src.includes("key: 'orgStructure'")) return src.replace(V1_PAGE, GATED_PAGE);

  src = src.replace(
    "{ key: 'reports', label: 'Reports', icon: 'scroll', perm: 'dashboard.view' },",
    "{ key: 'reports', label: 'Reports', icon: 'scroll', perm: 'dashboard.view' },\n  { key: 'orgStructure', label: 'Organization Structure', icon: 'building', perm: null },",
  );

  src = src.replace(
    'const CandidateReviewPage = window.ArabtecCandidateIntakeReviewPage;',
    'const CandidateReviewPage = window.ArabtecCandidateIntakeReviewPage;\n  ' + GATED_PAGE,
  );

  src = src.replace(
    'candidateReview: CandidateReviewPage ? <CandidateReviewPage user={user} /> : <div className="error-banner">Candidate Review module failed to load.</div>,',
    'candidateReview: CandidateReviewPage ? <CandidateReviewPage user={user} /> : <div className="error-banner">Candidate Review module failed to load.</div>,\n    orgStructure: OrgStructurePage ? <OrgStructurePage user={user} /> : <div className="error-banner">Organization Structure module failed to load.</div>,',
  );

  return src;
}

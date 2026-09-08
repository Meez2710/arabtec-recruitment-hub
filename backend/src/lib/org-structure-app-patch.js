// Inserts Organization Structure into the ATS shell (nav + page map).
// Applied when serving /app.jsx so the large SPA file does not need a full rewrite.
// Idempotent: if app.jsx already contains the nav item, the source is returned unchanged.

export function withOrgStructurePage(src) {
  if (!src || src.includes("key: 'orgStructure'")) return src;

  src = src.replace(
    "{ key: 'reports', label: 'Reports', icon: 'scroll', perm: 'dashboard.view' },",
    "{ key: 'reports', label: 'Reports', icon: 'scroll', perm: 'dashboard.view' },\n  { key: 'orgStructure', label: 'Organization Structure', icon: 'building', perm: null },",
  );

  src = src.replace(
    'const CandidateReviewPage = window.ArabtecCandidateIntakeReviewPage;',
    'const CandidateReviewPage = window.ArabtecCandidateIntakeReviewPage;\n  const OrgStructurePage = window.ArabtecOrgStructurePage;',
  );

  src = src.replace(
    'candidateReview: CandidateReviewPage ? <CandidateReviewPage user={user} /> : <div className="error-banner">Candidate Review module failed to load.</div>,',
    'candidateReview: CandidateReviewPage ? <CandidateReviewPage user={user} /> : <div className="error-banner">Candidate Review module failed to load.</div>,\n    orgStructure: OrgStructurePage ? <OrgStructurePage user={user} /> : <div className="error-banner">Organization Structure module failed to load.</div>,',
  );

  return src;
}

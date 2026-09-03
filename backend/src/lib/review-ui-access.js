export function reviewUiAllowed({ isProd, enabled }) {
  return !isProd || enabled === true;
}

export function reviewRequestPolicy({ path = '', query = {}, isProd, enabled }) {
  const allowed = reviewUiAllowed({ isProd, enabled });
  const isReviewTool = path === '/ats-editor.html' || path === '/ats-preview.html';
  const isReviewFrame = query?.ui_review_frame === '1';
  return {
    allowed,
    blocked: isReviewTool && !allowed,
    allowSameOriginFrame: isReviewFrame && allowed,
  };
}

export function rewriteReviewFrameHeaders(headers = {}) {
  const next = { ...headers };
  for (const [name, rawValue] of Object.entries(next)) {
    if (!/^content-security-policy(?:-report-only)?$/i.test(name)) continue;
    const value = String(rawValue || '');
    next[name] = /frame-ancestors\s+[^;]+/i.test(value)
      ? value.replace(/frame-ancestors\s+[^;]+/i, "frame-ancestors 'self'")
      : `${value}${value.trim().endsWith(';') || !value.trim() ? '' : ';'} frame-ancestors 'self'`.trim();
  }
  next['X-Frame-Options'] = 'SAMEORIGIN';
  return next;
}

export function createReviewUiGuard({ isProd, enabled }) {
  return function reviewUiGuard(req, res, next) {
    if (reviewUiAllowed({ isProd, enabled })) return next();
    return res.status(404).type('text/plain').send('Not found');
  };
}

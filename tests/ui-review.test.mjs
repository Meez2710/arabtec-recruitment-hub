import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  normalizeCssValue,
  isSupportedProperty,
  selectorFromTrail,
  changesToCss,
  exportReviewBundle,
  VIEWPORTS,
} from '../frontend/public/ui-review-core.mjs';
import {
  reviewUiAllowed,
  reviewRequestPolicy,
  rewriteReviewFrameHeaders,
} from '../backend/src/lib/review-ui-access.js';

const editorPath = new URL('../frontend/public/ats-editor.html', import.meta.url);
const previewPath = new URL('../frontend/public/ats-preview.html', import.meta.url);

test('normalizes numeric sizing values to px while preserving keywords', () => {
  assert.equal(normalizeCssValue('width', '120'), '120px');
  assert.equal(normalizeCssValue('padding', ' 12 '), '12px');
  assert.equal(normalizeCssValue('width', 'auto'), 'auto');
  assert.equal(normalizeCssValue('font-size', '14px'), '14px');
});

test('rejects unsupported style properties', () => {
  assert.equal(isSupportedProperty('padding'), true);
  assert.equal(isSupportedProperty('position'), false);
  assert.equal(isSupportedProperty('background-image'), false);
});

test('builds a stable selector from a serialized element trail', () => {
  const selector = selectorFromTrail([
    { tag: 'main', id: 'main-content', classes: [] },
    { tag: 'div', classes: ['toolbar', 'dense'], nthOfType: 2 },
    { tag: 'button', classes: ['btn', 'btn-primary'], nthOfType: 1 },
  ]);
  assert.equal(selector, '#main-content > div.toolbar.dense:nth-of-type(2) > button.btn.btn-primary:nth-of-type(1)');
});

test('serializes selector changes into readable CSS', () => {
  const css = changesToCss([
    { selector: '.btn-primary', property: 'height', value: '40px' },
    { selector: '.btn-primary', property: 'border-radius', value: '8px' },
    { selector: '.card', property: 'padding', value: '16px' },
  ]);
  assert.match(css, /\.btn-primary \{/);
  assert.match(css, /height: 40px !important;/);
  assert.match(css, /border-radius: 8px !important;/);
  assert.match(css, /\.card \{/);
});

test('exports review data without runtime DOM objects', () => {
  const bundle = exportReviewBundle({
    pageLabel: 'Candidates',
    changes: [{ selector: '.btn', property: 'height', value: '40px' }],
    comments: [{ selector: '.btn', note: 'Reduce width' }],
  });
  assert.equal(bundle.pageLabel, 'Candidates');
  assert.equal(bundle.changes.length, 1);
  assert.equal(bundle.comments[0].note, 'Reduce width');
  assert.ok(bundle.generatedAt);
});

test('ships practical desktop/tablet/mobile viewport presets', () => {
  assert.equal(VIEWPORTS.desktop.width, null);
  assert.equal(VIEWPORTS.tablet.width, 820);
  assert.equal(VIEWPORTS.mobile.width, 390);
});

test('review UI defaults closed in production and open outside production', () => {
  assert.equal(reviewUiAllowed({ isProd: false, enabled: false }), true);
  assert.equal(reviewUiAllowed({ isProd: true, enabled: false }), false);
  assert.equal(reviewUiAllowed({ isProd: true, enabled: true }), true);
});

test('review request policy blocks tool pages but permits the explicit review frame when enabled', () => {
  assert.deepEqual(
    reviewRequestPolicy({ path: '/ats-editor.html', query: {}, isProd: true, enabled: false }),
    { allowed: false, blocked: true, allowSameOriginFrame: false },
  );
  assert.deepEqual(
    reviewRequestPolicy({ path: '/', query: { ui_review_frame: '1' }, isProd: true, enabled: true }),
    { allowed: true, blocked: false, allowSameOriginFrame: true },
  );
});

test('review frame header rewrite keeps CSP protections while allowing same-origin framing', () => {
  const headers = rewriteReviewFrameHeaders({
    'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'; object-src 'none'",
    'X-Frame-Options': 'DENY',
  });
  assert.equal(headers['X-Frame-Options'], 'SAMEORIGIN');
  assert.match(headers['Content-Security-Policy'], /frame-ancestors 'self'/);
  assert.match(headers['Content-Security-Policy'], /object-src 'none'/);
});

test('editor has inspect/navigation workflow, explicit review frame, and no embedded credentials', () => {
  const html = fs.readFileSync(editorPath, 'utf8');
  assert.match(html, /Navigate/);
  assert.match(html, /Inspect/);
  assert.match(html, /Export Review/);
  assert.match(html, /ui-review-core\.mjs/);
  assert.match(html, /src="\/\?ui_review_frame=1"/);
  assert.doesNotMatch(html, /Admin@12345/i);
  assert.doesNotMatch(html, /admin@arabtec\.com/i);
});

test('preview has responsive controls and never performs hardcoded auto-login', () => {
  const html = fs.readFileSync(previewPath, 'utf8');
  assert.doesNotMatch(html, /\/api\/auth\/login/);
  assert.doesNotMatch(html, /Admin@12345/i);
  assert.match(html, /Desktop/);
  assert.match(html, /Tablet/);
  assert.match(html, /Mobile/);
  assert.match(html, /ui_review_frame=1/);
});

function fakeResponse() {
  const headers = new Map();
  return {
    statusCode: 200,
    body: '',
    setHeader(name, value) { headers.set(name.toLowerCase(), String(value)); },
    getHeader(name) { return headers.get(name.toLowerCase()); },
    removeHeader(name) { headers.delete(name.toLowerCase()); },
    status(code) { this.statusCode = code; return this; },
    type(value) { this.setHeader('Content-Type', value); return this; },
    send(value) { this.body = String(value); return this; },
  };
}

test('security middleware blocks review pages in production by default', async () => {
  process.env.NODE_ENV = 'production';
  process.env.ENABLE_UI_REVIEW = 'false';
  delete process.env.SECURITY_HEADERS_DISABLED;
  const { securityHeaders } = await import(`../backend/src/lib/security-headers.js?blocked=${Date.now()}`);
  const res = fakeResponse();
  let nextCalled = false;
  securityHeaders({ path: '/ats-editor.html', query: {} }, res, () => { nextCalled = true; });
  assert.equal(res.statusCode, 404);
  assert.equal(nextCalled, false);
});

test('security middleware allows SAMEORIGIN only for the enabled review frame', async () => {
  process.env.NODE_ENV = 'production';
  process.env.ENABLE_UI_REVIEW = 'true';
  delete process.env.SECURITY_HEADERS_DISABLED;
  const { securityHeaders } = await import(`../backend/src/lib/security-headers.js?enabled=${Date.now()}`);

  const frameRes = fakeResponse();
  securityHeaders({ path: '/', query: { ui_review_frame: '1' } }, frameRes, () => {});
  assert.equal(frameRes.getHeader('X-Frame-Options'), 'SAMEORIGIN');
  assert.match(frameRes.getHeader('Content-Security-Policy'), /frame-ancestors 'self'/);

  const normalRes = fakeResponse();
  securityHeaders({ path: '/', query: {} }, normalRes, () => {});
  assert.equal(normalRes.getHeader('X-Frame-Options'), 'DENY');
  assert.match(normalRes.getHeader('Content-Security-Policy'), /frame-ancestors 'none'/);
});

test('review frame exception is limited to the ATS root shell', () => {
  assert.equal(
    reviewRequestPolicy({ path: '/api/health', query: { ui_review_frame: '1' }, isProd: true, enabled: true }).allowSameOriginFrame,
    false,
  );
});

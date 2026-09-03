export const VIEWPORTS = Object.freeze({
  desktop: { label: 'Desktop', width: null },
  tablet: { label: 'Tablet', width: 820 },
  mobile: { label: 'Mobile', width: 390 },
});

const SUPPORTED = new Set([
  'width',
  'height',
  'padding',
  'margin',
  'gap',
  'font-size',
  'font-weight',
  'border-radius',
  'background-color',
  'color',
  'border-color',
  'justify-content',
  'align-items',
]);

const PX_PROPERTIES = new Set([
  'width', 'height', 'padding', 'margin', 'gap', 'font-size', 'border-radius',
]);

const CSS_KEYWORDS = new Set([
  'auto', 'inherit', 'initial', 'unset', 'revert', 'revert-layer', 'normal', 'none',
]);

export function isSupportedProperty(property) {
  return SUPPORTED.has(String(property || '').trim().toLowerCase());
}

export function normalizeCssValue(property, rawValue) {
  const prop = String(property || '').trim().toLowerCase();
  const value = String(rawValue ?? '').trim();
  if (!value) return '';
  if (!isSupportedProperty(prop)) return '';
  if (CSS_KEYWORDS.has(value.toLowerCase())) return value.toLowerCase();
  if (PX_PROPERTIES.has(prop) && /^-?\d+(?:\.\d+)?$/.test(value)) return `${value}px`;
  return value;
}

function safeIdentifier(value) {
  const text = String(value || '').trim();
  return /^[A-Za-z_-][A-Za-z0-9_-]*$/.test(text) ? text : '';
}

export function selectorFromTrail(trail) {
  if (!Array.isArray(trail) || !trail.length) return '';
  return trail.map((part) => {
    const id = safeIdentifier(part?.id);
    if (id) return `#${id}`;
    const tag = safeIdentifier(String(part?.tag || '').toLowerCase()) || '*';
    const classes = Array.isArray(part?.classes)
      ? part.classes.map(safeIdentifier).filter(Boolean).slice(0, 3)
      : [];
    const classSelector = classes.map((name) => `.${name}`).join('');
    const nth = Number(part?.nthOfType);
    const nthSelector = Number.isInteger(nth) && nth > 0 ? `:nth-of-type(${nth})` : '';
    return `${tag}${classSelector}${nthSelector}`;
  }).join(' > ');
}

export function changesToCss(changes) {
  const grouped = new Map();
  for (const item of Array.isArray(changes) ? changes : []) {
    const selector = String(item?.selector || '').trim();
    const property = String(item?.property || '').trim().toLowerCase();
    const value = normalizeCssValue(property, item?.value);
    if (!selector || !isSupportedProperty(property) || !value) continue;
    if (!grouped.has(selector)) grouped.set(selector, []);
    const bucket = grouped.get(selector);
    const existing = bucket.findIndex((x) => x.property === property);
    const next = { property, value };
    if (existing >= 0) bucket[existing] = next;
    else bucket.push(next);
  }

  const blocks = [];
  for (const [selector, rules] of grouped.entries()) {
    const body = rules.map(({ property, value }) => `  ${property}: ${value} !important;`).join('\n');
    blocks.push(`${selector} {\n${body}\n}`);
  }
  return blocks.join('\n\n');
}

export function exportReviewBundle({ pageLabel = '', changes = [], comments = [], viewport = 'desktop' } = {}) {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    pageLabel: String(pageLabel || '').trim(),
    viewport,
    changes: (Array.isArray(changes) ? changes : []).map(({ selector, property, value }) => ({ selector, property, value })),
    comments: (Array.isArray(comments) ? comments : []).map(({ selector, element, note, page, createdAt }) => ({
      selector,
      element,
      note,
      page,
      createdAt,
    })),
  };
}

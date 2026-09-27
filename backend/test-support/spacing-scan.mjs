// R16 spacing scan. Every px value in a margin / padding / gap declaration in
// the six product stylesheets must sit on the spacing scale (0, 4, 8, 12, 16,
// 24, 32 = --sp-1..--sp-6) or be a token. The one named exception is the card
// head's 10px vertical inset (docs/audits/ui-rules.md, R16). Everything that
// was already off the scale when the rule was written is listed, by exact
// declaration, in docs/audits/spacing-legacy.json: the list may only shrink.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SHEETS = ['styles.css', 'arabtec-approved-ui.css', 'arabtec-design-system.css',
  'claude-system.css', 'arabtec-responsive.css', 'arabtec-mobile.css'];
export const SCALE = new Set([0, 4, 8, 12, 16, 24, 32]);
const PROP = /^(margin|padding|gap|row-gap|column-gap)(-(top|right|bottom|left|inline|block|inline-start|inline-end|block-start|block-end))?$/;
const pub = fileURLToPath(new URL('../../frontend/public/', import.meta.url));

export function offScale() {
  const out = [];
  for (const file of SHEETS) {
    const src = fs.readFileSync(pub + file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const re = /([^{}]+)\{([^{}]*)\}/g; let m;
    while ((m = re.exec(src))) {
      const sel = m[1].trim().replace(/\s+/g, ' ');
      if (sel.startsWith('@')) continue;
      for (const decl of m[2].split(';')) {
        const i = decl.indexOf(':'); if (i < 0) continue;
        const prop = decl.slice(0, i).trim().toLowerCase();
        if (!PROP.test(prop)) continue;
        const value = decl.slice(i + 1).trim().replace(/\s*!important$/, '').replace(/\s+/g, ' ');
        // calc()/max()/min() carry arithmetic, not a spacing step.
        const bare = value.replace(/(calc|max|min|clamp|env)\([^()]*(\([^()]*\)[^()]*)*\)/g, '');
        const px = [...bare.matchAll(/(-?\d*\.?\d+)px/g)].map((x) => Math.abs(Number(x[1])));
        const cardHead = /card-head/.test(sel) && prop.startsWith('padding');
        const bad = px.filter((v) => !SCALE.has(v) && !(cardHead && v === 10));
        if (bad.length) out.push(`${file} | ${sel.slice(0, 160)} | ${prop}: ${value}`);
      }
    }
  }
  return out;
}

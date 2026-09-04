// Compile the exact JSX files served in production with the exact vendored
// Babel runtime the browser receives. A syntax regression here otherwise
// becomes a full white screen because this SPA has no frontend build step.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, '../frontend/public');
const context = {};
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(publicDir, 'vendor/babel.min.js'), 'utf8'), context);

let failed = 0;
for (const file of ['intake-review.jsx', 'app.jsx']) {
  try {
    context.Babel.transform(fs.readFileSync(path.join(publicDir, file), 'utf8'), { presets: ['react'] });
    console.log(`  ✓ ${file} compiles with the production Babel runtime`);
  } catch (error) {
    failed++;
    console.error(`  ✗ ${file} failed to compile`);
    console.error(error instanceof Error ? error.message : error);
  }
}

console.log(`\n=== UI COMPILE: ${2 - failed} passed, ${failed} failed ===\n`);
process.exit(failed ? 1 : 0);

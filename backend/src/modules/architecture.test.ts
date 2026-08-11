// Architecture guards — dependency direction and acyclicity, checked mechanically.
//
// These exist because the rules they enforce are the ones that decay silently.
// Nothing fails at runtime when a domain file imports Drizzle; it just quietly
// stops being possible to test the domain without a database, and by the time
// anyone notices there are forty such imports.
//
// The checks read the import graph from source, so they cover every file that
// exists rather than every file someone remembered to think about.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..');

const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });

const IMPORT_RE = /^\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/gm;

interface SourceFile {
  readonly rel: string;
  readonly dir: string;
  readonly specifiers: readonly string[];
  /** Import targets resolved to repo-relative paths; bare package names dropped. */
  readonly localTargets: readonly string[];
}

const load = (root: string): readonly SourceFile[] =>
  walk(root)
    .filter((f) => !f.endsWith('.test.ts'))
    .map((full) => {
      const source = fs.readFileSync(full, 'utf8');
      const specifiers = [...source.matchAll(IMPORT_RE)].map((m) => m[1]!);
      const dir = path.dirname(full);
      return {
        rel: path.relative(SRC, full).replaceAll(path.sep, '/'),
        dir,
        specifiers,
        localTargets: specifiers
          .filter((s) => s.startsWith('.'))
          .map((s) => path.relative(SRC, path.resolve(dir, s.replace(/\.js$/, '.ts')))
            .replaceAll(path.sep, '/')),
      };
    });

const ALL = load(path.join(SRC, 'modules'))
  .concat(load(path.join(SRC, 'infrastructure')))
  .concat(load(path.join(SRC, 'api')));

const inLayer = (rel: string, layer: string): boolean =>
  rel.startsWith('modules/') && rel.includes(`/${layer}/`);

/* --------------------------- 1. dependency direction ---------------------- */

describe('dependency direction', () => {
  it('domain/ imports no application, no infrastructure, and no framework', () => {
    const offenders: string[] = [];
    for (const file of ALL.filter((f) => inLayer(f.rel, 'domain'))) {
      for (const spec of file.specifiers) {
        const forbidden =
          spec.includes('/application/')
          || spec.includes('/infrastructure/')
          || spec.startsWith('drizzle-orm')
          || spec === 'pg'
          || spec.startsWith('@electric-sql/');
        if (forbidden) offenders.push(`${file.rel} -> ${spec}`);
      }
    }
    // ADR-0001. A domain that can be unit-tested without a database is the whole
    // reason 300 domain tests run in under a second.
    expect(offenders).toEqual([]);
  });

  it('application/ imports no infrastructure and no database driver', () => {
    const offenders: string[] = [];
    for (const file of ALL.filter((f) => inLayer(f.rel, 'application'))) {
      for (const spec of file.specifiers) {
        const forbidden =
          spec.includes('/infrastructure/')
          || spec.startsWith('drizzle-orm')
          || spec === 'pg';
        if (forbidden) offenders.push(`${file.rel} -> ${spec}`);
      }
    }
    // Services depend on PORTS. This is what let the entire business layer be
    // written and tested before a single table existed.
    expect(offenders).toEqual([]);
  });

  it('only infrastructure/ touches the database driver', () => {
    const users = ALL
      .filter((f) => f.specifiers.some((s) => s.startsWith('drizzle-orm') || s === 'pg'))
      .map((f) => f.rel);
    for (const rel of users) {
      expect(
        rel.startsWith('infrastructure/') || rel.includes('/infrastructure/'),
        `${rel} imports a database driver outside an infrastructure folder`,
      ).toBe(true);
    }
    expect(users.length).toBeGreaterThan(0);
  });

  it('the shared kernel depends on no bounded context', () => {
    const offenders: string[] = [];
    for (const file of ALL.filter((f) => f.rel.startsWith('modules/shared/'))) {
      for (const spec of file.specifiers) {
        if (/(hiring|interview|offer)\//.test(spec)) offenders.push(`${file.rel} -> ${spec}`);
      }
    }
    // A kernel that knows about a context is not shared, it is a hidden coupling
    // between every context that uses it.
    expect(offenders).toEqual([]);
  });

  it('the physical schema imports nothing from modules/', () => {
    const offenders = ALL
      .filter((f) => f.rel.startsWith('infrastructure/db/schema/'))
      .flatMap((f) => f.specifiers.filter((s) => s.includes('modules/')).map((s) => `${f.rel} -> ${s}`));
    expect(offenders).toEqual([]);
  });

  it('no bounded context imports another context\'s internals', () => {
    const offenders: string[] = [];
    const contexts = ['hiring', 'interview', 'offer'];
    for (const file of ALL.filter((f) => f.rel.startsWith('modules/'))) {
      const own = contexts.find((c) => file.rel.startsWith(`modules/${c}/`));
      if (own === undefined) continue;
      for (const target of file.localTargets) {
        const other = contexts.find((c) => target.startsWith(`modules/${c}/`) && c !== own);
        if (other === undefined) continue;
        // `modules/<ctx>/index.ts` is the ONLY legal entry point.
        if (target !== `modules/${other}/index.ts`) offenders.push(`${file.rel} -> ${target}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

/* ------------------------------- 2. acyclicity ---------------------------- */

describe('module graph', () => {
  it('contains no import cycles', () => {
    const graph = new Map<string, readonly string[]>(
      ALL.map((f) => [f.rel, f.localTargets.filter((t) => ALL.some((o) => o.rel === t))]),
    );

    const WHITE = 0, GREY = 1, BLACK = 2;
    const colour = new Map<string, number>([...graph.keys()].map((k) => [k, WHITE]));
    const cycles: string[] = [];

    const visit = (node: string, stack: string[]): void => {
      colour.set(node, GREY);
      for (const next of graph.get(node) ?? []) {
        const state = colour.get(next) ?? BLACK;
        if (state === GREY) {
          cycles.push([...stack.slice(stack.indexOf(next)), next].join(' -> '));
        } else if (state === WHITE) {
          visit(next, [...stack, next]);
        }
      }
      colour.set(node, BLACK);
    };

    for (const node of graph.keys()) {
      if (colour.get(node) === WHITE) visit(node, [node]);
    }

    // A cycle is not merely untidy: it makes module initialisation order
    // undefined, which surfaces as an intermittent `undefined is not a
    // constructor` that only reproduces in one import order.
    expect(cycles).toEqual([]);
  });

  it('reaches every infrastructure adapter from its module, not the reverse', () => {
    // Adapters may import the shared persistence primitives and the physical
    // schema. Nothing under infrastructure/db may import a module's adapter —
    // that would make the generic layer depend on a specific context.
    const offenders = ALL
      .filter((f) => f.rel.startsWith('infrastructure/db/') && !f.rel.includes('/testing/'))
      .flatMap((f) => f.specifiers
        .filter((s) => /modules\/(hiring|interview|offer)\/infrastructure/.test(s))
        .map((s) => `${f.rel} -> ${s}`));
    expect(offenders).toEqual([]);
  });
});

/* ------------------------ 3. the API layer is thin ------------------------ */

describe('API layer', () => {
  const controllers = ALL.filter((f) => f.rel.startsWith('api/controllers/'));

  it('has controllers, and they reach no repository, aggregate or driver', () => {
    expect(controllers.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const file of controllers) {
      for (const spec of file.specifiers) {
        const forbidden =
          spec.includes('/domain/')
          || spec.includes('/infrastructure/')
          || spec.startsWith('drizzle-orm')
          || spec === 'pg';
        // A controller talks to an application service and to its own HTTP
        // helpers. Reaching a repository means it is about to do persistence,
        // and reaching an aggregate means it is about to make a decision.
        if (forbidden) offenders.push(`${file.rel} -> ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps every domain decision out of the controllers', () => {
    const offenders: string[] = [];
    for (const file of controllers) {
      const code = fs.readFileSync(path.join(SRC, file.rel), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
      // Calling an aggregate method, or branching on a stored state, would mean
      // the decision moved out of the service and into HTTP.
      for (const [pattern, why] of [
        // Aggregate-only names. `adjustHeadcount` is deliberately absent: the
        // SERVICE has a method of the same name, and flagging it would make
        // this test cry wolf on correct code.
        [/\.fillSeat\(|\.releaseSeat\(|\.transitionTo\(|\.pullEvents\(|\.toState\(/, 'invokes an aggregate method'],
        [/if\s*\([^)]*\.(state|stage|status)\s*===/, 'branches on domain state'],
        [/new (Requisition|Application|Interview|Offer)\b/, 'constructs an aggregate'],
      ] as const) {
        if (pattern.test(code)) offenders.push(`${file.rel}: ${why}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('only the composition root wires implementations together', () => {
    // Controllers receive services. If one imported a Unit of Work it would be
    // building its own object graph, and the single wiring point would be gone.
    const offenders = controllers.flatMap((f) =>
      f.specifiers.filter((s) => /unit-of-work|composition-root/.test(s)).map((s) => `${f.rel} -> ${s}`));
    expect(offenders).toEqual([]);
  });
});

/* --------------------------- 4. the AI boundary --------------------------- */

describe('AI ports', () => {
  const aiFiles = ALL.filter((f) => f.rel.startsWith('modules/shared/kernel/ai/'));

  it('exist and import nothing but the kernel itself', () => {
    expect(aiFiles.length).toBeGreaterThan(0);
    const offenders = aiFiles.flatMap((f) => f.specifiers
      .filter((s) => !s.startsWith('.'))
      .map((s) => `${f.rel} -> ${s}`));
    // A port that imports a driver, an HTTP client or a model SDK is not a port.
    expect(offenders).toEqual([]);
  });

  it('name no model, provider or transport', () => {
    const banned = /\b(ollama|qwen|openai|anthropic|llama|gpt|huggingface|pgvector|axios|fetch\()/i;
    for (const file of aiFiles) {
      const code = fs.readFileSync(path.join(SRC, file.rel), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
      // Capabilities, not models. Naming one here would make it the interface.
      expect(banned.test(code), `${file.rel} names a model or transport`).toBe(false);
    }
  });

  it('declare no method that mutates state', () => {
    for (const file of aiFiles) {
      const code = fs.readFileSync(path.join(SRC, file.rel), 'utf8');
      // AI is advisory. `apply`/`save`/`update` on a port would let a model
      // write to the system without passing through a domain rule.
      expect(/^\s+(apply|save|update|delete|persist)\s*[(<]/m.test(code)).toBe(false);
    }
  });

  it('are not depended on by any aggregate or repository', () => {
    const offenders: string[] = [];
    for (const file of ALL) {
      const isDomain = inLayer(file.rel, 'domain');
      const isRepo = file.rel.includes('/infrastructure/')
        && /repository|repositories|unit-of-work|mappers/.test(file.rel);
      if (!isDomain && !isRepo) continue;
      for (const spec of file.specifiers) {
        if (/kernel\/ai|\/ai\//.test(spec)) offenders.push(`${file.rel} -> ${spec}`);
      }
    }
    // AGGREGATES AND REPOSITORIES STAY AI-FREE, permanently. An aggregate that
    // knows about a model cannot be reasoned about without one, and a
    // repository that does would put inference on the persistence path.
    expect(offenders).toEqual([]);
  });

  it('reach application services only as OPTIONAL ports, never as adapters', () => {
    const services = ALL.filter((f) => inLayer(f.rel, 'application'));
    const usingAi = services.filter((f) => f.specifiers.some((s) => /kernel\/ai/.test(s)));

    for (const file of usingAi) {
      // A service may depend on the PORT. Importing an adapter would bind the
      // business layer to one provider, which is the whole thing being avoided.
      const offenders = file.specifiers.filter(
        (s) => /infrastructure\/ai|ollama|qwen/i.test(s),
      );
      expect(offenders, `${file.rel} imports an AI adapter`).toEqual([]);

      // And the dependency must be OPTIONAL, so the system runs with no
      // provider configured at all.
      const source = fs.readFileSync(path.join(SRC, file.rel), 'utf8');
      expect(
        /readonly ai\?:|ai\?:\s*AITaskDispatcher/.test(source),
        `${file.rel} must declare its AI dependency optional`,
      ).toBe(true);
    }
  });
});

/* ---------------------- 5. no business logic in storage ------------------- */

describe('infrastructure introduces no business assumptions', () => {
  const adapters = ALL.filter((f) => f.rel.includes('/infrastructure/') || f.rel.startsWith('infrastructure/'));

  it('defines no salary ratio, derivation or computed total', () => {
    const offenders: string[] = [];
    for (const file of adapters) {
      const source = fs.readFileSync(path.join(SRC, file.rel), 'utf8');
      // Strip comments: the 40/30/30 rejection is DISCUSSED in several headers,
      // and a naive grep would flag the explanation of why it is absent.
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
      if (/\*\s*0\.[34]|0\.[34]\s*\*/.test(code)) offenders.push(`${file.rel}: ratio arithmetic`);
    }
    expect(offenders).toEqual([]);
  });

  it('never decides a stage or state transition', () => {
    const offenders: string[] = [];
    for (const file of adapters) {
      const source = fs.readFileSync(path.join(SRC, file.rel), 'utf8');
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
      // Writing a stage is fine (that is persistence). CHOOSING one is not.
      if (/\bstage\s*=\s*'(?!.*\$)/.test(code)) offenders.push(`${file.rel}: assigns a stage`);
      if (/transitionTo\(|\.fillSeat\(|\.approve\(/.test(code)) {
        offenders.push(`${file.rel}: invokes a domain mutation`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

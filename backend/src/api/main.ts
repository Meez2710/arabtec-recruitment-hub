// Process entry point for the new API.
//
// Separate from the legacy `src/server.js`, which is untouched and still serves
// production. Run this one with `npm run api`.
//
// Everything below is process concerns and nothing else: read config, open a
// pool, compose, listen, start workers, shut down cleanly. No wiring decisions —
// those all live in the composition root.

import 'dotenv/config';
import { createDb, createPool } from '../infrastructure/db/client.js';
import { compose } from './composition-root.js';
import { configFromEnv } from './infrastructure/gateways.js';
import { createApiApp } from './server.js';
import { JwtTokenVerifier } from './auth/authenticate.js';
import { LegacyPrincipalResolver } from './auth/legacy-principal-resolver.js';
import { startOfferExpiryWorker, startOutboxWorker, startAITaskWorker } from './workers/outbox-worker.js';
import { PlainTextDocumentParser } from '../infrastructure/ai/plain-text-parser.js';
import { OllamaResumeExtractor } from '../infrastructure/ai/ollama/ollama-resume-extractor.js';

const log = (level: 'info' | 'error', message: string, extra: unknown = {}): void => {
  // Structured, one line per event, so a log aggregator can index it. A real
  // logger goes here when one is chosen; the shape does not change.
  // eslint-disable-next-line no-console
  console[level === 'error' ? 'error' : 'log'](JSON.stringify({
    level, message, at: new Date().toISOString(), ...(extra as object),
  }));
};

const main = async (): Promise<void> => {
  const connectionString = process.env['DATABASE_URL'];
  if (connectionString === undefined || connectionString === '') {
    throw new Error('DATABASE_URL is required.');
  }

  const pool = createPool({ connectionString });
  const db = createDb(pool);

  const capabilities = {
    documentParser: new PlainTextDocumentParser(),
    resumeExtractor: new OllamaResumeExtractor({ 
      model: 'llama3.2',
      ...(process.env['OLLAMA_BASE_URL'] ? { baseUrl: process.env['OLLAMA_BASE_URL'] } : {})
    }),
  };

  const app = compose(db, {
    capabilities,
    config: configFromEnv(),
    onError: (error) => { log('error', 'event delivery failed', { error: String(error) }); },
  });

  const corsOrigins = process.env['CORS_ORIGINS']?.split(',').map((o) => o.trim()).filter(Boolean);

  const server = createApiApp({
    app,
    verifier: new JwtTokenVerifier(),
    principals: new LegacyPrincipalResolver(),
    ...(corsOrigins && corsOrigins.length > 0 ? { corsOrigins } : {}),
    onDefect: (error, info) => {
      log('error', 'unhandled request failure', { error: String(error), ...info });
    },
  });

  const port = Number(process.env['API_PORT'] ?? 4000);
  const listening = server.listen(port, () => {
    log('info', 'api listening', { port, env: process.env['NODE_ENV'] ?? 'development' });
  });

  // Workers are opt-out so a single-process deployment works by default, and
  // opt-out-able so a web dyno and a worker dyno can run the same image.
  const workers = process.env['RUN_WORKERS'] === 'false' ? [] : [
    startOutboxWorker(db, app.dispatcher, {
      onError: (error) => { log('error', 'outbox worker', { error: String(error) }); },
    }),
    startOfferExpiryWorker(app.offers, {
      onError: (error) => { log('error', 'expiry worker', { error: String(error) }); },
    }),
    ...(app.aiWorker ? [startAITaskWorker(app.aiWorker, {
      onError: (error) => { log('error', 'ai worker', { error: String(error) }); },
    })] : []),
  ];

  const shutdown = (signal: string): void => {
    log('info', 'shutting down', { signal });
    // Order matters: stop taking work, stop the workers, then release the pool.
    // Closing the pool first would make in-flight requests fail on the way out.
    listening.close(() => {
      for (const worker of workers) worker.stop();
      void pool.end().then(() => { process.exit(0); });
    });
    // Do not hang forever on a stuck connection.
    setTimeout(() => { process.exit(1); }, 10_000).unref();
  };

  process.on('SIGTERM', () => { shutdown('SIGTERM'); });
  process.on('SIGINT', () => { shutdown('SIGINT'); });
};

main().catch((error: unknown) => {
  log('error', 'failed to start', { error: String(error) });
  process.exit(1);
});

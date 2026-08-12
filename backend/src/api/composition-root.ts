// Composition root — the ONE place that knows how everything fits together.
//
// Every `new` for a service, repository, Unit of Work, gateway or subscriber
// happens here and nowhere else. No module imports another module's
// implementation; they receive interfaces. That is what has let the domain be
// tested without a database, the services without HTTP, and the repositories
// against two different drivers.
//
// It is also where the circular dependency between Hiring and Offer is resolved.
// `OfferService` needs a `PipelineGateway` (to move an application when an offer
// is sent) and `RequisitionService` needs an `OfferGateway` (to refuse closing a
// requisition with live offers). Neither module imports the other — both take a
// port — and the cycle exists only in this file, where it is broken by
// constructing `PipelineService` first and handing it over as the gateway.

import type { Executor } from '../infrastructure/db/types.js';
import { EventDispatcher } from '../infrastructure/events/event-dispatcher.js';
import { SubscriberRegistry } from '../infrastructure/events/subscriber.js';
import { InProcessEventBus } from '../infrastructure/events/in-process-event-bus.js';
import { createPostCommitRelay } from '../infrastructure/db/outbox-relay.js';
import { DrizzleHiringUnitOfWork } from '../modules/hiring/infrastructure/unit-of-work.js';
import { DrizzleInterviewUnitOfWork } from '../modules/interview/infrastructure/unit-of-work.js';
import { DrizzleOfferUnitOfWork } from '../modules/offer/infrastructure/unit-of-work.js';
import { RequisitionService } from '../modules/hiring/application/requisition-service.js';
import { PipelineService } from '../modules/hiring/application/pipeline-service.js';
import { HiringService } from '../modules/hiring/application/hiring-service.js';
import { InterviewService } from '../modules/interview/application/interview-service.js';
import { OfferService } from '../modules/offer/application/offer-service.js';
import { DrizzleTalentUnitOfWork } from '../modules/talent/infrastructure/unit-of-work.js';
import { InMemoryDocumentStore } from '../modules/talent/infrastructure/document-store.js';
import { CandidateService } from '../modules/talent/application/candidate-service.js';
import { ProposalService } from '../modules/talent/application/proposal-service.js';
import { CvIntakeService } from '../modules/talent/application/intake-service.js';
import { MatchingService } from '../modules/matching/index.js';
import { DrizzleMatchingUnitOfWork } from '../modules/matching/infrastructure/repository.js';
import { HiringPipelineLinkGateway } from './infrastructure/pipeline-link-gateway.js';
import type { DocumentStore } from '../modules/talent/application/ports.js';
import { DrizzleAITaskDispatcher } from '../infrastructure/ai/task-dispatcher.js';
import { AITaskWorker } from '../infrastructure/ai/task-worker.js';
import { DocumentUnderstandingPipeline } from '../infrastructure/ai/document/index.js';
import { DoclingDocumentParser } from '../infrastructure/ai/docling/index.js';
import { LocalDocumentParser } from '../infrastructure/ai/local/local-document-parser.js';
import { HttpOcrEngine } from '../infrastructure/ai/ocr/index.js';
import { OllamaResumeExtractor } from '../infrastructure/ai/ollama/index.js';
import { PlainTextDocumentParser } from '../infrastructure/ai/plain-text-parser.js';
import { OllamaCompetencyEvaluator } from '../infrastructure/ai/evaluation/index.js';
import type { CandidateEvaluator } from '../infrastructure/ai/evaluation/index.js';
import type { AICapabilities, AITaskDispatcher } from '../modules/shared/kernel/ai/index.js';
import type { NotificationHub } from '../modules/shared/kernel/ports.js';
import { AuditSubscriber } from './infrastructure/subscribers/audit-subscriber.js';
import {
  NotificationSubscriber, RecordingNotificationHub,
} from './infrastructure/subscribers/notification-subscriber.js';
import {
  ConfigApprovalSettings, ConfigOfferSettings, DEFAULT_CONFIG, DrizzleOfferGateway,
} from './infrastructure/gateways.js';
import type { PlatformConfig } from './infrastructure/gateways.js';
import { currentCorrelationId } from './http/request-context.js';
import { DrizzleReadModel } from './infrastructure/queries/read-model.js';
import type { ReadModel } from './queries/ports.js';
import { DrizzleTalentReadModel } from './infrastructure/queries/talent-read-model.js';
import type { TalentReadModel } from './queries/talent-ports.js';
import { DrizzleMatchingReadModel } from './infrastructure/queries/matching-read-model.js';
import type { MatchingReadModel } from './queries/matching-ports.js';
import { DrizzleSearchReadModel } from './infrastructure/queries/search-read-model.js';
import type { SearchReadModel } from './queries/search-ports.js';

/* ------------------------- AI capabilities from env ------------------------ */
//
// Building the AI capabilities is a wiring decision, so it lives HERE with every
// other wiring decision rather than in a process entry point. Both entry points
// call this: `api/main.ts` and, through the compiled output, the deployed
// `src/server.js` parser provider. One definition, one answer to "which engine
// read this CV?".

export interface AIComposition {
  readonly capabilities: AICapabilities;
  /** Absent when no model is configured. Evaluation is optional, not required. */
  readonly evaluator?: CandidateEvaluator;
  /** What was selected. For the startup log and the health endpoint. */
  readonly description: {
    readonly layoutParser: string;
    readonly fallbackParser: string;
    readonly ocrEngine: string;
    readonly extractor: string;
    readonly evaluator: string;
  };
}

const readEnv = (env: NodeJS.ProcessEnv, key: string): string | undefined => {
  const value = env[key];
  return value === undefined || value.trim() === '' ? undefined : value.trim();
};

/**
 * Compose the document pipeline and the model capabilities from the environment.
 *
 * Docling is the primary structured parser when a sidecar is configured; the
 * local pdfjs/mammoth parser is the fallback implementation of the SAME
 * `DocumentParser` port. Both sit behind `DocumentUnderstandingPipeline`, which
 * is itself a `DocumentParser` — so everything downstream sees one port.
 */
export const composeAI = (env: NodeJS.ProcessEnv = process.env): AIComposition => {
  const doclingBaseUrl = readEnv(env, 'DOCLING_BASE_URL');
  const local = new LocalDocumentParser();
  const layoutParser = doclingBaseUrl === undefined
    ? local
    : new DoclingDocumentParser({
      baseUrl: doclingBaseUrl,
      ...(readEnv(env, 'DOCLING_TIMEOUT_MS') !== undefined
        ? { timeoutMs: Number(readEnv(env, 'DOCLING_TIMEOUT_MS')) } : {}),
      ...(readEnv(env, 'DOCLING_PIPELINE_VERSION') !== undefined
        ? { pipelineVersion: readEnv(env, 'DOCLING_PIPELINE_VERSION') } : {}),
    });

  // Provider-neutral: swapping PaddleOCR for OpenOCR is these two variables.
  const ocrBaseUrl = readEnv(env, 'OCR_BASE_URL');
  const ocrEngine = ocrBaseUrl === undefined ? undefined : new HttpOcrEngine({
    baseUrl: ocrBaseUrl,
    engineName: readEnv(env, 'OCR_ENGINE') ?? 'http-ocr',
    ...(readEnv(env, 'OCR_PATH') !== undefined ? { path: readEnv(env, 'OCR_PATH') } : {}),
    ...(readEnv(env, 'OCR_TIMEOUT_MS') !== undefined
      ? { timeoutMs: Number(readEnv(env, 'OCR_TIMEOUT_MS')) } : {}),
  });

  const documentParser = new DocumentUnderstandingPipeline({
    layoutParser,
    textParser: new PlainTextDocumentParser(),
    ...(layoutParser === local ? {} : { fallbackParser: local }),
    ...(ocrEngine !== undefined ? { ocrEngine } : {}),
  });

  const ollamaBaseUrl = readEnv(env, 'OLLAMA_BASE_URL');
  const model = readEnv(env, 'OLLAMA_MODEL') ?? 'llama3.2';
  const resumeExtractor = ollamaBaseUrl === undefined ? undefined : new OllamaResumeExtractor({
    baseUrl: ollamaBaseUrl, model,
  });
  const evaluator = ollamaBaseUrl === undefined ? undefined : new OllamaCompetencyEvaluator({
    baseUrl: ollamaBaseUrl, model,
  });

  return {
    capabilities: {
      documentParser,
      ...(resumeExtractor !== undefined ? { resumeExtractor } : {}),
      ...(ocrEngine !== undefined ? { ocrEngine } : {}),
    },
    ...(evaluator !== undefined ? { evaluator } : {}),
    description: {
      layoutParser: doclingBaseUrl === undefined ? 'local-pdfjs-mammoth' : 'docling-sidecar',
      fallbackParser: doclingBaseUrl === undefined ? 'none' : 'local-pdfjs-mammoth',
      ocrEngine: ocrEngine?.name ?? 'none',
      // Deterministic rules ALWAYS run. A model, when present, is a second
      // reader whose answers are located in the document — never a replacement.
      extractor: resumeExtractor === undefined ? 'deterministic-rules' : `rules+${model}`,
      evaluator: evaluator === undefined ? 'none' : model,
    },
  };
};

export interface CompositionOptions {
  readonly config?: PlatformConfig;
  readonly notifications?: NotificationHub;
  /** Surfaces relay and subscriber failures without coupling this file to a logger. */
  readonly onError?: (error: unknown) => void;
  /** Deterministic ticket/offer numbers under test. */
  readonly year?: () => number;
  /** Defaults to in-memory. Production passes a filesystem or object store. */
  readonly documents?: DocumentStore;
  /**
   * OPTIONAL. Omit and no AI exists: no parse task is submitted, and any task
   * already queued abstains with a clear reason. Nothing degrades.
   */
  readonly capabilities?: AICapabilities;
}

export interface Application {
  readonly requisitions: RequisitionService;
  readonly pipeline: PipelineService;
  readonly hiring: HiringService;
  readonly interviews: InterviewService;
  readonly offers: OfferService;
  readonly candidates: CandidateService;
  readonly proposals: ProposalService;
  readonly intake: CvIntakeService;
  readonly matching: MatchingService;
  readonly read: ReadModel;
  readonly talentRead: TalentReadModel;
  readonly matchingRead: MatchingReadModel;
  readonly search: SearchReadModel;
  /** Null when no capability is configured. */
  readonly ai: AITaskDispatcher | null;
  readonly aiWorker: AITaskWorker | null;
  readonly dispatcher: EventDispatcher;
  readonly registry: SubscriberRegistry;
  readonly audit: AuditSubscriber;
  readonly notifications: NotificationHub;
  readonly db: Executor;
  readonly config: PlatformConfig;
}

export const compose = (db: Executor, opts: CompositionOptions = {}): Application => {
  const config = opts.config ?? DEFAULT_CONFIG;

  /* --- events: subscribers first, so the relay has somewhere to deliver --- */
  const notifications = opts.notifications ?? new RecordingNotificationHub();
  const audit = new AuditSubscriber(db);
  const registry = new SubscriberRegistry()
    // Registration order IS delivery order. Audit first, deliberately: the
    // trail should record what happened even on a run where notification
    // delivery is failing.
    .register(audit)
    .register(new NotificationSubscriber(notifications));

  const dispatcher = new EventDispatcher(db, registry, {
    ...(opts.onError ? { onHandlerError: (_c, _e, error): void => opts.onError?.(error) } : {}),
  });

  /* ------------------------- units of work -------------------------------- */
  // Every one gets the relay and the correlation-id reader. The correlation id
  // is read lazily, per transaction, from the ambient request context — which
  // is why the outbox rows of one HTTP request all share one id without any
  // service having heard of HTTP.
  const shared = {
    relay: createPostCommitRelay(db, dispatcher),
    correlationId: currentCorrelationId,
    ...(opts.onError ? { onRelayError: opts.onError } : {}),
    ...(opts.year ? { year: opts.year } : {}),
  };

  const hiringUow = new DrizzleHiringUnitOfWork(db, shared);
  const interviewUow = new DrizzleInterviewUnitOfWork(db, shared);
  const offerUow = new DrizzleOfferUnitOfWork(db, shared);
  const talentUow = new DrizzleTalentUnitOfWork(db, shared);
  const matchingUow = new DrizzleMatchingUnitOfWork(db, shared);

  /* --------------------------- services ----------------------------------- */
  // `InProcessEventBus` is what a service publishes through. In practice it is
  // called with an empty array — the repositories drain events into the outbox
  // and the Unit of Work relays after commit (ADR-0011). It carries only the
  // unsaved-aggregate case.
  const events = new InProcessEventBus(dispatcher);

  // BREAK THE CYCLE HERE. Pipeline has no dependency on Offer, so it can be
  // built first and passed to Offer as the gateway.
  const pipeline = new PipelineService({ uow: hiringUow, events });

  const requisitions = new RequisitionService({
    uow: hiringUow,
    events,
    settings: new ConfigApprovalSettings(config),
    offers: new DrizzleOfferGateway(db),
  });

  const hiring = new HiringService({ uow: hiringUow, events });
  const interviews = new InterviewService({ uow: interviewUow, events });

  const offers = new OfferService({
    uow: offerUow,
    events,
    settings: new ConfigOfferSettings(config),
    pipeline,
  });

  const documents = opts.documents ?? new InMemoryDocumentStore();
  const proposals = new ProposalService({ uow: talentUow, events });

  // AI is wired only when a capability exists. `ai: null` is a first-class
  // configuration, not a degraded one.
  const capabilities = opts.capabilities;
  const hasCapability = capabilities !== undefined
    && Object.values(capabilities).some((c) => c !== undefined);
  const ai = hasCapability ? new DrizzleAITaskDispatcher(db) : null;
  const candidates = new CandidateService({
    uow: talentUow, events, documents, ...(ai !== null ? { ai } : {}),
  });
  const intake = new CvIntakeService({
    uow: talentUow, events, documents, ...(ai !== null ? { ai } : {}),
  });

  // Matching reaches Hiring only through the gateway — the cycle lives here,
  // in the one file allowed to know both sides.
  const matching = new MatchingService({
    uow: matchingUow, events,
    pipeline: new HiringPipelineLinkGateway(pipeline),
    ...(ai !== null ? { ai } : {}),
  });

  const aiWorker = hasCapability && capabilities !== undefined
    ? new AITaskWorker(db, { capabilities, documents, proposals, intake, matching })
    : null;

  return {
    requisitions, pipeline, hiring, interviews, offers, candidates, proposals, intake, matching,
    read: new DrizzleReadModel(db),
    talentRead: new DrizzleTalentReadModel(db),
    matchingRead: new DrizzleMatchingReadModel(db),
    // The normaliser is optional; without it search is plain text matching.
    search: new DrizzleSearchReadModel(
      db, capabilities !== undefined ? { capabilities } : {},
    ),
    ai, aiWorker,
    dispatcher, registry, audit, notifications, db, config,
  };
};

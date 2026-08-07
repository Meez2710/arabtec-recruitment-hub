// AI ports — the complete AI surface the business layer may see.
//
// No adapter exists yet and none is imported here. The Ollama/Qwen adapter will
// live in `infrastructure/ai/` and be wired only in the composition root.

export { AI_CAPABILITIES, AI_EVENTS, isProposal } from './contracts.js';
export type {
  AIAbstention, AICapability, AIEntityRef, AIEventType, AIOutcome, AIProposal,
  AIProvenance, AIResultEvent, AIResultEventPayload,
  AITaskDispatcher, AITaskHandle, AITaskRequest, AITaskState,
} from './contracts.js';

export type {
  AICapabilities, AnalyzedJobDescription, CandidateMatch, CandidateMatcher,
  CandidateRankingService, DocumentParser, EmbeddingVector, ExtractedEducation,
  ExtractedEmployment, ExtractedPeriod, ExtractedResume, JobDescriptionAnalyzer,
  MatchCriteria, MatchEvidence, NormalizedSkill, ParsedDocument, RankedCandidate,
  ResumeEmbeddingProvider, ResumeExtractor, SkillNormalizer, SourceDocument,
} from './capabilities.js';

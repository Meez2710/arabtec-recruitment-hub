// Public surface of the Matching module.

export { MatchingService, MATCHING_PERMISSIONS } from './application/matching-service.js';
export type {
  MatchSummary, MatchingServiceDeps, SuggestionInput,
} from './application/matching-service.js';
export type {
  CandidateMatchRepository, MatchingTransactionScope, MatchingUnitOfWork, PipelineLinkGateway,
} from './application/ports.js';
export { MATCH_STATUSES } from './domain/match.js';
export type { MatchEvidenceItem, MatchGeneration, MatchStatus } from './domain/match.js';
export { MATCHING_EVENTS } from './domain/events.js';
export { MatchAlreadyResolvedError, MatchingDomainError } from './domain/errors.js';
export type { MatchingErrorCode } from './domain/errors.js';

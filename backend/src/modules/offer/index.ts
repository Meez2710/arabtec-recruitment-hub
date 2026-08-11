// Public surface of the Offer module.

export { OfferService, OFFER_PERMISSIONS } from './application/offer-service.js';
export type {
  OfferServiceDeps, OfferSettings, OfferSummary, OfferRepository,
  OfferUnitOfWork, OfferTransactionScope, OfferTemplateResolver,
} from './application/offer-service.js';

export { OFFER_STATUSES } from './domain/offer.js';
export type {
  ApprovalRequirement, CompensationLine, OfferStatus,
} from './domain/offer.js';

export { OFFER_EVENTS, OFFER_EVENT_TYPES, isOfferEventType } from './domain/events.js';
export type { OfferEventType } from './domain/events.js';

export {
  CompensationLockedError, IllegalOfferTransitionError, LiveOfferExistsError, OfferDomainError,
  OfferReasonRequiredError, OfferSelfApprovalError, UnknownComponentError,
} from './domain/errors.js';
export type { OfferErrorCode } from './domain/errors.js';

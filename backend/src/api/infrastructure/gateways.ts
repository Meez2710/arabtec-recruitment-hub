// Cross-context gateways and settings adapters (ADR-0007).
//
// A gateway is how one context asks another a question WITHOUT importing its
// internals. Hiring needs to know "does this requisition have live offers?" to
// decide whether it may close; it must not import `Offer`, and Offer must not
// know that closing exists. The gateway is the seam, and it is implemented here
// — in the composition layer — because only the composition root is allowed to
// know both sides.

import { and, eq, inArray } from 'drizzle-orm';
import { hiringApplication, offer } from '../../infrastructure/db/schema/index.js';
import type { Executor } from '../../infrastructure/db/types.js';
import { executorFor } from '../../infrastructure/db/current-transaction.js';
import type { AuthContext } from '../../modules/shared/kernel/auth-context.js';
import type { OfferGateway } from '../../modules/hiring/index.js';
import type { ApprovalSettings } from '../../modules/hiring/application/requisition-service.js';
import type { OfferSettings } from '../../modules/offer/application/offer-service.js';
import type { ApprovalRequirement } from '../../modules/offer/index.js';

/** Statuses that mean "the candidate is holding a letter we are waiting on". */
const LIVE = ['SENT', 'ACCEPTED'] as const;

/**
 * Hiring -> Offer.
 *
 * A single indexed query, not a load of every offer. Reads the offer TABLE
 * directly rather than going through `OfferService`: this is a projection for a
 * decision Hiring is making, and routing it through another service's use cases
 * would drag that service's permission checks into an unrelated operation.
 *
 * Runs on the AMBIENT transaction when there is one. `RequisitionService.close`
 * calls this while holding a row lock; using the injected root handle would take
 * a second pooled connection and read outside the transaction — or, on a
 * single-connection driver, deadlock outright. See current-transaction.ts.
 */
export class DrizzleOfferGateway implements OfferGateway {
  constructor(private readonly db: Executor) {}

  async applicationsWithLiveOffers(
    requisitionId: number,
    ctx: AuthContext,
  ): Promise<readonly number[]> {
    const rows = await executorFor(this.db)
      .selectDistinct({ applicationId: offer.applicationId })
      .from(offer)
      .innerJoin(hiringApplication, eq(hiringApplication.id, offer.applicationId))
      .where(and(
        eq(offer.tenantId, ctx.tenantId),
        eq(offer.requisitionId, requisitionId),
        inArray(offer.status, [...LIVE]),
      ));
    return rows.map((r) => r.applicationId);
  }
}

/* ------------------------------- settings --------------------------------- */
// Configuration, not policy. Every value is admin-changeable and none of it is
// a business rule the domain does not already own.

export interface PlatformConfig {
  /** Whether a requisition needs approval before it can open. */
  readonly requisitionApprovalRequired: boolean;
  /**
   * Total above which a director must approve an offer (BL-11).
   *
   * `null` means "could not be determined", and the aggregate fails CLOSED on
   * null — it requires director approval rather than skipping it. An
   * unparseable config must never quietly weaken an approval gate.
   */
  readonly offerDirectorThreshold: number | null;
  readonly offerThresholdCurrency: string;
  /** "This Offer of Employment is valid for 5 days from the document date." */
  readonly offerValidityDays: number;
  readonly compensationComponents: readonly string[];
}

export const DEFAULT_CONFIG: PlatformConfig = {
  requisitionApprovalRequired: true,
  offerDirectorThreshold: null,
  offerThresholdCurrency: 'EGP',
  offerValidityDays: 5,
  compensationComponents: [
    'BASIC_SALARY', 'ACCOMMODATION', 'TRANSPORTATION', 'OTHERS', 'AREA_ALLOWANCE',
  ],
};

/**
 * Read config from the environment.
 *
 * A threshold that fails to parse becomes `null`, NOT a default number — see
 * above. Silently substituting a value would be the failure mode BL-11 exists
 * to prevent.
 */
export const configFromEnv = (env: NodeJS.ProcessEnv = process.env): PlatformConfig => {
  const rawThreshold = env['OFFER_DIRECTOR_THRESHOLD'];
  const parsed = rawThreshold === undefined ? Number.NaN : Number(rawThreshold);
  const validity = Number(env['OFFER_VALIDITY_DAYS'] ?? DEFAULT_CONFIG.offerValidityDays);

  return {
    requisitionApprovalRequired: env['REQUISITION_APPROVAL_REQUIRED'] !== 'false',
    offerDirectorThreshold: Number.isFinite(parsed) && parsed >= 0 ? parsed : null,
    offerThresholdCurrency: env['OFFER_THRESHOLD_CURRENCY'] ?? DEFAULT_CONFIG.offerThresholdCurrency,
    offerValidityDays: Number.isFinite(validity) && validity > 0
      ? validity
      : DEFAULT_CONFIG.offerValidityDays,
    compensationComponents: DEFAULT_CONFIG.compensationComponents,
  };
};

export class ConfigApprovalSettings implements ApprovalSettings {
  constructor(private readonly config: PlatformConfig) {}
  async approvalRequired(): Promise<boolean> {
    return this.config.requisitionApprovalRequired;
  }
}

export class ConfigOfferSettings implements OfferSettings {
  constructor(private readonly config: PlatformConfig) {}

  async approvalRequirement(_ctx: AuthContext): Promise<ApprovalRequirement> {
    return {
      directorThreshold: this.config.offerDirectorThreshold,
      thresholdCurrency: this.config.offerThresholdCurrency,
    };
  }

  async validityDays(): Promise<number> {
    return this.config.offerValidityDays;
  }

  async compensationComponents(): Promise<readonly string[]> {
    return this.config.compensationComponents;
  }
}

// Matching -> Hiring gateway (ADR-0007).
//
// Implemented in the composition layer because only it may know both sides.
// Delegates to the Hiring context's PUBLISHED service, so a link created from a
// suggestion goes through exactly the rules and permissions a manual link does.

import type { AuthContext } from '../../modules/shared/kernel/auth-context.js';
import type { PipelineLinkGateway } from '../../modules/matching/index.js';
import type { PipelineService } from '../../modules/hiring/application/pipeline-service.js';

export class HiringPipelineLinkGateway implements PipelineLinkGateway {
  constructor(private readonly pipeline: PipelineService) {}

  async addCandidate(
    input: { requisitionId: number; candidateId: number },
    ctx: AuthContext,
  ): Promise<number> {
    const application = await this.pipeline.addCandidate(input, ctx);
    return application.id;
  }
}

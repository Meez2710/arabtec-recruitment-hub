// Smart search — one endpoint for the top-bar search box.

import type { Router } from 'express';
import { Router as createRouter } from 'express';
import { z } from 'zod';
import { TALENT_PERMISSIONS } from '../../modules/talent/index.js';
import { HIRING_PERMISSIONS } from '../../modules/hiring/index.js';
import { requirePermission } from '../auth/authenticate.js';
import { route } from '../http/validate.js';
import type { SearchReadModel } from '../queries/search-ports.js';

const searchQuery = z.object({
  q: z.string().trim().min(1).max(200),
  types: z.union([z.string(), z.array(z.string())]).optional(),
  limitPerType: z.coerce.number().int().min(1).max(50).default(10),
});

const TYPES = ['Candidate', 'Requisition'] as const;

export const searchRoutes = (read: SearchReadModel): Router => {
  const router = createRouter();

  router.get('/search', requirePermission(
    TALENT_PERMISSIONS.VIEW_ALL, TALENT_PERMISSIONS.VIEW_OWN,
    HIRING_PERMISSIONS.VIEW_ALL, HIRING_PERMISSIONS.VIEW_OWN,
  ), route(
    { query: searchQuery },
    async ({ query, auth }, res) => {
      const requested = query.types === undefined
        ? undefined
        : (Array.isArray(query.types) ? query.types : [query.types])
          .flatMap((v) => v.split(',')).map((v) => v.trim())
          .filter((v): v is typeof TYPES[number] => (TYPES as readonly string[]).includes(v));

      // Each entity type is scoped by its own rules inside the read model —
      // candidates by tenant, requisitions by project. A single search must not
      // become the one place scope is forgotten.
      res.json(await read.search(query.q, {
        ...(requested !== undefined && requested.length > 0 ? { types: requested } : {}),
        limitPerType: query.limitPerType,
      }, auth));
    },
  ));

  return router;
};

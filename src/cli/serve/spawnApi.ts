import { Router } from 'express';

import { manualSiblingRequest } from '../spawn.js';
import { respondJson } from './apiResponse.js';

/**
 * **The `/api/runs/<branch>/siblings` writer** (ADR-0013): the BFF's manual
 * child request. The runs namespace stays read-only on purpose (ADR-0010);
 * this POST is the one sanctioned write. The UI's "spawn a child" button
 * funnels into the same spool write as `e spawn --parent <branch>` - never a
 * container - and the parent's own `SiblingConsumer` picks the request up
 * like any broker sibling. A run branch spans several segments
 * (`e/<agent>/<slug>-N`), so the branch is every path segment after
 * `/api/runs/`, matching how {@link runsRoutes} reads its views.
 */
export function spawnRoutes(worktreesDir: string): Router {
  const router = Router();

  // `*splat` is everything after `/api/runs/`; express 5 syntax, same as the
  // read router in runsApi.ts.
  router.post('/api/runs/*splat/siblings', (request, response) => {
    const splat = request.params.splat;
    const parentBranch = Array.isArray(splat) ? splat.join('/') : splat;
    const { agent, prompt } = (request.body ?? {}) as {
      agent?: unknown;
      prompt?: unknown;
    };
    if (typeof agent !== 'string' || typeof prompt !== 'string') {
      response.status(400).json({ error: 'agent and prompt are required' });
      return;
    }
    respondJson(
      response,
      () =>
        manualSiblingRequest(
          agent,
          [prompt],
          { parent: parentBranch },
          worktreesDir
        ),
      {
        // A created request is a 201; the manual child's own rejections
        // (unknown parent, depth, empty prompt) are the caller's fault, 400.
        status: 201,
        statusFor: (error: unknown) => (error instanceof Error ? 400 : 500),
      }
    );
  });

  return router;
}

/**
 * **The BFF's reverse proxies** - two configurations of *one* implementation.
 *
 * `e serve` forwards to two upstreams: the egress container's HTTP API
 * (ADR-0012) under `/api/egress/*`, and the OmniRoute dashboard on a mirror
 * port so the UI can frame it. The egress side used to be hand-rolled on
 * `fetch` while the OmniRoute side used `http-proxy-middleware`, which meant
 * two sets of header, streaming and error rules for the same job - and only
 * one of them could carry a WebSocket or a response body it had not first
 * buffered into memory. Both go through the library now; what differs is
 * configuration, and it is spelled out here side by side.
 */

import { Router } from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import http, { type Server } from 'node:http';

import { env } from '../../shared/utils/env.js';
import { errorMessage } from '../../shared/utils/errors.js';
import { respondNotFound } from './apiResponse.js';

/** Where the egress API hangs off the BFF; everything after it is the upstream's own path. */
const EGRESS_PATH = '/api/egress';

/**
 * The egress API reads two small files per request, so a slow answer means a
 * wedged container - which must not pin a BFF worker for the default two
 * minutes.
 */
const EGRESS_PROXY_TIMEOUT_MS = 5000;

/**
 * `/api/egress/*` -> the egress container's own listener (ADR-0012). Path,
 * query string, method and body travel unchanged: the BFF adds no write logic
 * of its own, it only makes the container-local API reachable from the page.
 *
 * Mount this *before* `express.json()`, so the request body streams straight
 * through instead of being parsed and re-serialized on the way.
 *
 * `egressApiUrl` may be empty - a BFF started without the egress stack - in
 * which case the routes exist but answer 503, which is the answer the Egress
 * page knows how to show.
 */
export function egressRoutes(egressApiUrl: string): Router {
  const router = Router();
  const proxy = egressApiUrl
    ? createProxyMiddleware({
        target: egressApiUrl,
        changeOrigin: true,
        proxyTimeout: EGRESS_PROXY_TIMEOUT_MS,
        pathRewrite: { [`^${EGRESS_PATH}`]: '' },
        on: {
          // Replaces the library's plain-text default: the page parses every
          // `/api/egress` failure as `{ error }`, upstream or not.
          error: (error, _request, response) => {
            if (!('writeHead' in response)) {
              response.destroy();
              return;
            }
            if (response.writableEnded) return;
            if (!response.headersSent) {
              response.writeHead(502, { 'content-type': 'application/json' });
            }
            response.end(
              JSON.stringify({
                error: `Egress API error: ${errorMessage(error)}`,
              })
            );
          },
        },
      })
    : undefined;

  router.all(`${EGRESS_PATH}/*splat`, (request, response) => {
    // The bare prefix (with or without a query string) names no upstream route.
    if (request.path === `${EGRESS_PATH}/`) {
      respondNotFound(response);
      return;
    }
    if (!proxy) {
      response.status(503).json({ error: 'Egress API not configured' });
      return;
    }
    // Swallow `next`: this request is the proxy's, and letting a proxy error
    // fall through to express would answer an already-answered response.
    void proxy(request, response, () => {});
  });

  return router;
}

/**
 * OmniRoute embed proxy: a second loopback listener that mirrors OmniRoute
 * 1:1 so the UI can frame its dashboard.
 *
 * OmniRoute sends `frame-ancestors 'none'` + `X-Frame-Options: DENY`, which
 * blocks the iframe when it points at OmniRoute directly, and both knobs are
 * build-time in its image. It also ships without a basePath: only its pages
 * live under `/dashboard`, while the login redirect (`/login`), assets
 * (`/_next/*`) and API (`/api/*`) are root-anchored. A path-prefixed proxy on
 * the BFF port would therefore either have to rewrite HTML and JS or share
 * the BFF's `/api` namespace, so the mirror gets its own port instead: every
 * path is forwarded unchanged, only the framing headers are stripped and the
 * session cookie is rescoped. The UI frames `http://<bff-host>:<port>/dashboard`,
 * which is same-site with the BFF origin, so the dashboard's session cookie
 * still flows inside the frame.
 */
export function createOmniRouteEmbedProxy(
  omniRoutedUrl: string = env.omniRoutedUrl
): ReturnType<typeof createProxyMiddleware> {
  return createProxyMiddleware({
    target: omniRoutedUrl,
    changeOrigin: true,
    // The dashboard opens a Live WebSocket to its own origin.
    ws: true,
    on: {
      proxyRes: proxyResponse => {
        delete proxyResponse.headers['content-security-policy'];
        delete proxyResponse.headers['x-frame-options'];
        // Keep the dashboard session, but scope its cookies to this origin:
        // a `Domain` for OmniRoute's host would be rejected by the browser,
        // and `Secure` never reaches a plain-http loopback proxy.
        const cookies = proxyResponse.headers['set-cookie'];
        if (cookies) {
          proxyResponse.headers['set-cookie'] = cookies.map(cookie =>
            cookie
              .split(';')
              .map(part => part.trim())
              .filter(part => !/^(domain=|secure$)/i.test(part))
              .join('; ')
          );
        }
      },
    },
  });
}

export function startOmniRouteEmbedProxy(
  host: string,
  port: number,
  omniRoutedUrl: string = env.omniRoutedUrl
): Promise<Server> {
  const proxy = createOmniRouteEmbedProxy(omniRoutedUrl);
  const server = http.createServer(proxy);
  server.on('upgrade', proxy.upgrade);
  return new Promise((resolve, reject) => {
    server.listen(port, host);
    server.once('listening', () => resolve(server));
    server.once('error', reject);
  });
}

/** The embed proxy sits right next to the BFF port so one `--port` configures both. */
export function omniRouteEmbedPortFor(bffPort: number): number {
  return bffPort + 1;
}

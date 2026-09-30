/**
 * A fake OmniRoute for tests: the login and the `/api/keys` surface `e`
 * uses, with a key table that remembers what was minted and deleted. It
 * answers the way v3.8.51 does (docs/research/omniroute-endpoint-keys.md);
 * `echoExpiry: false` models an older image that strips `expiresAt` from
 * the create body.
 */

export interface FakeKey {
  id: string;
  name: string;
  key: string;
  createdAt: string;
  expiresAt: string | null;
}

export interface FakeOmniRouteOptions {
  password: string;
  /** Keys already in the table, e.g. a crashed run's leftover. */
  keys?: FakeKey[];
  /** False: the create response carries no `expiresAt` (image < 3.8.51). */
  echoExpiry?: boolean;
  /** Status codes to answer instead, by `METHOD path`, e.g. `DELETE /api/keys/k1`. */
  fail?: Record<string, number>;
  /** Makes every request throw, as an unreachable gateway does. */
  unreachable?: boolean;
}

export interface FakeOmniRoute {
  fetchImpl: typeof fetch;
  calls: Array<{ method: string; path: string; init: RequestInit }>;
  /** The key table as it stands. */
  keys: FakeKey[];
}

export function fakeOmniRoute(opts: FakeOmniRouteOptions): FakeOmniRoute {
  const keys: FakeKey[] = [...(opts.keys ?? [])];
  const calls: FakeOmniRoute['calls'] = [];
  let minted = 0;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const fetchImpl = (async (
    input: string | URL | Request,
    init: RequestInit = {}
  ) => {
    if (opts.unreachable) throw new TypeError('fetch failed');
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    calls.push({ method, path: url.pathname, init });
    const failed = opts.fail?.[`${method} ${url.pathname}`];
    if (failed !== undefined) return json({ error: 'failed' }, failed);

    if (url.pathname === '/api/auth/login') {
      const { password } = JSON.parse(String(init.body)) as {
        password: string;
      };
      if (password !== opts.password) {
        return json({ error: 'Invalid password' }, 401);
      }
      return new Response('{"success":true}', {
        status: 200,
        headers: { 'set-cookie': 'auth_token=jwt-123; Path=/; HttpOnly' },
      });
    }
    const headers = (init.headers ?? {}) as Record<string, string>;
    if (url.pathname.startsWith('/api/keys')) {
      if (headers.cookie !== 'auth_token=jwt-123') {
        return json({ error: 'Unauthorized' }, 401);
      }
    }
    if (url.pathname === '/api/keys' && method === 'POST') {
      const body = JSON.parse(String(init.body)) as {
        name: string;
        expiresAt?: string;
      };
      minted += 1;
      const row: FakeKey = {
        id: `minted-${minted}`,
        name: body.name,
        key: `sk-run-${minted}`,
        createdAt: new Date().toISOString(),
        expiresAt: opts.echoExpiry === false ? null : (body.expiresAt ?? null),
      };
      keys.push(row);
      const created = { key: row.key, name: row.name, id: row.id };
      return json(
        opts.echoExpiry === false
          ? created
          : { ...created, expiresAt: row.expiresAt },
        201
      );
    }
    if (url.pathname === '/api/keys' && method === 'GET') {
      return json({
        keys: keys.map(k => ({ ...k, key: `${k.key.slice(0, 8)}****` })),
        total: keys.length,
        allowKeyReveal: false,
      });
    }
    const byId = /^\/api\/keys\/([^/]+)$/.exec(url.pathname);
    if (byId) {
      const index = keys.findIndex(k => k.id === byId[1]);
      if (index === -1) return json({ error: 'Key not found' }, 404);
      if (method === 'DELETE') {
        keys.splice(index, 1);
        return json({ message: 'Key deleted successfully' });
      }
      if (method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as { expiresAt?: string };
        if (body.expiresAt !== undefined)
          keys[index].expiresAt = body.expiresAt;
        return json({ message: 'Key updated' });
      }
    }
    return json({ error: 'not found' }, 404);
  }) as typeof fetch;
  return { fetchImpl, calls, keys };
}

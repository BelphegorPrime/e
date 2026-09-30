# OmniRoute endpoint keys - mint, list, revoke per run

Research for issue [#196](https://github.com/BelphegorPrime/e/issues/196)
(child of [#193](https://github.com/BelphegorPrime/e/issues/193), blocking
[#200](https://github.com/BelphegorPrime/e/issues/200)). Question: **can a
one-shot `e` run on a host with a running local stack mint an OmniRoute
endpoint key for that run, and revoke it when the run ends?** Today `e` only
knows `POST /api/auth/login` and `POST /api/keys`
([`src/engine/spawn/localApiKey.ts`](../../src/engine/spawn/localApiKey.ts)),
reads nothing but `key` from the create response, and runs the image
`diegosouzapw/omniroute:latest` unpinned
([`src/cli/init/renderCompose.ts`](../../src/cli/init/renderCompose.ts)).

Gathered 2026-09-30. Every claim below cites its primary source: the OmniRoute
source at a pinned release, its bundled OpenAPI file and changelog, or the
Docker Hub registry API. Claims that could not be confirmed from a primary
source are marked _unverified_.

**Pinned source:** OmniRoute tag
[`v3.8.51`](https://github.com/diegosouzapw/OmniRoute/releases/tag/v3.8.51),
commit
[`c1e30b7676975feb298b49eff6ff58923c04b89e`](https://github.com/diegosouzapw/OmniRoute/tree/c1e30b7676975feb298b49eff6ff58923c04b89e)
(2026-09-29). That tag is what `diegosouzapw/omniroute:latest` resolved to on
the day of gathering: Docker Hub reports `latest` and `3.8.51` with the same
manifest-list digest
`sha256:8bd462c9f60d8eda79329cfbb6ea7ea723505fe7721beb944f3d43835409e218`
([tags API](https://hub.docker.com/v2/repositories/diegosouzapw/omniroute/tags/3.8.51)),
and the image is built from this repository by
[`.github/workflows/docker-publish.yml`](https://github.com/diegosouzapw/OmniRoute/blob/c1e30b7676975feb298b49eff6ff58923c04b89e/.github/workflows/docker-publish.yml#L51)
(`IMAGE_NAME: diegosouzapw/omniroute`).

All GitHub links below are permalinks into that commit unless they name
another one.

## Answers at a glance

| Question                             | Answer at v3.8.51                                                                                                                   | Stable since                                                                         |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 1. Create returns an id?             | **Yes.** `201` body carries `key`, `name`, **`id`** (UUID v4), plus policy fields.                                                  | `id` in the response at every tag checked, v1.0.4 to v3.8.51                         |
| 2. Delete / deactivate?              | **Yes, by id only.** `DELETE /api/keys/{id}` (hard delete); `PATCH /api/keys/{id}` `{"isActive": false}` (soft).                    | `DELETE` at every tag checked; `PATCH isActive` since v2.8.1                         |
| 3. List with name and creation time? | **Yes.** `GET /api/keys` returns every key with `id`, `name`, `createdAt`, `expiresAt`, `isActive`, masked `key`. No server filter. | every tag checked                                                                    |
| 4a. Auth                             | `auth_token` cookie from login (dashboard session JWT), **or** `Authorization: Bearer <key with manage/admin scope>`.               | cookie at every tag checked; `requireManagementAuth` guard since at least v3.3.3     |
| 4b. Scope / expiry at mint           | **Yes.** `expiresAt`, `modelAccessMode`+`allowedModels`, `allowedCombos`, `allowedConnections`, `scopes`, budget fields.            | `expiresAt`/model fields on **create only since v3.8.51**; via `PATCH` since ~v3.3.3 |
| 5. Pin the image?                    | **Yes.** `diegosouzapw/omniroute:3.8.51@sha256:8bd462c9...e218` (amd64 + arm64).                                                    | n/a                                                                                  |

**Verdict: per-run keys are feasible.** Details, exact calls and the sweep
strategy are in [Verdict](#verdict).

---

## The calls, exactly

Base URL is the host-side gateway `http://localhost:20128`
([`OMNIROUTE_PORT`](../../src/shared/constants.ts)). All bodies are JSON.

### Login - `POST /api/auth/login`

- **Handler:** [`src/app/api/auth/login/route.ts#L38`](https://github.com/diegosouzapw/OmniRoute/blob/c1e30b7676975feb298b49eff6ff58923c04b89e/src/app/api/auth/login/route.ts#L38)
- **Auth:** none.
- **Request body:** `{"password": "<OMNIROUTE_INITIAL_PASSWORD>"}`, validated by
  [`loginSchema`](https://github.com/diegosouzapw/OmniRoute/blob/c1e30b7676975feb298b49eff6ff58923c04b89e/src/shared/validation/schemas/misc.ts#L39-L41)
  (string, 1-200 chars).
- **Success:** `200 {"success": true}` and `Set-Cookie: auth_token=<JWT>;
HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`
  ([L202-L238](https://github.com/diegosouzapw/OmniRoute/blob/c1e30b7676975feb298b49eff6ff58923c04b89e/src/app/api/auth/login/route.ts#L202-L238)).
  The JWT itself expires after 30 days
  ([`mintDashboardSessionToken`](https://github.com/diegosouzapw/OmniRoute/blob/c1e30b7676975feb298b49eff6ff58923c04b89e/src/shared/utils/dashboardSessionToken.ts#L33-L40)).
- **Failures:** `401 {"error":"Invalid password"}`
  ([L269](https://github.com/diegosouzapw/OmniRoute/blob/c1e30b7676975feb298b49eff6ff58923c04b89e/src/app/api/auth/login/route.ts#L269));
  `429` with `Retry-After` after repeated failures
  ([L116-L135](https://github.com/diegosouzapw/OmniRoute/blob/c1e30b7676975feb298b49eff6ff58923c04b89e/src/app/api/auth/login/route.ts#L116-L135));
  `403` when password login is disabled by OIDC or no password is stored yet;
  `500` when `JWT_SECRET` is unset
  ([L43-L58](https://github.com/diegosouzapw/OmniRoute/blob/c1e30b7676975feb298b49eff6ff58923c04b89e/src/app/api/auth/login/route.ts#L43-L58)).
- This is exactly what `createLocalApiKey` already does, including reading the
  cookie from `Set-Cookie`.

### Create - `POST /api/keys`

- **Handler:** [`src/app/api/keys/route.ts#L59-L153`](https://github.com/diegosouzapw/OmniRoute/blob/c1e30b7676975feb298b49eff6ff58923c04b89e/src/app/api/keys/route.ts#L59-L153)
- **Auth:** `requireManagementAuth` ([L61](https://github.com/diegosouzapw/OmniRoute/blob/c1e30b7676975feb298b49eff6ff58923c04b89e/src/app/api/keys/route.ts#L61)); see [Auth](#auth-q4a).
- **Request body** ([`createKeySchema`](https://github.com/diegosouzapw/OmniRoute/blob/c1e30b7676975feb298b49eff6ff58923c04b89e/src/shared/validation/schemas/keys.ts#L52-L71)):

  | Field                                                                                                              | Type                               | Notes                                                                                                                                                                                                              |
  | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
  | `name`                                                                                                             | string, 1-200, **required**        | Not unique in the DB ([DDL](https://github.com/diegosouzapw/OmniRoute/blob/c1e30b7676975feb298b49eff6ff58923c04b89e/src/lib/db/core.ts#L300-L309)).                                                                |
  | `expiresAt`                                                                                                        | ISO-8601 datetime string or `null` | `z.string().datetime()`: UTC `Z` form. **New on create in v3.8.51.**                                                                                                                                               |
  | `modelAccessMode`                                                                                                  | `"all"` \| `"restricted"`          | New on create in v3.8.51. `allowedModels` must be empty with `"all"`.                                                                                                                                              |
  | `allowedModels`                                                                                                    | string[] (max 1000)                | New on create in v3.8.51.                                                                                                                                                                                          |
  | `allowedCombos`                                                                                                    | string[] (max 500)                 | New on create in v3.8.51; defaults to all combos.                                                                                                                                                                  |
  | `allowedConnections`                                                                                               | UUID[] (1-100)                     | Provider connection ids.                                                                                                                                                                                           |
  | `scopes`                                                                                                           | string[] (max 32)                  | `self:usage` is always added ([`normalizeSelfServiceScopesForCreate`](https://github.com/diegosouzapw/OmniRoute/blob/c1e30b7676975feb298b49eff6ff58923c04b89e/src/shared/constants/selfServiceScopes.ts#L14-L20)). |
  | `noLog`, `usageLimitEnabled`, `dailyUsageLimitUsd`, `weeklyUsageLimitUsd`, `allowUsageCommand`, `chaosModeEnabled` | bool / number                      | Applied by a follow-up `updateApiKeyPermissions` ([L98-L114](https://github.com/diegosouzapw/OmniRoute/blob/c1e30b7676975feb298b49eff6ff58923c04b89e/src/app/api/keys/route.ts#L98-L114)).                         |

- **Success:** `201`
  ([L126-L148](https://github.com/diegosouzapw/OmniRoute/blob/c1e30b7676975feb298b49eff6ff58923c04b89e/src/app/api/keys/route.ts#L126-L148)):

  ```json
  {
    "key": "sk-<machineId>-<keyId>-<crc>",
    "name": "e-run-<runId>",
    "id": "<uuid v4>",
    "machineId": "...",
    "modelAccessMode": "all",
    "allowedModels": [],
    "allowedCombos": ["..."],
    "allowedConnections": [],
    "noLog": false,
    "allowUsageCommand": false,
    "usageLimitEnabled": false,
    "dailyUsageLimitUsd": null,
    "weeklyUsageLimitUsd": null,
    "chaosModeEnabled": false,
    "expiresAt": "2026-09-30T18:00:00.000Z",
    "streamDefaultMode": "legacy",
    "compressionEnabled": true,
    "cacheDefaultMode": "legacy"
  }
  ```

  `id` is a fresh `uuidv4()` and `key` is
  `sk-${machineId}-${keyId}-${crc}` from
  [`createApiKey`](https://github.com/diegosouzapw/OmniRoute/blob/c1e30b7676975feb298b49eff6ff58923c04b89e/src/lib/db/apiKeys.ts#L693-L755)
  and
  [`generateApiKeyWithMachine`](https://github.com/diegosouzapw/OmniRoute/blob/c1e30b7676975feb298b49eff6ff58923c04b89e/src/shared/utils/apiKey.ts#L48-L53).
  The `keyId` embedded in the key string is **not** the DB `id`; the DB id can
  only be learned from this response or from the list.

- **Failures:** `400 {"error":{"message":"Invalid request","details":[...]}}`
  on schema violations; `401`/`403` from the auth guard; `500` otherwise.

### List - `GET /api/keys`

- **Handler:** [`src/app/api/keys/route.ts#L33-L57`](https://github.com/diegosouzapw/OmniRoute/blob/c1e30b7676975feb298b49eff6ff58923c04b89e/src/app/api/keys/route.ts#L33-L57)
- **Auth:** `requireManagementAuth`.
- **Query:** optional `limit` (positive int) and `offset`
  ([`parsePagination`](https://github.com/diegosouzapw/OmniRoute/blob/c1e30b7676975feb298b49eff6ff58923c04b89e/src/app/api/keys/route.ts#L18-L31));
  without `limit` all keys come back. **No name or date filter**: filtering is
  the caller's job.
- **Success:** `200 {"keys": [...], "total": <n>, "allowKeyReveal": <bool>}`.
  Each entry is the whole `api_keys` row camel-cased (`SELECT * FROM api_keys
ORDER BY created_at`,
  [`getApiKeys`](https://github.com/diegosouzapw/OmniRoute/blob/c1e30b7676975feb298b49eff6ff58923c04b89e/src/lib/db/apiKeys.ts#L496-L543),
  [L461](https://github.com/diegosouzapw/OmniRoute/blob/c1e30b7676975feb298b49eff6ff58923c04b89e/src/lib/db/apiKeys.ts#L461)),
  so it includes `id`, `name`, `createdAt` (ISO string), `expiresAt`,
  `revokedAt`, `isActive`, `scopes`, and `key` masked to first 8 + `****` +
  last 4 chars
  ([`maskStoredApiKey`](https://github.com/diegosouzapw/OmniRoute/blob/c1e30b7676975feb298b49eff6ff58923c04b89e/src/lib/apiKeyExposure.ts#L16-L19)).
  Oldest first.

### Delete - `DELETE /api/keys/{id}`

- **Handler:** [`src/app/api/keys/[id]/route.ts#L191-L212`](https://github.com/diegosouzapw/OmniRoute/blob/c1e30b7676975feb298b49eff6ff58923c04b89e/src/app/api/keys/%5Bid%5D/route.ts#L191-L212)
- **Auth:** `requireManagementAuth`.
- **Takes:** the DB **id** in the path, nothing else. No delete by key value
  or by name exists.
- **Success:** `200 {"message": "Key deleted successfully"}`. **Not found:**
  `404 {"error": "Key not found"}` (treat as already revoked).
- **Effect** ([`deleteApiKey`](https://github.com/diegosouzapw/OmniRoute/blob/c1e30b7676975feb298b49eff6ff58923c04b89e/src/lib/db/apiKeys.ts#L1193-L1213)):
  `DELETE FROM api_keys WHERE id = ?`, drops the key's domain budgets and
  cost history, clears the in-process validation caches
  ([`invalidateCaches`](https://github.com/diegosouzapw/OmniRoute/blob/c1e30b7676975feb298b49eff6ff58923c04b89e/src/lib/db/apiKeys.ts#L276-L281))
  and deletes the key's Redis auth-cache entry. Afterwards
  [`validateApiKey`](https://github.com/diegosouzapw/OmniRoute/blob/c1e30b7676975feb298b49eff6ff58923c04b89e/src/lib/db/apiKeys.ts#L1270-L1345)
  finds no row and rejects the key. The per-process cache TTL is 60 s
  ([L247](https://github.com/diegosouzapw/OmniRoute/blob/c1e30b7676975feb298b49eff6ff58923c04b89e/src/lib/db/apiKeys.ts#L247));
  whether the image runs more than one Node process that could hold a stale
  "valid" entry for up to that long is _unverified_.

### Deactivate - `PATCH /api/keys/{id}` (alternative)

- **Handler:** [`src/app/api/keys/[id]/route.ts#L42-L189`](https://github.com/diegosouzapw/OmniRoute/blob/c1e30b7676975feb298b49eff6ff58923c04b89e/src/app/api/keys/%5Bid%5D/route.ts#L42-L189),
  schema
  [`updateKeyPermissionsSchema`](https://github.com/diegosouzapw/OmniRoute/blob/c1e30b7676975feb298b49eff6ff58923c04b89e/src/shared/validation/schemas/keys.ts#L132-L146).
- `{"isActive": false}` soft-disables (row stays, `validateApiKey` rejects
  inactive keys); `{"expiresAt": "<ISO>"}` sets an expiry after the fact.
  `200` on success, `404` if the id is unknown.
- A logical `revokeApiKey` (sets `revoked_at`) exists in the DB layer
  ([L1219-L1235](https://github.com/diegosouzapw/OmniRoute/blob/c1e30b7676975feb298b49eff6ff58923c04b89e/src/lib/db/apiKeys.ts#L1219-L1235))
  but no HTTP route under `src/app` calls it at this tag (only the internal
  copilot tools do); it is not usable from `e`.

---

## Auth (Q4a)

Every `/api/keys` handler starts with
[`requireManagementAuth`](https://github.com/diegosouzapw/OmniRoute/blob/c1e30b7676975feb298b49eff6ff58923c04b89e/src/lib/api/requireManagementAuth.ts#L49-L164).
The two branches that matter for `e`:

1. **Dashboard session cookie** - `auth_token`
   ([`DASHBOARD_SESSION_COOKIE`](https://github.com/diegosouzapw/OmniRoute/blob/c1e30b7676975feb298b49eff6ff58923c04b89e/src/shared/utils/dashboardSessionToken.ts#L17)),
   read from a plain `Cookie:` request header and JWT-verified
   ([`isDashboardSessionAuthenticated`](https://github.com/diegosouzapw/OmniRoute/blob/c1e30b7676975feb298b49eff6ff58923c04b89e/src/shared/utils/apiAuth.ts#L360-L391)).
   This is what `e` already sends.
2. **Bearer API key with `manage` or `admin` scope** -
   [L119-L156](https://github.com/diegosouzapw/OmniRoute/blob/c1e30b7676975feb298b49eff6ff58923c04b89e/src/lib/api/requireManagementAuth.ts#L119-L156).
   Header only; a key in the URL never counts. A key without that scope gets
   `403 "API key lacks 'manage' scope"`.

A key minted with the default scopes holds only `self:usage`
([`SELF_USAGE_SCOPE`](https://github.com/diegosouzapw/OmniRoute/blob/c1e30b7676975feb298b49eff6ff58923c04b89e/src/shared/constants/selfServiceScopes.ts#L1),
[`MANAGE_SCOPE`](https://github.com/diegosouzapw/OmniRoute/blob/c1e30b7676975feb298b49eff6ff58923c04b89e/src/shared/constants/managementScopes.ts#L15)),
so **the per-run key cannot list, mint or delete keys itself**. `e` must never
pass `scopes: ["manage"]` or `["admin"]`.

**Origin/CSRF gate.** For cookie-authenticated management mutations (POST,
PATCH, DELETE) the authz pipeline additionally runs
[`validateBrowserMutationOrigin`](https://github.com/diegosouzapw/OmniRoute/blob/c1e30b7676975feb298b49eff6ff58923c04b89e/src/server/origin/publicOrigin.ts#L241-L259)
([pipeline L418-L432](https://github.com/diegosouzapw/OmniRoute/blob/c1e30b7676975feb298b49eff6ff58923c04b89e/src/server/authz/pipeline.ts#L418-L432)).
It passes when neither `Sec-Fetch-Site` (cross-site) nor a foreign `Origin`
header is present. Node's `fetch` from the host sends neither in `e`'s current
`POST /api/keys`, and `DELETE`/`PATCH` go through the same check; that
Node's `fetch` never adds an `Origin` header is inferred from `e`'s working
`POST`, not re-verified against undici here (_unverified_). `e` must not set
an `Origin` header on these calls.

`/api/keys` is not in the loopback-only list
([`LOCAL_ONLY_API_PREFIXES`](https://github.com/diegosouzapw/OmniRoute/blob/c1e30b7676975feb298b49eff6ff58923c04b89e/src/server/authz/routeGuard.ts#L33-L102)),
so the Docker-bridge peer address seen for host requests through the published
`127.0.0.1:20128` port does not matter.

## Scope and expiry at mint (Q4b)

- **Expiry:** `expiresAt` on `POST /api/keys`, enforced by `validateApiKey`
  (`expires_at <= now` rejects,
  [L1328-L1332](https://github.com/diegosouzapw/OmniRoute/blob/c1e30b7676975feb298b49eff6ff58923c04b89e/src/lib/db/apiKeys.ts#L1328-L1332)).
  Added to the create path in v3.8.51 by
  [#12952](https://github.com/diegosouzapw/OmniRoute/pull/12952)
  ([CHANGELOG L302](https://github.com/diegosouzapw/OmniRoute/blob/c1e30b7676975feb298b49eff6ff58923c04b89e/CHANGELOG.md#L302)).
  Expired keys are **not purged**: the only `DELETE FROM api_keys` in the
  codebase is the by-id statement
  ([L472](https://github.com/diegosouzapw/OmniRoute/blob/c1e30b7676975feb298b49eff6ff58923c04b89e/src/lib/db/apiKeys.ts#L472)),
  so expired rows stay in the list until deleted.
- **Models:** `modelAccessMode: "restricted"` + `allowedModels`, and
  `allowedCombos`, on create since v3.8.51. Also since v3.8.51, the built-in
  `auto/*` combos honour these restrictions via the per-key `allowAutoCombos`
  flag (default `true`); before, "a restricted key could still reach any model
  through `auto/best-fast`"
  ([CHANGELOG L325](https://github.com/diegosouzapw/OmniRoute/blob/c1e30b7676975feb298b49eff6ff58923c04b89e/CHANGELOG.md#L325),
  [#13670](https://github.com/diegosouzapw/OmniRoute/pull/13670)).
  `allowAutoCombos` is settable only via `PATCH`, not on create.
- **Providers:** `allowedConnections` (provider connection UUIDs).
- **Permissions:** `scopes` (see above); budgets via `usageLimitEnabled` and
  `daily/weeklyUsageLimitUsd`.

## Stability and pinning (Q5)

Release commits in this repo are squash merges (`Release v3.8.x (#...)`), so
`git log` on the route files is coarse. Instead, the handler files were read
at a spread of tags (`git show <tag>:<path>`):

| Tag     | Create returns `id` | `DELETE /api/keys/{id}` | `PATCH isActive` | `PATCH expiresAt` | `expiresAt` on create | login sets `auth_token` |
| ------- | :-----------------: | :---------------------: | :--------------: | :---------------: | :-------------------: | :---------------------: |
| v1.0.4  |          ✓          |            ✓            |        -         |         -         |           -           |            ✓            |
| v3.0.0  |          ✓          |            ✓            |        ✓         |         -         |           -           |            ✓            |
| v3.3.3  |          ✓          |            ✓            |        ✓         |         ✓         |           -           |            ✓            |
| v3.8.0  |          ✓          |            ✓            |        ✓         |         ✓         |           -           |            ✓            |
| v3.8.49 |          ✓          |            ✓            |        ✓         |         ✓         |           -           |            ✓            |
| v3.8.50 |          ✓          |            ✓            |        ✓         |         ✓         |           -           |            ✓            |
| v3.8.51 |          ✓          |            ✓            |        ✓         |         ✓         |           ✓           |            ✓            |

(v1.0.4 `PATCH` columns: the `[id]` route had only `DELETE` then; `GET` and
`PATCH` arrived with [#470](https://github.com/diegosouzapw/OmniRoute/pull/470),
first tagged in v2.8.1.)

So the id, list, delete and cookie login surface is **stable across every
checked tag**. What moved recently is the create body: at v3.8.50
([`createKeySchema`](https://github.com/diegosouzapw/OmniRoute/blob/5458026c216f77a3da68ea49152dc33470cfe2cb/src/shared/validation/schemas/keys.ts#L32-L44))
the schema has no `expiresAt`, `modelAccessMode`, `allowedModels` or
`allowedCombos`, and because it is a plain `z.object` parsed with
`safeParse`
([`validateBody`](https://github.com/diegosouzapw/OmniRoute/blob/c1e30b7676975feb298b49eff6ff58923c04b89e/src/shared/validation/helpers.ts#L36-L43)),
unknown fields are **silently stripped**: an older image would mint a
non-expiring, unrestricted key without an error. The v3.8.50 create response
also has no `expiresAt` field, which makes the difference detectable.

The OpenAPI file shipped in the repo is **not** a reliable contract: it says
the create body is `{"label": string}`
([`docs/openapi.yaml#L2374-L2385`](https://github.com/diegosouzapw/OmniRoute/blob/c1e30b7676975feb298b49eff6ff58923c04b89e/docs/openapi.yaml#L2374-L2385)),
while the handler requires `name`. Code wins; `e` should not generate a client
from that file.

**Release cadence and churn.** v3.8.49 was tagged 2026-07-29, v3.8.50
2026-08-26, v3.8.51 2026-09-29; the v3.8.51 changelog section alone runs over
2400 lines
([CHANGELOG L93-L2501](https://github.com/diegosouzapw/OmniRoute/blob/c1e30b7676975feb298b49eff6ff58923c04b89e/CHANGELOG.md#L93)).
`latest` is promoted on each release, and `next` / `main` tags exist for
pre-release builds
([Docker Hub tags](https://hub.docker.com/r/diegosouzapw/omniroute/tags)).
Running `latest` means a monthly jump across hundreds of changes on the next
`docker compose pull`.

**Pinning is advisable.** Candidate:

```
diegosouzapw/omniroute:3.8.51@sha256:8bd462c9f60d8eda79329cfbb6ea7ea723505fe7721beb944f3d43835409e218
```

Registry facts
([tags API](https://hub.docker.com/v2/repositories/diegosouzapw/omniroute/tags/3.8.51)):
pushed 2026-09-30T04:44:45Z, manifest list with `linux/amd64` and
`linux/arm64`, identical digest to `latest` on 2026-09-30. It is the first
release with `expiresAt`/model scoping on create and with `allowAutoCombos`,
so it is the lowest version that gives the one-call mint `e` wants. The
previous release, `3.8.50`
(`sha256:085c57adf499a8aaa9f35ccde95c0df9c11bd9ecd18d6c9edbf3b68b8079ba9d`),
works too but needs create-then-`PATCH` for the expiry. Whether 3.8.51 has
regressions elsewhere (it is one day old at gathering) is _unverified_.

---

## Verdict

**Per-run keys are feasible.** Every piece `e` needs exists, is stable across
the checked releases, and is reachable with the `auth_token` cookie `e`
already obtains. #193 does **not** need the `--env-file`-only fallback.

### Mint (run start)

1. `POST /api/auth/login` `{"password": OMNIROUTE_INITIAL_PASSWORD}` -> take
   `auth_token` from `Set-Cookie` (unchanged from today).
2. `POST /api/keys` with `Cookie: auth_token=<t>` and

   ```json
   {
     "name": "e-run-<runId>",
     "expiresAt": "<now + run timeout + margin, ISO UTC with Z>"
   }
   ```

   optionally `modelAccessMode: "restricted"` + `allowedModels` for the
   agent's model. Never `scopes: ["manage"|"admin"]`.

3. Expect `201`; keep **`id`** and `key` from the body. Check that
   `body.expiresAt` equals what was sent; if it is missing or `null` (image
   older than v3.8.51), follow with `PATCH /api/keys/<id>`
   `{"expiresAt": "..."}` or refuse to continue.
4. Hand `key` to the run through the environment only; with per-run keys it
   should no longer be written into `.e/.env` the way
   [`prepareLocalStack.ts`](../../src/engine/spawn/prepareLocalStack.ts)
   does today.

### Revoke (run end, every exit path)

1. `POST /api/auth/login` again if the cookie was not kept (the JWT is valid
   30 days, so keeping it in memory for the run is fine).
2. `DELETE /api/keys/<id>` with the cookie. `200` or `404` both mean done.
3. If the delete fails (stack down, network), do nothing more: the
   `expiresAt` set at mint already makes the key useless, and the sweep
   removes the row later.

### Sweep leftovers named `e-run-*`

Run it before minting (and optionally from `e stack` maintenance):

1. `GET /api/keys` with the cookie (no `limit`, so all keys come back).
2. Select entries with `name` starting `e-run-` **and** either
   `expiresAt` in the past, or a run id that the host no longer knows as
   running. Never select by name prefix alone: a concurrent run's live key
   has the same prefix. As a fallback when the run id cannot be resolved,
   use `createdAt` older than the maximum run timeout.
3. `DELETE /api/keys/<id>` for each; ignore `404`.

Since OmniRoute never purges expired keys itself and the list has no
server-side filter, this client-side sweep is the only cleanup; the
`expiresAt` at mint is what makes a missed revoke harmless in the meantime.

### Prerequisites for the stack sub-issue (#200)

- Pin the compose image to the digest above instead of `:latest`
  ([`renderCompose.ts`](../../src/cli/init/renderCompose.ts)); bump
  deliberately and re-check the create schema on each bump.
- `createLocalApiKey` should read `id` (and `expiresAt`) from the create
  response, not only `key`, and a sibling `deleteLocalApiKey` / `listLocalApiKeys`
  should mirror its login + cookie handling.

## Open / unverified points

- Whether Node's `fetch` could ever send an `Origin` header that trips the
  mutation-origin check (inferred safe from `e`'s working `POST`; not
  re-verified against undici).
- Whether the image runs several Node processes, which would let a deleted
  key stay "valid" in another process's cache for up to 60 s.
- Runtime behaviour of v3.8.51 beyond the key endpoints (released the day
  before gathering).
- Nothing here was exercised against a live container; all findings are from
  reading the pinned source and the registry API.

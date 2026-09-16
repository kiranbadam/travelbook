# TravelBook Backend (private alpha)

Serverless backend for TravelBook: one API Lambda (HTTP API v2) + one SQS feed-worker Lambda,
DynamoDB single table, Cognito JWT (subject = user id). Node.js 22, TypeScript, bundled by CDK
`NodejsFunction` (esbuild).

## Module map

```
src/
  api/index.ts            HTTP API v2 Lambda handler (all /v1/* routes + /health)
  worker/index.ts         SQS Lambda handler (batchSize 1): the 7-step evidence pipeline
  shared/
    types.ts              Domain types (Preferences, FeedJob, FeedSnapshot, FeedCard,
                          Evidence + Provenance, RiskItem, ScoreBreakdown, Trip/Vote/Friends)
    ddb.ts                DocumentClient, key builders, GSI1/GSI2 helpers, TTL helpers
    provenance.ts         Provenance envelope builder + sha256 checksums (16 hex chars)
    scoring.ts            Hard-constraint filter + deterministic scorer (pure functions)
    catalog.ts            Versioned static catalog (CATALOG_VERSION="2026-09-16.1", ~26 destinations)
    errors.ts             Error taxonomy -> HTTP status mapping
    validation.ts         Preference validation/normalization, origin->airport resolution,
                          preference-bundle hash + shared-snapshot key
    http.ts               API response/error/body-limit helpers (32 KB max)
  providers/
    interface.ts          EvidenceProvider { search, normalize, freshnessMs, health }
    egress.ts             Outbound allowlist + fetch with hard timeout (POLICY_BLOCKED otherwise)
    ssm.ts                SSM parameter reads (5-min cache); "UNSET"/missing = mock mode
    cache.ts              CACHE#<queryHash> / RESULT#<provider> rows (fresh + stale-if-error)
    openMeteo.ts          LIVE weather (api.open-meteo.com, 8s timeout, 3h freshness)
    ticketmaster.ts       Events; SSM key or deterministic mock (flagged, low confidence)
    duffel.ts             MOCK ONLY fares (deterministic distance-band illustratives, live:false)
    advisories.ts         travel.state.gov ingestion; ANY failure -> UNKNOWN "Verify before booking"
    visa.ts               Static US-passport entry matrix (opt-in passport country)
    llm.ts                Narration: deterministic templates by default; optional
                          gemini/groq branch with strict response-contract validation
```

## Environment variables

| Var | Used by | Default |
| --- | ------- | ------- |
| `TABLE_NAME` | api, worker | `travelbook-dev` |
| `FEED_QUEUE_URL` | api (enqueue), worker (delayed requeue) | — (required) |
| `SSM_PREFIX` | providers | `/travelbook/dev` |

## SSM parameters (runtime only — never in code)

| Param | Effect when UNSET/missing |
| ----- | ------------------------- |
| `/travelbook/dev/ticketmaster/api-key` | Deterministic mock events, flagged `live:false`, confidence `low` |
| `/travelbook/dev/llm/provider` | `template` — deterministic 2-sentence explanations, no network |
| `/travelbook/dev/llm/api-key` | (only read when provider is `gemini`/`groq`) |
| `/travelbook/dev/duffel/mode` | Read for auditability; fares stay mock-only regardless (launch gate) |

Everything runs with all parameters UNSET, in clearly-labeled mock/degraded mode.

## Provider modes + launch gates

| Signal | MVP mode | Gate to go live |
| ------ | -------- | --------------- |
| Flights (Duffel) | **Mock only.** Illustrative fares from distance bands; `live:false`, summary always carries "Illustrative fare — Duffel production access pending; do not treat as a live price." | Production access + pricing confirmed; sandbox never shown as live |
| Weather (Open-Meteo) | Live. Attribution: "Open-Meteo (non-commercial prototype use)" | Commercial license / self-host / replacement for public launch |
| Events (Ticketmaster) | Live when key set (250 ms client throttle, 12 h cache; quota 5k/day, 5 rps) | Key configured; stay under quota |
| Advisories (travel.state.gov) | Monitored ingestion, 6 h cache; unparseable/unreachable → severity `unknown`, status `UNRESOLVED` | — (keep official wording + link) |
| Entry/visa | Static US-passport matrix; unresolved → `UNKNOWN` "Verify before booking" | Authoritative sources + update ownership before widening |
| Narration (LLM) | **Templates** (deterministic, evidence-only). The gemini/groq branch exists but the egress allowlist does not include model hosts, so it falls back to templates | Extend `providers/egress.ts` allowlist + pass provider terms/retention/quota/safety review |

Outbound HTTPS is restricted to `open-meteo.com`, `api.ticketmaster.com`, `api.duffel.com`,
`travel.state.gov` (see `providers/egress.ts`). Strict ≤8 s timeout per call; no recursive browsing.

## Scoring weights

| Dimension | Weight | Method |
| --------- | ------ | ------ |
| Airfare fit | 0.30 | Headroom below ceiling, capped at 100 |
| Weather fit | 0.25 | Share of trip days within the temp band |
| Interest match | 0.20 | Taxonomy overlap (70) + matching events (30) |
| Travel time | 0.10 | Stops and door-to-door duration |
| Freshness | 0.10 | Decay by evidence type (1 − age/TTL) |
| Novelty | 0.05 | Diversity against recent feeds |
| − risk penalty | — | low 0 / moderate 5 / high 20 / critical 60 / unknown 8 (cap 60) |

Hard-constraint filter (rejects): fare over ceiling, no itinerary, hard temp-band miss
(<50% of days in band), advisory severity over the user's threshold, entry rule
known-unsatisfied (`BLOCKED`). Unknown visa status is **never** a silent pass — it stays a
prominent `UNRESOLVED` gate.

Error taxonomy → HTTP: `INVALID_PREFERENCES` 400, `POLICY_BLOCKED` 403 (401 when
unauthenticated), `INSUFFICIENT_EVIDENCE` 422, `BUDGET_EXHAUSTED` 429, `PROVIDER_UNAVAILABLE` 502.

## API quick reference

`PUT /v1/preferences` → validate + normalize, versioned store.
`POST /v1/feed-jobs` (requires `Idempotency-Key`) → 202 `{jobId, state:"PENDING"}`; one active job per user.
`GET /v1/feed-jobs/{id}` → owner-only `{state, progress, snapshotId?, error?}`.
`GET /v1/feed` → latest immutable snapshot; `?snapshotId=`, `?cursor=`, `?limit=` (default 10); ETag on snapshot id.
`GET /v1/destinations/{id}` → card + full evidence with freshness; no model call.
`POST /v1/reactions` → like/save/hide (conditional upsert).
`POST /v1/trips` → private trip + owner membership.
`PUT /v1/trips/{id}/votes/me` → ranked ballot; deterministic Borda aggregate on META.
`POST /v1/friends/requests` / `POST /v1/friends/accept` → mutual edges, request deleted.
`GET /v1/trips/{id}/recommendations` → hard-feasibility intersection, per-traveler utility,
fairness ranking (weighted mean − 0.5 × min utility), Pareto set
`{bestOverall, bestBudget, bestWeather, bestSharedInterest}` + method note.
`GET /health` → `{ok:true, version}` (no auth).

JWT `sub` is the user id; client-supplied owner ids are ignored. Request bodies are capped at 32 KB.

## Worker pipeline (per SQS message, batchSize 1)

1. **Claim** the job: conditional `PENDING → RUNNING` (attempts+1); GSI2 one-active-job check.
2. **Reuse**: fresh shared snapshot for the preference hash (6 h) → new `FEED#` row, no recompute.
3. **Bound**: catalog (~26) → ≤8 candidates (interest overlap − distance heuristic; origin excluded).
4. **Enrich** in parallel with per-provider 8 s budgets; provider caches (flights 45 min, weather 3 h, events 12 h, advisories 6 h) + labeled stale-if-error.
5. **Filter + score** deterministically (unknowns preserved, never substituted).
6. **Narrate** top ≤5 via `providers/llm.ts` (templates unless a configured provider passes the contract).
7. **Publish**: `EVIDENCE#<dest>#<source>` rows (30 d TTL), immutable `FEED#<createdAt>` snapshot (90 d TTL, GSI1 timeline keys) + `FEEDID#` lookup, job → `READY` (`PARTIAL` on provider gaps/insufficient evidence, `FAILED` only on zero candidates or fatal error).

## Tests

```bash
npm install
npx tsc --noEmit   # strict typecheck
npm test           # vitest: scoring (weights, hard filter, unknown-visa gate) + validation
```

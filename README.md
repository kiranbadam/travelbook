# TravelBook

Private-alpha travel discovery web app: preferences in (departure city, weather band, flight budget, interests) → an agent-generated feed of concrete destination ideas with evidence and freshness labels → social (friends see/like each other's feeds) → collaborative trip planning → smart risk alerts.

**Status:** development build, AWS `us-west-2`, free-tier-only by design.

## Layout

- `frontend/` — React 19 + Vite + TypeScript SPA, Astryx (`@astryxdesign/core`). Built to `frontend/dist/`, served from private S3 via CloudFront. Same-origin API calls at `/api/v1/...` (CloudFront strips `/api` and proxies to the HTTP API). Dark mode toggle. See `frontend/README.md`.
- `backend/` — Strict Node 22 TypeScript: API Lambda (`src/api/index.ts`) + SQS worker Lambda (`src/worker/index.ts`), DynamoDB single-table. Deterministic scoring, provider adapters (Duffel, Open-Meteo, Ticketmaster, Gemini/Groq optional), idempotent feed jobs, immutable snapshots, degraded-mode templates. See `backend/README.md`.
- `infra/` — AWS CDK (TypeScript) defining `travelbook-bootstrap` (artifact bucket, GitHub OIDC, deploy/execution roles) and `travelbook-dev` (DynamoDB, SQS+DLQ, Lambdas, Cognito, HTTP API, CloudFront+OAC, SSM params, alarms). Free-tier guardrails documented in `infra/README.md`.
- `.github/workflows/` — OIDC-based deploy pipeline (no long-lived AWS keys).

## Deploy

1. `cd infra && npm ci && npx cdk deploy travelbook-bootstrap` (one-time, bootstrap IAM user)
2. Set GitHub Actions variable `AWS_DEPLOY_ROLE_ARN` to the bootstrap output
3. Push to `main` → workflow deploys `travelbook-dev`, builds the frontend, uploads to S3, invalidates CloudFront
4. `travel-app-deployer` IAM user is removed after OIDC deploys are verified (see plan)

## Provider keys (all optional — the app runs in honest mock/template mode without them)

- `/${PROJECT}/dev/ticketmaster/api-key` — Ticketmaster Discovery (free); without it, events show as sample data
- `/${PROJECT}/dev/llm/api-key` — optional Gemini/Groq free-tier key for richer narration; template mode is the default
- Duffel — mock-only until production access is granted; always labeled ILLUSTRATIVE

## Cost design

$0 target: no NAT Gateway, no ALB, no Fargate, no RDS, no ElastiCache, no OpenSearch, no provisioned concurrency, no custom KMS, no Secrets Manager, no paid WAF. DynamoDB fixed 5 RCU/5 WCU, 7-day logs, $1 billing alarm + budget guardrail.

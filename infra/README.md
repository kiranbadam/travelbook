# TravelBook infrastructure (AWS CDK, TypeScript)

Free-tier-only serverless stack for the TravelBook private alpha. Region
`us-west-2`, project prefix `travelbook`, one dev stack. All resource names
are prefixed `travelbook`.

- `bin/travelbook.ts` — app entry: `travelbook-bootstrap` + `travelbook-dev`
- `lib/bootstrap-stack.ts` — one-time bootstrap: artifact bucket, GitHub OIDC,
  deploy role, CloudFormation execution role
- `lib/travelbook-stack.ts` — the application stack
- `lambda-entries/` — infra-owned entry shims that re-export the
  backend-owned handlers (`backend/src/api/index.ts`,
  `backend/src/worker/index.ts`). NodejsFunction requires entries under the
  infra project root for local esbuild bundling; `backend/` remains the
  source of truth.

## Architecture

```
                         ┌──────────────────────────────────────────────┐
                         │ CloudFront (standard distribution,           │
                         │ PriceClass_100, OAC)                         │
                         │  /            → S3 (private, SPA)            │
                         │  /api/*       → HTTP API (strip /api via     │
                         │                 CloudFront Function)         │
                         └──────────────┬───────────────────────────────┘
                                        │ /api/* (https-only origin)
                                        ▼
┌──────────┐   JWT (Cognito)   ┌─────────────────────┐  SendMessage  ┌──────────────────┐
│ Traveler │ ───────────────▶ │ HTTP API            │ ────────────▶ │ SQS              │
│ (React/  │                  │ 11 JWT routes +     │               │ travelbook-      │
│  Astryx) │                  │ GET /health (open)  │               │ feed-jobs        │
└──────────┘                  │ stage throttle      │               │ + DLQ            │
                              │ burst 40 / rate 20  │               └────────┬─────────┘
                              └────────┬────────────┘                        │ batchSize 1
                                         │ Lambda proxy                      ▼
                                         ▼                          ┌──────────────────┐
                              ┌─────────────────────┐               │ WorkerFunction   │
                              │ ApiFunction         │               │ (reserved conc.  │
                              │ (reserved conc. 5)  │               │  2, 180s, 1 GiB) │
                              └────────┬────────────┘               └────────┬─────────┘
                                       │    ┌───────────────────────────────┘
                                       ▼    ▼
                              ┌─────────────────────────────────┐
                              │ DynamoDB `travelbook` (5/5 RCU/  │
                              │ WCU, TTL on `ttl`)              │
                              │ GSI1 (ALL) · GSI2 (INCLUDE      │
                              │ owner,state)                    │
                              └─────────────────────────────────┘

EventBridge Scheduler `travelbook-advisory-refresh` (rate 6h) → SQS,
state DISABLED until providers are configured.
SSM `/travelbook/dev/*`: llm/provider (template) and duffel/mode (mock)
in the stack; ticketmaster/api-key and llm/api-key created out-of-band as
SecureString (UNSET) — see deviation 10.
Cognito `travelbook-users`: email sign-in, self-signup, MFA off, no hosted UI.
Alarms: worker errors > 3 in 5 min; DLQ depth >= 1. Log retention 7 days.
```

## Deploy instructions

### 0. One-time CloudShell bootstrap (human, reviewed)

```bash
cd ~/workspace/travelbook/infra
npm ci
npx cdk bootstrap aws://<ACCOUNT_ID>/us-west-2   # CDK toolkit (asset staging)
npx cdk deploy travelbook-bootstrap --require-approval never
```

The bootstrap stack creates: `travelbook-artifacts-<account>-us-west-2`
(private, versioned, noncurrent versions expire after 30 days), the GitHub
OIDC provider, `travelbook-github-deploy`, and `travelbook-cfn-exec`.

### 1. Wire GitHub Actions

Set the repo variable `AWS_DEPLOY_ROLE_ARN` to the bootstrap stack's
`DeployRoleArn` output (Settings → Secrets and variables → Actions →
Variables). Pushes to `main` then run `.github/workflows/deploy.yml`:
assume deploy role via OIDC → `cdk deploy` both stacks (CloudFormation
assumes `travelbook-cfn-exec` via `--role-arn`) → build frontend →
write `frontend/dist/config.json` → `s3 sync` → CloudFront invalidation.

### 2. Post-deploy manual steps

- Create the two secret SSM params out-of-band (CFN can't make
  SecureString — deviation 10):
  `aws ssm put-parameter --name /travelbook/dev/ticketmaster/api-key --value UNSET --type SecureString`
  and the same for `/travelbook/dev/llm/api-key`. Set real values later
  with `--overwrite` (keep SecureString). `/travelbook/dev/llm/provider`
  and `/travelbook/dev/duffel/mode` are managed by the stack.
- When providers are ready: enable the `travelbook-advisory-refresh`
  schedule (console or CLI `aws scheduler update-schedule --state ENABLED`).
- Optional: subscribe the distribution to the CloudFront **flat-rate Free
  plan in the console** (not possible via IaC — see deviations).

## Resource allowlist review checklist

The change set for `travelbook-dev` must contain ONLY these resource types
(plus the bootstrap stack's bucket / OIDC / roles):

- `AWS::DynamoDB::Table` (1) · `AWS::SQS::Queue` (2: queue + DLQ)
- `AWS::Lambda::Function` (2) · `AWS::Lambda::EventSourceMapping` (1)
- `AWS::Logs::LogGroup` (2, 7-day retention)
- `AWS::IAM::Role` (3: api, worker, scheduler) · `AWS::IAM::Policy` /
  `AWS::IAM::ManagedPolicy` attachments
- `AWS::Cognito::UserPool` · `AWS::Cognito::UserPoolClient`
- `AWS::ApiGatewayV2::{Api,Authorizer,Integration,Route,Stage,Deployment}`
- `AWS::SSM::Parameter` (2 in-stack, standard tier; 2 SecureString
  created out-of-band — deviation 10)
- `AWS::Scheduler::Schedule` (1, DISABLED)
- `AWS::S3::Bucket` (1, private) · `AWS::CloudFront::{Distribution,
  OriginAccessControl, Function}`
- `AWS::CloudWatch::Alarm` (2)

MUST NOT appear (would break the $0 constraint): NAT Gateway, ALB,
ECS/Fargate, RDS, ElastiCache, OpenSearch, Lambda provisioned concurrency,
custom KMS keys, Secrets Manager, Route 53 hosted zones, WAF WebACL /
paid WAF add-ons.

Also verify: deploy-role inline policy has no `iam:CreateUser` /
`iam:CreateAccessKey`; table is 5/5 provisioned with no autoscaling;
scheduler state is DISABLED.

## OIDC trust details

- Provider: `https://token.actions.githubusercontent.com`,
  client IDs `["sts.amazonaws.com"]` (thumbprint resolved by CDK at deploy).
- `travelbook-github-deploy` trust: `sts:AssumeRoleWithWebIdentity` with
  `StringEquals token.actions.githubusercontent.com:aud = sts.amazonaws.com`
  and `StringLike token.actions.githubusercontent.com:sub =
  repo:kiranbadam/travelbook:ref:refs/heads/main`.
- CloudFormation execution role `travelbook-cfn-exec` is trusted by
  `cloudformation.amazonaws.com` and passed via `cdk deploy --role-arn`.

## Deviations from the architecture plan

1. **CloudFront flat-rate Free plan → standard distribution.** The flat-rate
   plans are managed by a separate PricingPlanManager service and are
   console-only; there is no CloudFormation/CDK resource for them
   (aws-cloudformation/cloudformation-coverage-roadmap#2540). The stack
   creates a standard pay-as-you-go distribution, which is covered by
   CloudFront's always-free allowance (1 TB transfer + 10 M requests/mo).
   Edge rate control is the HTTP API stage throttle (burst 40 / rate 20).
   No standalone WAF WebACL is created ($5/mo — banned). To adopt the
   flat-rate Free plan later, subscribe the distribution in the CloudFront
   console (manual step).
2. **`/api/*` prefix stripping.** The API's routes are `/v1/*`, so a
   CloudFront Function (`travelbook-strip-api-prefix`, viewer-request)
   rewrites `/api/<path>` → `/<path>` before the API origin. Free-tier
   friendly (2 M function invocations/mo in the always-free allowance).
3. **CFN exec role has extra IAM rights.** `travelbook-cfn-exec` gets the
   deploy role's scoped policy PLUS `ManageTravelBookServiceRoles`
   (role create/update/policy-attach on `travelbook-*` roles only). Without
   it CloudFormation cannot create the Lambda execution and scheduler
   roles. The GitHub deploy role does NOT get these rights.
4. **CDK bootstrap permissions.** The deploy role includes minimal
   `cdk-*-assets-*` S3, `cdk-bootstrap/*` SSM read, and CDKToolkit
   `DescribeStacks` rights — required for `cdk deploy` asset staging.
   Run `cdk bootstrap` once from CloudShell before the first CI deploy.
5. **IAM action naming.** The plan's DynamoDB "ConditionCheck" is the real
   IAM action `dynamodb:ConditionCheckItem`; the policy uses the real name.
6. **Lambda entry shims.** Entries are `infra/lambda-entries/*.ts`
   re-exporting `backend/src/{api,worker}/index.ts`, because NodejsFunction
   requires entries under the infra project root for local esbuild
   bundling (no Docker needed in CI).
7. **Retention.** DynamoDB table, Cognito pool, and log groups use
   `RemovalPolicy.DESTROY` (dev stack); both S3 buckets use `RETAIN`.
   Bucket names embed the account ID via `AWS::AccountId` at deploy time
   (synth is account-agnostic and needs no credentials).
8. **GSI2 projection.** `INCLUDE (owner, state)` per backend review, so the
   one-active-job guard can filter by owner server-side (plan said KEYS_ONLY).
9. **Worker queue send.** `WorkerFunction` gets `FEED_QUEUE_URL` and
   `sqs:SendMessage` on the feed-jobs queue for its delayed-requeue path.
10. **SecureString SSM params live outside the stack.** CloudFormation's
    EarlyValidation hook in us-west-2 rejects `AWS::SSM::Parameter` with
    `Type=SecureString` (verified 2026-09-16 with a minimal test stack),
    so `/travelbook/dev/ticketmaster/api-key` and
    `/travelbook/dev/llm/api-key` are created out-of-band as SecureString
    via the CLI after deploy instead of in the template. The stack manages
    the other two (`llm/provider`, `duffel/mode`); the backend treats
    missing/UNSET as mock mode. Re-add them to the template if the hook
    is fixed.

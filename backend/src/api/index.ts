import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import { randomUUID } from "node:crypto";
import {
  ddb,
  TABLE_NAME,
  GSI1,
  GSI2,
  gsi1pkUser,
  gsi2pkJobState,
  nowIso,
  pkFriendReq,
  pkJob,
  pkTrip,
  pkUser,
  skEvidence,
  skFeed,
  skFeedId,
  skFriend,
  skFriendReqFrom,
  skIdempotency,
  skJobMeta,
  skPref,
  skReaction,
  skTripMember,
  skTripMeta,
  skTripPointer,
  skTripVote,
  ttlEpochSeconds,
} from "../shared/ddb.js";
import { ApiError } from "../shared/errors.js";
import { resolveUserSubByEmail } from "../shared/cognito.js";
import {
  header,
  json,
  parseJsonBody,
  queryParam,
  requireSub,
  toErrorResponse,
} from "../shared/http.js";
import { fingerprint } from "../shared/provenance.js";
import {
  computeScore,
  groupAggregate,
  hardFilter,
  interestFit,
  noveltyFit,
  risksFromEvidence,
} from "../shared/scoring.js";
import type {
  Evidence,
  FeedCard,
  FeedJob,
  FeedSnapshot,
  NormalizedPreferences,
  ReactionKind,
  ReactionTargetType,
  RiskItem,
} from "../shared/types.js";
import { normalizePreferences } from "../shared/validation.js";

const sqs = new SQSClient({ maxAttempts: 2 });
const FEED_QUEUE_URL = process.env.FEED_QUEUE_URL ?? "";
const VERSION = "0.1.0";

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */

type Handler = (
  event: APIGatewayProxyEventV2,
  params: Record<string, string>,
) => Promise<APIGatewayProxyStructuredResultV2>;

const routes: { method: string; pattern: RegExp; keys: string[]; handler: Handler }[] = [];

function route(method: string, path: string, handler: Handler): void {
  const keys: string[] = [];
  const pattern = new RegExp(
    "^" +
      path.replace(/\{(\w+)\}/g, (_m: string, k: string) => {
        keys.push(k);
        return "([^/]+)";
      }) +
      "$",
  );
  routes.push({ method, pattern, keys, handler });
}

function notFound(what: string, status = 404): ApiError {
  return new ApiError("POLICY_BLOCKED", `${what} not found`, undefined, status);
}

/** Latest snapshot for a user (GSI1 timeline, newest first). */
async function latestSnapshot(sub: string): Promise<FeedSnapshot | null> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: GSI1,
      KeyConditionExpression: "gsi1pk = :p AND begins_with(gsi1sk, :s)",
      ExpressionAttributeValues: { ":p": gsi1pkUser(sub), ":s": "FEED#" },
      ScanIndexForward: false,
      Limit: 1,
    }),
  );
  return (res.Items?.[0] as unknown as FeedSnapshot | undefined) ?? null;
}

async function snapshotById(sub: string, snapshotId: string): Promise<FeedSnapshot | null> {
  const link = await ddb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { pk: pkUser(sub), sk: skFeedId(snapshotId) },
    }),
  );
  const createdAt = (link.Item as { createdAt?: string } | undefined)?.createdAt;
  if (!createdAt) return null;
  const res = await ddb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { pk: pkUser(sub), sk: skFeed(createdAt) },
    }),
  );
  return (res.Item as unknown as FeedSnapshot | undefined) ?? null;
}

/* ------------------------------------------------------------------ */
/* Display mapping: stored evidence-packet card -> UI feed card        */
/* ------------------------------------------------------------------ */

const KIND_LABELS: Record<string, string> = {
  fare: "round-trip fare",
  weather: "weather window",
  event: "events",
  advisory: "travel advisory",
  entry: "entry rules",
};

function toSourceRef(ev: Evidence): Record<string, unknown> {
  const p = ev.provenance;
  const expiresMs = Date.parse(p.expiresAt);
  return {
    provider: p.provider,
    label: KIND_LABELS[ev.kind] ?? ev.kind,
    checkedAt: p.observedAt,
    expiresAt: p.expiresAt,
    url: p.sourceUrl,
    stale: !Number.isNaN(expiresMs) && expiresMs < Date.now(),
  };
}

/** Convert a stored card + its evidence rows to the frontend's display shape. */
function toDisplayCard(
  card: FeedCard,
  evidence: Evidence[],
): Record<string, unknown> {
  const byKind = (kind: string): Evidence | undefined => evidence.find((e) => e.kind === kind);
  const fareEv = byKind("fare");
  const weatherEv = byKind("weather");
  const eventEv = byKind("event");
  const fareD = (fareEv?.details ?? {}) as Record<string, unknown>;
  const weatherD = (weatherEv?.details ?? {}) as Record<string, unknown>;
  const eventD = (eventEv?.details ?? {}) as Record<string, unknown>;
  const bd = card.scoreBreakdown;
  return {
    destinationId: card.destinationId,
    name: card.name,
    country: card.country,
    score: card.score,
    components: {
      airfare: bd.airfare,
      weather: bd.weather,
      interest: bd.interest,
      travelTime: bd.travelTime,
      freshness: bd.freshness,
      novelty: bd.novelty,
    },
    riskPenalty: bd.riskPenalty,
    reasons: card.reasons,
    fare: fareEv
      ? {
          amount: fareD["amount"] ?? null,
          currency: (fareD["currency"] as string) ?? "USD",
          kind: fareEv.live ? "LIVE" : "ILLUSTRATIVE",
          source: toSourceRef(fareEv),
        }
      : undefined,
    weather: weatherEv
      ? {
          windowSummary: weatherEv.summary,
          daysInBand: (weatherD["daysInBand"] as number) ?? 0,
          totalDays: (weatherD["totalDays"] as number) ?? 0,
          source: toSourceRef(weatherEv),
        }
      : undefined,
    events: Array.isArray(eventD["events"])
      ? (eventD["events"] as Record<string, unknown>[]).map((e) => ({
          name: e["name"] ?? "Event",
          date: e["date"] ?? undefined,
          venue: e["venue"] ?? undefined,
          url: e["url"] ?? undefined,
        }))
      : [],
    uncertainties: card.unknowns,
    risks: card.risks.map((r) => ({
      type: r.type,
      severity: r.severity.toUpperCase(),
      summary: r.summary,
      sourceUrl: r.sourceUrl,
      observedAt: r.observedAt,
    })),
    sources: evidence.map(toSourceRef),
  };
}

/** Fetch EVIDENCE# rows for the given destinations under one job. */
async function evidenceFor(
  evidenceJobId: string,
  destinationIds: string[],
): Promise<Map<string, Evidence[]>> {
  const out = new Map<string, Evidence[]>();
  await Promise.all(
    destinationIds.map(async (destId) => {
      const res = await ddb.send(
        new QueryCommand({
          TableName: TABLE_NAME,
          KeyConditionExpression: "pk = :p AND begins_with(sk, :s)",
          ExpressionAttributeValues: {
            ":p": pkJob(evidenceJobId),
            ":s": skEvidence(destId, ""),
          },
        }),
      );
      out.set(
        destId,
        (res.Items ?? []) as unknown as Evidence[],
      );
    }),
  );
  return out;
}

/**
 * Active (PENDING/RUNNING) jobs owned by a user, via GSI2.
 * NOTE: GSI2 is KEYS_ONLY-projected, so `owner` cannot be filtered
 * server-side — job rows are fetched and filtered in code (fine at alpha
 * scale; recommend INCLUDE(owner,state) projection to the infra owner).
 */
async function activeJobs(sub: string): Promise<{ jobId: string; state: string }[]> {
  const pks = new Set<string>();
  for (const state of ["PENDING", "RUNNING"]) {
    const res = await ddb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: GSI2,
        KeyConditionExpression: "gsi2pk = :p",
        ExpressionAttributeValues: { ":p": gsi2pkJobState(state) },
        ProjectionExpression: "pk",
      }),
    );
    for (const item of res.Items ?? []) pks.add((item as { pk: string }).pk);
  }
  const out: { jobId: string; state: string }[] = [];
  for (const pk of pks) {
    const r = await ddb.send(
      new GetCommand({ TableName: TABLE_NAME, Key: { pk, sk: skJobMeta() } }),
    );
    const j = r.Item as { owner?: string; state?: string } | undefined;
    if (j?.owner === sub && (j.state === "PENDING" || j.state === "RUNNING")) {
      out.push({ jobId: pk.replace(/^JOB#/, ""), state: j.state });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* PUT /v1/preferences                                                 */
/* ------------------------------------------------------------------ */

async function putPreferences(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  const sub = requireSub(event);
  const input = parseJsonBody(event) as Record<string, unknown>;
  const normalized = normalizePreferences(input as never);

  const existing = await ddb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { pk: pkUser(sub), sk: skPref() } }),
  );
  const version = ((existing.Item as { version?: number } | undefined)?.version ?? 0) + 1;

  await ddb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        pk: pkUser(sub),
        sk: skPref(),
        normalized,
        version,
        updatedAt: nowIso(),
      },
    }),
  );
  return json(200, { normalized, warnings: normalized.warnings, version });
}

/* ------------------------------------------------------------------ */
/* POST /v1/feed-jobs                                                  */
/* ------------------------------------------------------------------ */

async function postFeedJob(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  const sub = requireSub(event);
  const idemKey = header(event, "Idempotency-Key");
  if (!idemKey) {
    throw new ApiError("INVALID_PREFERENCES", "Idempotency-Key header is required");
  }
  const keyHash = fingerprint({ sub, key: idemKey });

  // Replay path: an identical request returns the same job.
  const existingIdem = await ddb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { pk: pkUser(sub), sk: skIdempotency(keyHash) },
    }),
  );
  const existingJobId = (existingIdem.Item as { jobId?: string } | undefined)?.jobId;
  if (existingJobId) {
    const job = await ddb.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: pkJob(existingJobId), sk: skJobMeta() },
      }),
    );
    const state = (job.Item as { state?: string } | undefined)?.state ?? "UNKNOWN";
    return json(200, { jobId: existingJobId, state, replayed: true });
  }

  const busy = await activeJobs(sub);
  if (busy.length > 0) {
    throw new ApiError(
      "BUDGET_EXHAUSTED",
      "A feed job is already active for this user; poll it before starting another.",
      { jobId: busy[0]?.jobId },
      429,
    );
  }

  const jobId = randomUUID();
  const now = nowIso();

  // Conditional idempotency record: exactly one job per key.
  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          pk: pkUser(sub),
          sk: skIdempotency(keyHash),
          jobId,
          createdAt: now,
          ttl: ttlEpochSeconds(1),
        },
        ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
      }),
    );
  } catch (err) {
    if ((err as { name?: string }).name === "ConditionalCheckFailedException") {
      const retry = await ddb.send(
        new GetCommand({
          TableName: TABLE_NAME,
          Key: { pk: pkUser(sub), sk: skIdempotency(keyHash) },
        }),
      );
      const jobId2 = (retry.Item as { jobId?: string } | undefined)?.jobId ?? jobId;
      return json(200, { jobId: jobId2, state: "PENDING", replayed: true });
    }
    throw err;
  }

  const job: FeedJob = {
    jobId,
    owner: sub,
    state: "PENDING",
    progress: 0,
    attempts: 0,
    idempotencyKey: idemKey,
    createdAt: now,
    updatedAt: now,
  };
  await ddb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        pk: pkJob(jobId),
        sk: skJobMeta(),
        ...job,
        ttl: ttlEpochSeconds(7),
        gsi2pk: gsi2pkJobState("PENDING"),
        gsi2sk: now,
      },
    }),
  );

  if (!FEED_QUEUE_URL) {
    throw new ApiError("PROVIDER_UNAVAILABLE", "Feed queue is not configured");
  }
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: FEED_QUEUE_URL,
      MessageBody: JSON.stringify({ jobId }),
    }),
  );
  return json(202, { jobId, state: "PENDING" });
}

/* ------------------------------------------------------------------ */
/* GET /v1/feed-jobs/{id}                                              */
/* ------------------------------------------------------------------ */

async function getFeedJob(
  event: APIGatewayProxyEventV2,
  params: Record<string, string>,
): Promise<APIGatewayProxyStructuredResultV2> {
  const sub = requireSub(event);
  const res = await ddb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { pk: pkJob(params["id"] ?? ""), sk: skJobMeta() },
    }),
  );
  const job = res.Item as unknown as FeedJob | undefined;
  if (!job) throw notFound("Job");
  if (job.owner !== sub) throw new ApiError("POLICY_BLOCKED", "Job not found", undefined, 403);
  return json(200, {
    jobId: job.jobId,
    state: job.state,
    progress: job.progress,
    snapshotId: job.snapshotId,
    error: job.error,
    updatedAt: job.updatedAt,
  });
}

/* ------------------------------------------------------------------ */
/* GET /v1/feed                                                        */
/* ------------------------------------------------------------------ */

async function getFeed(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  const sub = requireSub(event);
  const snapshotId = queryParam(event, "snapshotId");
  const snapshot = snapshotId ? await snapshotById(sub, snapshotId) : await latestSnapshot(sub);
  if (!snapshot) {
    if (snapshotId) throw notFound("Snapshot");
    return json(200, { snapshot: null, cards: [], nextCursor: null });
  }

  const etag = `"${snapshot.snapshotId}"`;
  if (header(event, "If-None-Match") === etag) {
    return { statusCode: 304, headers: { ETag: etag }, body: "" };
  }

  const limit = Math.max(1, Math.min(25, parseInt(queryParam(event, "limit") ?? "10", 10) || 10));
  const cursorRaw = queryParam(event, "cursor");
  const offset = cursorRaw
    ? parseInt(Buffer.from(cursorRaw, "base64url").toString("utf8"), 10) || 0
    : 0;
  const cards = snapshot.cards.slice(offset, offset + limit);
  const nextOffset = offset + limit;
  const nextCursor =
    nextOffset < snapshot.cards.length
      ? Buffer.from(String(nextOffset), "utf8").toString("base64url")
      : null;

  const evidenceByDest = await evidenceFor(
    snapshot.evidenceJobId,
    cards.map((c) => c.destinationId),
  );
  const displayCards = cards.map((c) =>
    toDisplayCard(c, evidenceByDest.get(c.destinationId) ?? []),
  );

  return json(
    200,
    {
      snapshot: {
        snapshotId: snapshot.snapshotId,
        createdAt: snapshot.createdAt,
        state: snapshot.state,
        partialFailures: snapshot.partialFailures ?? [],
        visibility: snapshot.visibility ?? "private",
        scoreVersion: snapshot.scoreVersion,
        catalogVersion: snapshot.catalogVersion,
        totalCards: snapshot.cards.length,
      },
      cards: displayCards,
      nextCursor,
    },
    { ETag: etag },
  );
}

/* ------------------------------------------------------------------ */
/* GET /v1/destinations/{id} — full evidence, no model call            */
/* ------------------------------------------------------------------ */

async function getDestination(
  event: APIGatewayProxyEventV2,
  params: Record<string, string>,
): Promise<APIGatewayProxyStructuredResultV2> {
  const sub = requireSub(event);
  const destId = params["id"] ?? "";
  const snapshot = await latestSnapshot(sub);
  if (!snapshot) throw notFound("Feed snapshot");
  const card = snapshot.cards.find((c) => c.destinationId === destId);
  if (!card) throw notFound("Destination in latest snapshot");

  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "pk = :p AND begins_with(sk, :s)",
      ExpressionAttributeValues: {
        ":p": pkJob(snapshot.evidenceJobId),
        ":s": `EVIDENCE#${destId}#`,
      },
    }),
  );
  const nowMs = Date.now();
  const evidence = (res.Items ?? []).map((item) => {
    const ev = item as unknown as Evidence;
    const expiresMs = Date.parse(ev.provenance.expiresAt);
    return {
      ...ev,
      freshness: {
        observedAt: ev.provenance.observedAt,
        expiresAt: ev.provenance.expiresAt,
        stale: !Number.isNaN(expiresMs) && expiresMs < nowMs,
      },
    };
  });

  return json(200, {
    destination: toDisplayCard(card, evidence as unknown as Evidence[]),
    evidence,
  });
}

/* ------------------------------------------------------------------ */
/* POST /v1/reactions                                                  */
/* ------------------------------------------------------------------ */

const REACTION_TARGETS: ReactionTargetType[] = ["feed-item", "destination"];
const REACTION_KINDS: ReactionKind[] = ["like", "save", "hide"];

async function postReaction(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  const sub = requireSub(event);
  const body = parseJsonBody(event) as Partial<{
    targetType: string;
    targetId: string;
    kind: string;
  }>;
  if (!body.targetType || !REACTION_TARGETS.includes(body.targetType as ReactionTargetType)) {
    throw new ApiError("INVALID_PREFERENCES", 'targetType must be "feed-item" or "destination"');
  }
  if (!body.targetId || typeof body.targetId !== "string") {
    throw new ApiError("INVALID_PREFERENCES", "targetId is required");
  }
  if (!body.kind || !REACTION_KINDS.includes(body.kind as ReactionKind)) {
    throw new ApiError("INVALID_PREFERENCES", 'kind must be "like", "save" or "hide"');
  }
  const now = nowIso();
  const key = { pk: pkUser(sub), sk: skReaction(body.targetType, body.targetId) };
  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          ...key,
          targetType: body.targetType,
          targetId: body.targetId,
          kind: body.kind,
          owner: sub,
          createdAt: now,
          updatedAt: now,
        },
        ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
      }),
    );
  } catch (err) {
    if ((err as { name?: string }).name === "ConditionalCheckFailedException") {
      await ddb.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: key,
          UpdateExpression: "SET #kind = :k, updatedAt = :u",
          ExpressionAttributeNames: { "#kind": "kind" },
          ExpressionAttributeValues: { ":k": body.kind, ":u": now },
        }),
      );
    } else {
      throw err;
    }
  }
  return json(200, { ok: true });
}

/* ------------------------------------------------------------------ */
/* Trips                                                               */
/* ------------------------------------------------------------------ */

async function postTrip(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  const sub = requireSub(event);
  const body = parseJsonBody(event) as Partial<{
    name: string;
    departDate: string;
    returnDate: string;
    startDate: string;
    endDate: string;
  }>;
  const tripId = randomUUID();
  const now = nowIso();
  const departDate = body.departDate ?? body.startDate ?? null;
  const returnDate = body.returnDate ?? body.endDate ?? null;
  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: TABLE_NAME,
            Item: {
              pk: pkTrip(tripId),
              sk: skTripMeta(),
              tripId,
              owner: sub,
              name: body.name ?? null,
              visibility: "private",
              status: "planning",
              departDate,
              returnDate,
              createdAt: now,
            },
            ConditionExpression: "attribute_not_exists(pk)",
          },
        },
        {
          Put: {
            TableName: TABLE_NAME,
            Item: {
              pk: pkTrip(tripId),
              sk: skTripMember(sub),
              userId: sub,
              role: "owner",
              joinedAt: now,
            },
            ConditionExpression: "attribute_not_exists(pk)",
          },
        },
        {
          Put: {
            TableName: TABLE_NAME,
            Item: {
              pk: pkUser(sub),
              sk: skTripPointer(tripId),
              tripId,
              role: "owner",
              joinedAt: now,
            },
            ConditionExpression: "attribute_not_exists(pk)",
          },
        },
      ],
    }),
  );
  return json(201, {
    trip: {
      tripId,
      name: body.name ?? null,
      startDate: departDate,
      endDate: returnDate,
      ownerSub: sub,
      visibility: "private",
      status: "planning",
      createdAt: now,
    },
  });
}

async function getTripMeta(tripId: string): Promise<Record<string, unknown>> {
  const res = await ddb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { pk: pkTrip(tripId), sk: skTripMeta() } }),
  );
  if (!res.Item) throw notFound("Trip");
  return res.Item as Record<string, unknown>;
}

async function requireMembership(tripId: string, sub: string): Promise<void> {
  const res = await ddb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { pk: pkTrip(tripId), sk: skTripMember(sub) },
    }),
  );
  if (!res.Item) throw new ApiError("POLICY_BLOCKED", "Trip not found", undefined, 403);
}

/* ------------------------------------------------------------------ */
/* PUT /v1/trips/{id}/votes/me — ranked ballot + Borda aggregate       */
/* ------------------------------------------------------------------ */

async function putVote(
  event: APIGatewayProxyEventV2,
  params: Record<string, string>,
): Promise<APIGatewayProxyStructuredResultV2> {
  const sub = requireSub(event);
  const tripId = params["id"] ?? "";
  await getTripMeta(tripId);
  await requireMembership(tripId, sub);

  const body = parseJsonBody(event) as Partial<{ ranking: unknown }>;
  const ranking = body.ranking;
  if (
    !Array.isArray(ranking) ||
    ranking.length === 0 ||
    ranking.some((r) => typeof r !== "string")
  ) {
    throw new ApiError(
      "INVALID_PREFERENCES",
      "ranking must be a non-empty array of destination ids",
    );
  }
  const ballot = Array.from(new Set(ranking as string[]));
  const now = nowIso();
  const newSk = skTripVote(ballot[0] ?? "none", sub);

  // One ballot per voter: remove any previous ballot row under a different key.
  const existing = await ddb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "pk = :p AND begins_with(sk, :s)",
      FilterExpression: "userId = :u",
      ExpressionAttributeValues: { ":p": pkTrip(tripId), ":s": "VOTE#", ":u": sub },
      ProjectionExpression: "sk",
    }),
  );
  const transactItems: (
    | { Delete: { TableName: string; Key: Record<string, string> } }
    | { Put: { TableName: string; Item: Record<string, unknown> } }
  )[] = [];
  for (const item of existing.Items ?? []) {
    const sk = (item as { sk: string }).sk;
    if (sk !== newSk) {
      transactItems.push({ Delete: { TableName: TABLE_NAME, Key: { pk: pkTrip(tripId), sk } } });
    }
  }
  transactItems.push({
    Put: {
      TableName: TABLE_NAME,
      Item: {
        pk: pkTrip(tripId),
        sk: newSk,
        destinationId: ballot[0] ?? "none",
        userId: sub,
        ranking: ballot,
        updatedAt: now,
      },
    },
  });
  await ddb.send(new TransactWriteCommand({ TransactItems: transactItems }));

  // Deterministic Borda-count aggregate over all ballots.
  const all = await ddb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "pk = :p AND begins_with(sk, :s)",
      ExpressionAttributeValues: { ":p": pkTrip(tripId), ":s": "VOTE#" },
    }),
  );
  const borda: Record<string, number> = {};
  let ballots = 0;
  for (const item of all.Items ?? []) {
    const r = (item as { ranking?: string[] }).ranking;
    if (!Array.isArray(r)) continue;
    ballots++;
    r.forEach((dest, idx) => {
      borda[dest] = (borda[dest] ?? 0) + (r.length - 1 - idx);
    });
  }
  const aggregate = { borda, ballots, updatedAt: now };
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { pk: pkTrip(tripId), sk: skTripMeta() },
      UpdateExpression: "SET voteAggregate = :a",
      ExpressionAttributeValues: { ":a": aggregate },
    }),
  );
  return json(200, { ok: true, tripId, aggregate });
}

/* ------------------------------------------------------------------ */
/* Friends                                                             */
/* ------------------------------------------------------------------ */

async function postFriendRequest(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  const sub = requireSub(event);
  const body = parseJsonBody(event) as Partial<{
    toUserId: string;
    userId: string;
    email: string;
  }>;
  const toUserId = body.toUserId ?? body.userId;
  if (!toUserId || typeof toUserId !== "string") {
    if (body.email && typeof body.email === "string") {
      const resolved = await resolveUserSubByEmail(body.email.trim().toLowerCase());
      if (!resolved) {
        throw new ApiError(
          "INVALID_PREFERENCES",
          "No TravelBook user found with that email — ask them for their user ID instead",
        );
      }
      return postFriendRequestTo(event, resolved);
    }
    throw new ApiError("INVALID_PREFERENCES", "toUserId is required");
  }
  return postFriendRequestTo(event, toUserId);
}

/** Shared implementation once the recipient sub is known. */
async function postFriendRequestTo(
  event: APIGatewayProxyEventV2,
  toUserId: string,
): Promise<APIGatewayProxyStructuredResultV2> {
  const sub = requireSub(event);
  if (toUserId === sub) {
    throw new ApiError("INVALID_PREFERENCES", "Cannot send a friend request to yourself");
  }
  const already = await ddb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { pk: pkUser(sub), sk: skFriend(toUserId) },
    }),
  );
  if (already.Item) throw new ApiError("INVALID_PREFERENCES", "Already friends");

  const now = nowIso();
  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          pk: pkFriendReq(toUserId),
          sk: skFriendReqFrom(sub),
          fromUserId: sub,
          toUserId,
          status: "pending",
          createdAt: now,
        },
        ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
      }),
    );
    return json(201, {
      request: { requestId: sub, fromSub: sub, toSub: toUserId, createdAt: now },
    });
  } catch (err) {
    if ((err as { name?: string }).name === "ConditionalCheckFailedException") {
      return json(200, {
        request: { requestId: sub, fromSub: sub, toSub: toUserId, createdAt: now },
        replayed: true,
      });
    }
    throw err;
  }
}

async function postFriendAccept(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  const sub = requireSub(event);
  const body = parseJsonBody(event) as Partial<{ fromUserId: string; requestId: string }>;
  // requestId is the requester's sub in our model (FRIENDREQ#<to>/FROM#<from>).
  const fromUserId = body.fromUserId ?? body.requestId;
  if (!fromUserId || typeof fromUserId !== "string") {
    throw new ApiError("INVALID_PREFERENCES", "fromUserId is required");
  }
  const req = await ddb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { pk: pkFriendReq(sub), sk: skFriendReqFrom(fromUserId) },
    }),
  );
  const item = req.Item as { status?: string } | undefined;
  if (!item || item.status !== "pending") {
    throw new ApiError(
      "POLICY_BLOCKED",
      "No pending friend request from this user",
      undefined,
      404,
    );
  }
  const now = nowIso();
  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Delete: {
            TableName: TABLE_NAME,
            Key: { pk: pkFriendReq(sub), sk: skFriendReqFrom(fromUserId) },
            ConditionExpression: "attribute_exists(pk)",
          },
        },
        {
          Put: {
            TableName: TABLE_NAME,
            Item: {
              pk: pkUser(fromUserId),
              sk: skFriend(sub),
              userId: fromUserId,
              friendId: sub,
              since: now,
            },
            ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
          },
        },
        {
          Put: {
            TableName: TABLE_NAME,
            Item: {
              pk: pkUser(sub),
              sk: skFriend(fromUserId),
              userId: sub,
              friendId: fromUserId,
              since: now,
            },
            ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
          },
        },
      ],
    }),
  );
  return json(200, { ok: true, friend: fromUserId });
}

/* ------------------------------------------------------------------ */
/* Trips: list / detail / members                                       */
/* ------------------------------------------------------------------ */

function toTripSummary(
  meta: Record<string, unknown>,
): Record<string, unknown> {
  return {
    tripId: meta["tripId"],
    name: meta["name"] ?? null,
    startDate: (meta["departDate"] as string | null) ?? null,
    endDate: (meta["returnDate"] as string | null) ?? null,
    ownerSub: meta["owner"],
    visibility: meta["visibility"] ?? "private",
    status: meta["status"] ?? "planning",
    createdAt: meta["createdAt"] ?? null,
  };
}

async function listTrips(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  const sub = requireSub(event);
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "pk = :p AND begins_with(sk, :s)",
      ExpressionAttributeValues: { ":p": pkUser(sub), ":s": "TRIPMEMBER#" },
      ProjectionExpression: "tripId",
    }),
  );
  const trips: Record<string, unknown>[] = [];
  for (const item of res.Items ?? []) {
    const tripId = (item as { tripId?: string }).tripId;
    if (!tripId) continue;
    const meta = await getTripMeta(tripId).catch(() => null);
    if (meta) trips.push(toTripSummary(meta));
  }
  return json(200, { trips });
}

async function getTrip(
  event: APIGatewayProxyEventV2,
  params: Record<string, string>,
): Promise<APIGatewayProxyStructuredResultV2> {
  const sub = requireSub(event);
  const tripId = params["id"] ?? "";
  const meta = await getTripMeta(tripId);
  await requireMembership(tripId, sub);

  const membersRes = await ddb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "pk = :p AND begins_with(sk, :s)",
      ExpressionAttributeValues: { ":p": pkTrip(tripId), ":s": "MEMBER#" },
    }),
  );
  const members = (membersRes.Items ?? []).map((m) => {
    const r = m as { userId?: string; role?: string; joinedAt?: string };
    return { userSub: r.userId, role: r.role ?? "member", joinedAt: r.joinedAt ?? null };
  });

  const votesRes = await ddb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "pk = :p AND begins_with(sk, :s)",
      ExpressionAttributeValues: { ":p": pkTrip(tripId), ":s": "VOTE#" },
    }),
  );
  let myRanking: string[] = [];
  const candidateSet = new Set<string>();
  for (const item of votesRes.Items ?? []) {
    const v = item as { userId?: string; ranking?: string[] };
    if (Array.isArray(v.ranking)) {
      for (const d of v.ranking) candidateSet.add(d);
      if (v.userId === sub) myRanking = v.ranking;
    }
  }

  return json(200, {
    trip: { ...toTripSummary(meta), members, myRanking, candidateIds: [...candidateSet] },
  });
}

async function addTripMember(
  event: APIGatewayProxyEventV2,
  params: Record<string, string>,
): Promise<APIGatewayProxyStructuredResultV2> {
  const sub = requireSub(event);
  const tripId = params["id"] ?? "";
  const meta = await getTripMeta(tripId);
  await requireMembership(tripId, sub);
  if (meta["owner"] !== sub) {
    throw new ApiError("POLICY_BLOCKED", "Only the trip owner can add members", undefined, 403);
  }
  const body = parseJsonBody(event) as Partial<{ userSub: string }>;
  const userSub = body.userSub;
  if (!userSub || typeof userSub !== "string") {
    throw new ApiError("INVALID_PREFERENCES", "userSub is required");
  }
  const now = nowIso();
  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: TABLE_NAME,
            Item: {
              pk: pkTrip(tripId),
              sk: skTripMember(userSub),
              userId: userSub,
              role: "member",
              joinedAt: now,
            },
            ConditionExpression: "attribute_not_exists(pk)",
          },
        },
        {
          Put: {
            TableName: TABLE_NAME,
            Item: {
              pk: pkUser(userSub),
              sk: skTripPointer(tripId),
              tripId,
              role: "member",
              joinedAt: now,
            },
            ConditionExpression: "attribute_not_exists(pk)",
          },
        },
      ],
    }),
  ).catch((err) => {
    if ((err as { name?: string }).name === "TransactionCanceledException") {
      throw new ApiError("INVALID_PREFERENCES", "User is already a member of this trip");
    }
    throw err;
  });
  return json(200, { ok: true, tripId, userSub });
}

/* ------------------------------------------------------------------ */
/* Friends: list / incoming requests / shared feed / sharing           */
/* ------------------------------------------------------------------ */

async function listFriends(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  const sub = requireSub(event);
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "pk = :p AND begins_with(sk, :s)",
      ExpressionAttributeValues: { ":p": pkUser(sub), ":s": "FRIEND#" },
    }),
  );
  const friends = (res.Items ?? []).map((m) => {
    const r = m as { friendId?: string; since?: string };
    return { userSub: r.friendId, friendsSince: r.since ?? null };
  });
  return json(200, { friends });
}

async function listIncomingRequests(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  const sub = requireSub(event);
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "pk = :p AND begins_with(sk, :s)",
      ExpressionAttributeValues: { ":p": pkFriendReq(sub), ":s": "FROM#" },
    }),
  );
  const requests = (res.Items ?? []).map((m) => {
    const r = m as { fromUserId?: string; createdAt?: string };
    return {
      requestId: r.fromUserId,
      fromSub: r.fromUserId,
      toSub: sub,
      createdAt: r.createdAt ?? null,
    };
  });
  return json(200, { requests });
}

/** Share (or unshare) the caller's latest feed snapshot with friends. */
async function shareFeed(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  const sub = requireSub(event);
  const body = parseJsonBody(event) as Partial<{ visibility: string }>;
  const visibility = body.visibility;
  if (visibility !== "private" && visibility !== "friends") {
    throw new ApiError("INVALID_PREFERENCES", 'visibility must be "private" or "friends"');
  }
  const snapshot = await latestSnapshot(sub);
  if (!snapshot) throw notFound("Feed snapshot");
  const createdAt = snapshot.createdAt;
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { pk: pkUser(sub), sk: skFeed(createdAt) },
      UpdateExpression: "SET visibility = :v, sharedAt = :s",
      ExpressionAttributeValues: { ":v": visibility, ":s": nowIso() },
    }),
  );
  return json(200, { ok: true, visibility });
}

/** Read a mutual friend's explicitly shared feed. Private until shared. */
async function getFriendFeed(
  event: APIGatewayProxyEventV2,
  params: Record<string, string>,
): Promise<APIGatewayProxyStructuredResultV2> {
  const sub = requireSub(event);
  const friendSub = params["id"] ?? "";
  const edge = await ddb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { pk: pkUser(sub), sk: skFriend(friendSub) },
    }),
  );
  if (!edge.Item) {
    throw new ApiError("POLICY_BLOCKED", "Not friends with this user", undefined, 403);
  }
  const snapshot = await latestSnapshot(friendSub);
  if (!snapshot || snapshot.visibility !== "friends") {
    throw new ApiError("POLICY_BLOCKED", "This feed is private", undefined, 403);
  }
  const evidenceByDest = await evidenceFor(
    snapshot.evidenceJobId,
    snapshot.cards.map((c) => c.destinationId),
  );
  const since = (edge.Item as { since?: string }).since ?? null;
  return json(200, {
    friend: { userSub: friendSub, friendsSince: since },
    sharedAt: snapshot.sharedAt ?? snapshot.createdAt,
    cards: snapshot.cards.map((c) =>
      toDisplayCard(c, evidenceByDest.get(c.destinationId) ?? []),
    ),
  });
}

/* ------------------------------------------------------------------ */
/* GET /v1/trips/{id}/recommendations — fairness scoring               */
/* ------------------------------------------------------------------ */

function evidenceDetails(
  evidence: Evidence[],
  kind: Evidence["kind"],
): Record<string, unknown> | null {
  const ev = evidence.find((e) => e.kind === kind);
  return (ev?.details as Record<string, unknown> | undefined) ?? null;
}

type AdvisorySev = "low" | "moderate" | "high" | "critical" | "unknown";

function advisorySeverityOf(evidence: Evidence[]): AdvisorySev {
  const adv = evidence.find((e) => e.kind === "advisory");
  const level = adv?.details["level"];
  if (level === 1) return "low";
  if (level === 2) return "moderate";
  if (level === 3) return "high";
  if (level === 4) return "critical";
  return "unknown";
}

async function getRecommendations(
  event: APIGatewayProxyEventV2,
  params: Record<string, string>,
): Promise<APIGatewayProxyStructuredResultV2> {
  const sub = requireSub(event);
  const tripId = params["id"] ?? "";
  await getTripMeta(tripId);
  await requireMembership(tripId, sub);

  const membersRes = await ddb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "pk = :p AND begins_with(sk, :s)",
      ExpressionAttributeValues: { ":p": pkTrip(tripId), ":s": "MEMBER#" },
    }),
  );
  const memberIds = (membersRes.Items ?? []).map((m) => (m as { userId: string }).userId);

  const travelers: { userId: string; prefs: NormalizedPreferences | null }[] = [];
  for (const userId of memberIds) {
    const prefRes = await ddb.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: pkUser(userId), sk: skPref() },
      }),
    );
    travelers.push({
      userId,
      prefs: (prefRes.Item as { normalized?: NormalizedPreferences } | undefined)?.normalized ?? null,
    });
  }
  const withPrefs = travelers.filter(
    (t): t is { userId: string; prefs: NormalizedPreferences } => t.prefs !== null,
  );
  if (withPrefs.length === 0) {
    throw new ApiError("INSUFFICIENT_EVIDENCE", "No trip member has saved preferences yet");
  }

  // Shared evidence: the caller's latest snapshot + its evidence rows.
  const snapshot = await latestSnapshot(sub);
  if (!snapshot || snapshot.cards.length === 0) {
    throw new ApiError(
      "INSUFFICIENT_EVIDENCE",
      "Generate a feed first so the trip has shared evidence to score",
    );
  }
  const evRes = await ddb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "pk = :p AND begins_with(sk, :s)",
      ExpressionAttributeValues: {
        ":p": pkJob(snapshot.evidenceJobId),
        ":s": "EVIDENCE#",
      },
    }),
  );
  const byDest = new Map<string, Evidence[]>();
  for (const item of evRes.Items ?? []) {
    const ev = item as unknown as Evidence;
    const list = byDest.get(ev.destinationId) ?? [];
    list.push(ev);
    byDest.set(ev.destinationId, list);
  }

  interface Utility {
    userId: string;
    score: number;
    breakdown: Record<string, number>;
  }
  interface DestScore {
    destinationId: string;
    name: string;
    utilities: Utility[];
    aggregate: number;
    feasible: boolean;
  }
  const scored: DestScore[] = [];
  const excluded: { destinationId: string; traveler: string; reasons: string[] }[] = [];
  const nowMs = Date.now();

  for (const card of snapshot.cards) {
    const evidence = byDest.get(card.destinationId) ?? [];
    const fare = evidenceDetails(evidence, "fare");
    const weather = evidenceDetails(evidence, "weather");
    const events = evidenceDetails(evidence, "event");
    const sharedRisks = card.risks.filter(
      (r) => r.type === "SEASONAL" || r.type === "BOOKING_CONFIDENCE",
    );

    const utilities: Utility[] = [];
    let feasible = true;
    for (const t of withPrefs) {
      const p = t.prefs;
      const fareAmount = typeof fare?.["amount"] === "number" ? (fare["amount"] as number) : null;
      const days = Array.isArray(weather?.["days"])
        ? (weather["days"] as { maxF: number }[])
        : [];
      const daysInBand = days.filter(
        (d) => d.maxF >= p.tempMinF && d.maxF <= p.tempMaxF,
      ).length;
      const entryEv = evidence.find((e) => e.kind === "entry");
      const entryReq = entryEv?.details["requirement"];
      const risks: RiskItem[] = [
        ...risksFromEvidence(evidence, p, card.destinationId),
        ...sharedRisks,
      ];
      const filter = hardFilter({
        fareAmount,
        ceiling: p.airfareMaxPerPerson,
        daysInBand,
        totalDays: days.length,
        tempHard: p.tempHard,
        advisorySeverity: advisorySeverityOf(evidence),
        advisoryThreshold: p.advisoryMaxSeverity,
        entryStatus: entryReq === undefined || entryReq === "unknown" ? "UNRESOLVED" : "OK",
        entryKnown: entryReq !== undefined && entryReq !== "unknown",
      });
      if (!filter.pass) {
        feasible = false;
        excluded.push({
          destinationId: card.destinationId,
          traveler: t.userId,
          reasons: filter.reasons,
        });
        continue;
      }
      const eventList = Array.isArray(events?.["events"])
        ? (events["events"] as { classification: string | null }[])
        : [];
      const matchingEvents = eventList.filter((e) =>
        p.interests.some((i) =>
          (e.classification ?? "").toLowerCase().includes(i.split(" ")[0] ?? ""),
        ),
      ).length;
      const matchedTags = card.interestTags.filter((tag) => p.interests.includes(tag)).length;
      const breakdown = computeScore({
        fareAmount: fareAmount ?? p.airfareMaxPerPerson,
        ceiling: p.airfareMaxPerPerson,
        daysInBand,
        totalDays: days.length,
        interestScore: interestFit(matchedTags, p.interests.length, matchingEvents),
        stops: typeof fare?.["stops"] === "number" ? (fare["stops"] as number) : 1,
        durationHours:
          typeof fare?.["durationHours"] === "number" ? (fare["durationHours"] as number) : 8,
        evidenceAges: evidence.map((e) => ({
          ageSec: Math.max(0, (nowMs - Date.parse(e.provenance.observedAt)) / 1000),
          ttlSec: Math.max(
            1,
            (Date.parse(e.provenance.expiresAt) - Date.parse(e.provenance.observedAt)) / 1000,
          ),
        })),
        novelty: noveltyFit(false),
        risks,
      });
      utilities.push({ userId: t.userId, score: breakdown.total, breakdown: { ...breakdown } });
    }
    if (utilities.length === 0) continue;
    scored.push({
      destinationId: card.destinationId,
      name: card.name,
      utilities,
      aggregate: groupAggregate(utilities.map((u) => u.score)),
      feasible,
    });
  }

  const feasibleOnly = scored.filter((s) => s.feasible);
  const meanOf = (s: DestScore, k: string): number =>
    s.utilities.reduce((sum, u) => sum + (u.breakdown[k] ?? 0), 0) / s.utilities.length;
  const pick = (fn: (s: DestScore) => number): DestScore | null =>
    feasibleOnly.length ? feasibleOnly.reduce((a, b) => (fn(b) > fn(a) ? b : a)) : null;

  const slim = (s: DestScore | null) =>
    s
      ? {
          destinationId: s.destinationId,
          name: s.name,
          aggregate: Math.round(s.aggregate * 10) / 10,
          utilities: s.utilities.map((u) => ({ userId: u.userId, score: u.score })),
        }
      : null;

  return json(200, {
    tripId,
    travelers: travelers.map((t) => ({ userId: t.userId, hasPreferences: t.prefs !== null })),
    feasible: feasibleOnly.map(slim),
    pareto: {
      bestOverall: slim(pick((s) => s.aggregate)),
      bestBudget: slim(pick((s) => meanOf(s, "airfare"))),
      bestWeather: slim(pick((s) => meanOf(s, "weather"))),
      bestSharedInterest: slim(pick((s) => meanOf(s, "interest"))),
    },
    excluded,
    method:
      "Hard-feasibility intersection first (a destination one traveler cannot take is never recommended); " +
      "then per-traveler utility via the shared deterministic scorer; " +
      "ranked by weighted mean utility minus 0.5 x the worst-off traveler's shortfall below the mean (fairness, not majority-wins).",
  });
}

/* ------------------------------------------------------------------ */
/* GET /health (no auth)                                               */
/* ------------------------------------------------------------------ */

async function health(): Promise<APIGatewayProxyStructuredResultV2> {
  return json(200, { ok: true, version: VERSION });
}

/* ------------------------------------------------------------------ */
/* Entrypoint                                                          */
/* ------------------------------------------------------------------ */

route("PUT", "/v1/preferences", putPreferences);
route("POST", "/v1/feed-jobs", postFeedJob);
route("GET", "/v1/feed-jobs/{id}", getFeedJob);
route("GET", "/v1/feed", getFeed);
route("GET", "/v1/destinations/{id}", getDestination);
route("POST", "/v1/reactions", postReaction);
route("POST", "/v1/trips", postTrip);
route("GET", "/v1/trips", listTrips);
route("GET", "/v1/trips/{id}", getTrip);
route("PUT", "/v1/trips/{id}/votes/me", putVote);
route("POST", "/v1/trips/{id}/members", addTripMember);
route("POST", "/v1/friends/requests", postFriendRequest);
route("GET", "/v1/friends/requests/incoming", listIncomingRequests);
route("POST", "/v1/friends/accept", postFriendAccept);
route("GET", "/v1/friends", listFriends);
route("GET", "/v1/friends/{id}/feed", getFriendFeed);
route("POST", "/v1/feed/share", shareFeed);
route("GET", "/v1/trips/{id}/recommendations", getRecommendations);

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    const method = event.requestContext.http.method;
    const path = event.requestContext.http.path;

    if (method === "GET" && path === "/health") return health();
    if (method === "OPTIONS") return { statusCode: 204, headers: {}, body: "" };

    for (const r of routes) {
      if (r.method !== method) continue;
      const m = r.pattern.exec(path);
      if (!m) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => {
        params[k] = decodeURIComponent(m[i + 1] ?? "");
      });
      return await r.handler(event, params);
    }
    return json(404, { error: { class: "POLICY_BLOCKED", message: "Not found" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}

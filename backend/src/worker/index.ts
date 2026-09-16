import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { SQSEvent } from "aws-lambda";
import { randomUUID } from "node:crypto";
import { CATALOG, CATALOG_VERSION, distanceMiles } from "../shared/catalog.js";
import {
  ddb,
  TABLE_NAME,
  GSI1,
  GSI2,
  gsi1pkUser,
  gsi1skFeed,
  gsi2pkJobState,
  nowIso,
  pkCache,
  pkJob,
  pkUser,
  skCacheResult,
  skEvidence,
  skFeed,
  skFeedId,
  skJobMeta,
  skPref,
  ttlEpochSeconds,
  ttlFromMs,
} from "../shared/ddb.js";
import { ApiError } from "../shared/errors.js";
import {
  SCORE_VERSION,
  computeScore,
  hardFilter,
  interestFit,
  noveltyFit,
  risksFromEvidence,
} from "../shared/scoring.js";
import type {
  Destination,
  ErrorClass,
  Evidence,
  FeedCard,
  FeedJob,
  FeedSnapshot,
  LlmNarrateInput,
  NormalizedPreferences,
  RiskItem,
} from "../shared/types.js";
import { sharedSnapshotKey } from "../shared/validation.js";
import {
  evidenceQueryHash,
  getCachedEvidence,
  putCachedEvidence,
} from "../providers/cache.js";
import type { EnrichInput, EvidenceProvider } from "../providers/interface.js";
import { OpenMeteoProvider } from "../providers/openMeteo.js";
import { TicketmasterProvider } from "../providers/ticketmaster.js";
import { DuffelProvider } from "../providers/duffel.js";
import { AdvisoryProvider } from "../providers/advisories.js";
import { VisaProvider } from "../providers/visa.js";
import { narrate } from "../providers/llm.js";

const sqs = new SQSClient({ maxAttempts: 2 });
const FEED_QUEUE_URL = process.env.FEED_QUEUE_URL ?? "";

const PROVIDER_TIMEOUT_MS = 8000;
const MAX_CANDIDATES = 8;
const MAX_NARRATED = 5;
const SHARED_SNAPSHOT_TTL_MS = 6 * 60 * 60 * 1000;

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const gate = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, gate]).finally(() => clearTimeout(timer));
}

async function setJobState(
  jobId: string,
  state: FeedJob["state"],
  patch: Partial<FeedJob> = {},
  expected: FeedJob["state"] | null = "RUNNING",
): Promise<void> {
  const now = nowIso();
  const names: Record<string, string> = { "#st": "state" };
  const values: Record<string, unknown> = {
    ":s": state,
    ":u": now,
    ":g": gsi2pkJobState(state),
    ":gsk": now,
  };
  let set = "SET #st = :s, updatedAt = :u, gsi2pk = :g, gsi2sk = :gsk";
  if (patch.progress !== undefined) {
    set += ", progress = :p";
    values[":p"] = patch.progress;
  }
  if (patch.attempts !== undefined) {
    set += ", attempts = :a";
    values[":a"] = patch.attempts;
  }
  if (patch.snapshotId !== undefined) {
    set += ", snapshotId = :sid";
    values[":sid"] = patch.snapshotId;
  }
  if (patch.error !== undefined) {
    set += ", #err = :e";
    names["#err"] = "error";
    values[":e"] = patch.error;
  }
  if (patch.nextAttemptAt !== undefined) {
    set += ", nextAttemptAt = :n";
    values[":n"] = patch.nextAttemptAt;
  }
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { pk: pkJob(jobId), sk: skJobMeta() },
      UpdateExpression: set,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ...(expected ? { ConditionExpression: "#st = :exp", ExpressionAttributeValues: { ...values, ":exp": expected } } : {}),
    }),
  );
}

/* ------------------------------------------------------------------ */
/* Step 3: bounded candidate set (<= 8 enrichments)                     */
/* ------------------------------------------------------------------ */

/**
 * Reduce the catalog to at most 8 enrichment candidates using geometry,
 * seasonality context, and interest overlap — no provider calls.
 */
export function reduceCandidates(
  prefs: NormalizedPreferences,
  catalog: Destination[] = CATALOG,
  max = MAX_CANDIDATES,
): Destination[] {
  const originCodes = new Set(prefs.originAirports);
  const scored = catalog
    .filter((d) => !d.airports.some((a) => originCodes.has(a)))
    .map((d) => {
      const miles = distanceMiles(prefs.originLat, prefs.originLon, d.lat, d.lon);
      const overlap = d.interestTags.filter((t) => prefs.interests.includes(t)).length;
      return { d, score: overlap * 1000 - miles / 50 };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, max);
  return scored.map((s) => s.d);
}

/* ------------------------------------------------------------------ */
/* Step 4: parallel enrichment with budgets                            */
/* ------------------------------------------------------------------ */

const PROVIDERS: EvidenceProvider<unknown>[] = [
  new OpenMeteoProvider(),
  new DuffelProvider(),
  new TicketmasterProvider(),
  new AdvisoryProvider(),
  new VisaProvider(),
];

interface EnrichResult {
  evidence: Evidence[];
  providerFailures: string[];
}

async function enrichWithProvider(
  provider: EvidenceProvider<unknown>,
  input: EnrichInput,
): Promise<{ evidence: Evidence[]; failed: boolean }> {
  const queryHash = evidenceQueryHash({
    provider: provider.name,
    destinationId: input.destination.id,
    lat: input.destination.lat,
    lon: input.destination.lon,
    airports: input.destination.airports,
    departDate: input.prefs.departDate,
    tripDays: input.prefs.tripDays,
  });
  const cached = await getCachedEvidence(queryHash, provider.name, provider.freshnessMs());
  if (cached && !cached.stale) return { evidence: cached.evidence, failed: false };

  try {
    const raw = await withTimeout(provider.search(input), PROVIDER_TIMEOUT_MS, provider.name);
    const evidence = provider.normalize(raw, input);
    await putCachedEvidence(queryHash, provider.name, evidence, provider.freshnessMs());
    return { evidence, failed: false };
  } catch (err) {
    console.warn(JSON.stringify({ msg: "provider failed", provider: provider.name, dest: input.destination.id, err: String(err) }));
    if (cached?.stale) {
      // Stale-if-error: serve labeled stale evidence.
      const labeled = cached.evidence.map((e) => ({
        ...e,
        provenance: {
          ...e.provenance,
          unknowns: [...e.provenance.unknowns, "Served from stale cache after a provider failure"],
        },
      }));
      return { evidence: labeled, failed: true };
    }
    return { evidence: [], failed: true };
  }
}

async function enrichDestination(
  dest: Destination,
  prefs: NormalizedPreferences,
): Promise<EnrichResult> {
  const ctrl = new AbortController();
  const input: EnrichInput = {
    destination: dest,
    prefs,
    timeoutMs: PROVIDER_TIMEOUT_MS,
    signal: ctrl.signal,
  };
  const results = await Promise.all(
    PROVIDERS.map((p) => enrichWithProvider(p, input)),
  );
  const evidence = results.flatMap((r) => r.evidence);
  const providerFailures = PROVIDERS.filter((_, i) => results[i]?.failed).map((p) => p.name);
  return { evidence, providerFailures };
}

/* ------------------------------------------------------------------ */
/* Seasonal context risks (never live alerts)                          */
/* ------------------------------------------------------------------ */

const SEASON_RULES: { tag: string; months: number[]; summary: string; severity: RiskItem["severity"] }[] = [
  { tag: "tornado-season-apr-jun", months: [4, 5, 6], summary: "Tornado season (Apr\u2013Jun) \u2014 severe weather possible", severity: "moderate" },
  { tag: "hurricane-season-jun-nov", months: [6, 7, 8, 9, 10, 11], summary: "Hurricane season (Jun\u2013Nov) \u2014 monitor forecasts", severity: "moderate" },
  { tag: "heat-jun-sep", months: [6, 7, 8, 9], summary: "Peak heat season (Jun\u2013Sep)", severity: "low" },
  { tag: "winter-dec-feb", months: [12, 1, 2], summary: "Winter season (Dec\u2013Feb) \u2014 snow/ice possible", severity: "low" },
  { tag: "monsoon-nov-jan", months: [11, 12, 1], summary: "Monsoon season (Nov\u2013Jan) \u2014 heavy rain likely", severity: "moderate" },
];

function tripMonths(prefs: NormalizedPreferences): number[] | null {
  if (!prefs.departDate || !prefs.returnDate) return null;
  const start = new Date(`${prefs.departDate}T00:00:00Z`);
  const end = new Date(`${prefs.returnDate}T00:00:00Z`);
  const months = new Set<number>();
  const cursor = new Date(start);
  while (cursor <= end && months.size <= 12) {
    months.add(cursor.getUTCMonth() + 1);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return [...months];
}

export function seasonalRisks(
  dest: Destination,
  prefs: NormalizedPreferences,
  observedAt: string,
): { risks: RiskItem[]; unknownNote: string | null } {
  const months = tripMonths(prefs);
  if (!months) {
    return { risks: [], unknownNote: "Seasonal context not evaluated (no trip dates)" };
  }
  const risks: RiskItem[] = [];
  for (const rule of SEASON_RULES) {
    if (dest.seasonalityTags.includes(rule.tag) && rule.months.some((m) => months.includes(m))) {
      risks.push({
        type: "SEASONAL",
        severity: rule.severity,
        status: "CAUTION",
        appliesTo: { destination: dest.id, season: rule.tag },
        summary: rule.summary,
        sourceUrl: "https://travel.state.gov/",
        observedAt,
        effectiveAt: null,
        expiresAt: null,
      });
    }
  }
  return { risks, unknownNote: null };
}

/* ------------------------------------------------------------------ */
/* Main job processing                                                 */
/* ------------------------------------------------------------------ */

interface ScoredCandidate {
  dest: Destination;
  evidence: Evidence[];
  breakdown: ReturnType<typeof computeScore>;
  risks: RiskItem[];
  unknowns: string[];
  filterReasons: string[];
}

function fareOf(evidence: Evidence[]): { amount: number | null; stops: number; durationHours: number } {
  const fare = evidence.find((e) => e.kind === "fare");
  const d = fare?.details ?? {};
  return {
    amount: typeof d["amount"] === "number" ? (d["amount"] as number) : null,
    stops: typeof d["stops"] === "number" ? (d["stops"] as number) : 1,
    durationHours: typeof d["durationHours"] === "number" ? (d["durationHours"] as number) : 8,
  };
}

function weatherOf(evidence: Evidence[]): { daysInBand: number; totalDays: number } {
  const w = evidence.find((e) => e.kind === "weather");
  const d = w?.details ?? {};
  return {
    daysInBand: typeof d["daysInBand"] === "number" ? (d["daysInBand"] as number) : 0,
    totalDays: typeof d["totalDays"] === "number" ? (d["totalDays"] as number) : 0,
  };
}

function advisorySeverityOf(evidence: Evidence[]): "low" | "moderate" | "high" | "critical" | "unknown" {
  const adv = evidence.find((e) => e.kind === "advisory");
  const level = adv?.details["level"];
  if (level === 1) return "low";
  if (level === 2) return "moderate";
  if (level === 3) return "high";
  if (level === 4) return "critical";
  return "unknown";
}

async function recentDestinationIds(sub: string): Promise<Set<string>> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: GSI1,
      KeyConditionExpression: "gsi1pk = :p AND begins_with(gsi1sk, :s)",
      ExpressionAttributeValues: { ":p": gsi1pkUser(sub), ":s": "FEED#" },
      ScanIndexForward: false,
      Limit: 3,
      ProjectionExpression: "cards",
    }),
  );
  const seen = new Set<string>();
  for (const item of res.Items ?? []) {
    for (const c of ((item as { cards?: { destinationId: string }[] }).cards ?? [])) {
      seen.add(c.destinationId);
    }
  }
  return seen;
}

/**
 * One-active-job-per-user guard (the API also checks at creation).
 * GSI2 is KEYS_ONLY-projected, so ownership is filtered in code.
 * On violation the job is reverted to PENDING and re-queued with a delay;
 * that re-queue needs FEED_QUEUE_URL + sqs:SendMessage on the worker role
 * (flagged to the coordinator) — without it the job waits for a new trigger.
 */
async function otherRunningJobExists(owner: string, jobId: string): Promise<boolean> {
  const pks = new Set<string>();
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: GSI2,
      KeyConditionExpression: "gsi2pk = :p",
      ExpressionAttributeValues: { ":p": gsi2pkJobState("RUNNING") },
      ProjectionExpression: "pk",
    }),
  );
  for (const item of res.Items ?? []) pks.add((item as { pk: string }).pk);
  for (const pk of pks) {
    if (pk === pkJob(jobId)) continue;
    const r = await ddb.send(
      new GetCommand({ TableName: TABLE_NAME, Key: { pk, sk: skJobMeta() } }),
    );
    const j = r.Item as { owner?: string; state?: string } | undefined;
    if (j?.owner === owner && j.state === "RUNNING") return true;
  }
  return false;
}

async function guardOneActiveJob(job: FeedJob): Promise<boolean> {
  if (!(await otherRunningJobExists(job.owner, job.jobId))) return false;
  const retryAt = new Date(Date.now() + 120_000).toISOString();
  await setJobState(job.jobId, "PENDING", { progress: 0, nextAttemptAt: retryAt }, null);
  if (FEED_QUEUE_URL) {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: FEED_QUEUE_URL,
        MessageBody: JSON.stringify({ jobId: job.jobId }),
        DelaySeconds: 120,
      }),
    );
  } else {
    console.warn(
      JSON.stringify({
        msg: "one-active-job guard fired but FEED_QUEUE_URL is unset; job left PENDING",
        jobId: job.jobId,
      }),
    );
  }
  return true;
}

async function processJob(jobId: string): Promise<void> {
  const metaRes = await ddb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { pk: pkJob(jobId), sk: skJobMeta() } }),
  );
  const job = metaRes.Item as unknown as FeedJob | undefined;
  if (!job) {
    console.warn(JSON.stringify({ msg: "job not found", jobId }));
    return;
  }
  if (job.state !== "PENDING") return; // already handled (idempotent)

  // One-active-job-per-user guard (secondary; the API also checks at creation).
  if (await guardOneActiveJob(job)) return;

  const fail = async (errorClass: ErrorClass, message: string): Promise<void> => {
    await setJobState(jobId, "FAILED", {
      progress: 100,
      error: { class: errorClass, message },
    });
  };

  try {
    // PENDING -> RUNNING (conditional; attempts+1).
    await setJobState(
      jobId,
      "RUNNING",
      { progress: 5, attempts: job.attempts + 1 },
      "PENDING",
    );
  } catch (err) {
    if ((err as { name?: string }).name === "ConditionalCheckFailedException") return;
    throw err;
  }

  try {
    // Step 1: load normalized preferences.
    const prefRes = await ddb.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: pkUser(job.owner), sk: skPref() },
      }),
    );
    const prefs = (prefRes.Item as { normalized?: NormalizedPreferences } | undefined)?.normalized;
    if (!prefs) {
      await fail("INVALID_PREFERENCES", "No active preferences saved for this user");
      return;
    }

    // Step 2: reuse a fresh shared snapshot when available.
    const sharedKey = sharedSnapshotKey(prefs);
    const sharedHit = await ddb.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: pkCache(sharedKey), sk: skCacheResult("snapshot") },
      }),
    );
    const shared = sharedHit.Item as
      | { cards: FeedCard[]; jobId: string; observedAt: string; ttl: number }
      | undefined;
    const nowSec = Math.floor(Date.now() / 1000);
    if (shared && shared.ttl > nowSec && Array.isArray(shared.cards) && shared.cards.length > 0) {
      const snapshot = await writeSnapshot(job, prefs, shared.cards, shared.jobId, "READY", []);
      await setJobState(jobId, "READY", { progress: 100, snapshotId: snapshot.snapshotId });
      return;
    }

    // Step 3: bounded candidate set.
    const candidates = reduceCandidates(prefs);
    await setJobState(jobId, "RUNNING", { progress: 10 });

    // Step 4: parallel enrichment with budgets.
    const enriched = await Promise.all(
      candidates.map((dest) => enrichDestination(dest, prefs)),
    );
    const anyProviderFailed = enriched.some((e) => e.providerFailures.length > 0);
    await setJobState(jobId, "RUNNING", { progress: 60 });

    // Step 5: hard-filter + deterministic score.
    const seen = await recentDestinationIds(job.owner);
    const nowMs = Date.now();
    const observedAt = nowIso(nowMs);
    const scored: ScoredCandidate[] = [];
    let insufficient = false;
    for (let i = 0; i < candidates.length; i++) {
      const dest = candidates[i]!;
      const { evidence, providerFailures } = enriched[i]!;
      if (providerFailures.length > 0) insufficient = true;

      const fare = fareOf(evidence);
      const weather = weatherOf(evidence);
      const entryEv = evidence.find((e) => e.kind === "entry");
      const entryReq = entryEv?.details["requirement"];
      const risks: RiskItem[] = risksFromEvidence(evidence, prefs, dest.id);
      const { risks: seasonRisks, unknownNote } = seasonalRisks(dest, prefs, observedAt);
      risks.push(...seasonRisks);
      const unknowns = evidence.flatMap((e) => e.provenance.unknowns);
      if (unknownNote && !unknowns.includes(unknownNote)) unknowns.push(unknownNote);
      // Booking-confidence risk: illustrative fares are never live.
      if (!evidence.some((e) => e.kind === "fare" && e.live)) {
        risks.push({
          type: "BOOKING_CONFIDENCE",
          severity: "moderate",
          status: "CAUTION",
          appliesTo: { destination: dest.id },
          summary: "Fare is illustrative, not a live bookable price",
          sourceUrl: "https://duffel.com/",
          observedAt,
          effectiveAt: null,
          expiresAt: null,
        });
      }
      if (providerFailures.length > 0) {
        unknowns.push(`Provider gaps for this destination: ${providerFailures.join(", ")}`);
      }

      const filter = hardFilter({
        fareAmount: fare.amount,
        ceiling: prefs.airfareMaxPerPerson,
        daysInBand: weather.daysInBand,
        totalDays: weather.totalDays,
        tempHard: prefs.tempHard,
        advisorySeverity: advisorySeverityOf(evidence),
        advisoryThreshold: prefs.advisoryMaxSeverity,
        entryStatus: entryReq === undefined || entryReq === "unknown" ? "UNRESOLVED" : "OK",
        entryKnown: entryReq !== undefined && entryReq !== "unknown",
      });
      if (!filter.pass) continue;

      const eventsEv = evidence.find((e) => e.kind === "event");
      const events = eventsEv?.details["events"];
      const eventList = Array.isArray(events) ? (events as { classification: string | null }[]) : [];
      const matchingEvents = eventList.filter((e) =>
        prefs.interests.some((t) =>
          (e.classification ?? "").toLowerCase().includes(t.split(" ")[0] ?? ""),
        ),
      ).length;
      const matchedTags = dest.interestTags.filter((t) => prefs.interests.includes(t)).length;

      const breakdown = computeScore({
        fareAmount: fare.amount ?? prefs.airfareMaxPerPerson,
        ceiling: prefs.airfareMaxPerPerson,
        daysInBand: weather.daysInBand,
        totalDays: weather.totalDays,
        interestScore: interestFit(matchedTags, prefs.interests.length, matchingEvents),
        stops: fare.stops,
        durationHours: fare.durationHours,
        evidenceAges: evidence.map((e) => ({
          ageSec: Math.max(0, (nowMs - Date.parse(e.provenance.observedAt)) / 1000),
          ttlSec: Math.max(
            1,
            (Date.parse(e.provenance.expiresAt) - Date.parse(e.provenance.observedAt)) / 1000,
          ),
        })),
        novelty: noveltyFit(seen.has(dest.id)),
        risks,
      });
      scored.push({ dest, evidence, breakdown, risks, unknowns, filterReasons: [] });
    }
    scored.sort((a, b) => b.breakdown.total - a.breakdown.total);

    if (scored.length === 0) {
      await fail("INSUFFICIENT_EVIDENCE", "No destinations passed the hard-constraint filter with sufficient evidence");
      return;
    }
    await setJobState(jobId, "RUNNING", { progress: 80 });

    // Step 6: narrate the top <= 5 (deterministic templates unless an LLM
    // provider is configured AND passes the egress + contract gates).
    const top = scored.slice(0, MAX_NARRATED);
    const llmInput: LlmNarrateInput = {
      preferences: {
        origin: prefs.originAirports.join("/"),
        tempF: { min: prefs.tempMinF, max: prefs.tempMaxF },
        airfareMaxPerPerson: prefs.airfareMaxPerPerson,
        partySize: prefs.partySize,
        interests: prefs.interests,
      },
      candidates: top.map((s) => ({
        destinationId: s.dest.id,
        name: s.dest.name,
        hardConstraintPass: true,
        score: s.breakdown.total,
        scoreBreakdown: s.breakdown,
        evidenceRefs: s.evidence.map((e) => e.id),
        unknowns: s.unknowns,
        cautions: s.risks
          .filter((r) => r.status !== "OK" || r.severity !== "low")
          .map((r) => r.summary),
      })),
      instructions: { maxItems: 5, citeEvidenceRefs: true, noNewFacts: true },
    };
    const evidenceByDest = new Map<string, Evidence[]>(
      top.map((s) => [s.dest.id, s.evidence]),
    );
    const narration = await narrate(llmInput, evidenceByDest);
    const narrationById = new Map(narration.narrations.map((n) => [n.destinationId, n]));

    const cards: FeedCard[] = top.map((s) => {
      const n = narrationById.get(s.dest.id);
      const cautions =
        n && n.cautions.length > 0
          ? n.cautions
          : s.risks.filter((r) => r.status !== "OK").map((r) => r.summary);
      return {
        destinationId: s.dest.id,
        name: s.dest.name,
        country: s.dest.country,
        interestTags: s.dest.interestTags,
        score: s.breakdown.total,
        scoreBreakdown: s.breakdown,
        reasons: n?.reasons ?? [
          `${s.dest.name} scores ${s.breakdown.total}/100 from deterministic scoring.`,
          cautions[0] ?? "Verify entry requirements before booking.",
        ],
        evidenceRefs: n?.evidenceRefs ?? s.evidence.map((e) => e.id),
        cautions: cautions.slice(0, 5),
        risks: s.risks,
        hardConstraintPass: true,
        unknowns: s.unknowns.slice(0, 8),
      };
    });

    // Step 7: immutable snapshot + evidence rows + caches.
    const state: FeedJob["state"] = anyProviderFailed || insufficient ? "PARTIAL" : "READY";

    // EVIDENCE# rows (30d TTL) for every enriched candidate that passed.
    await Promise.all(
      scored.flatMap((s) =>
        s.evidence.map((ev) =>
          ddb.send(
            new PutCommand({
              TableName: TABLE_NAME,
              Item: {
                pk: pkJob(jobId),
                sk: skEvidence(s.dest.id, ev.id),
                jobId,
                destinationId: s.dest.id,
                evidenceId: ev.id,
                ...JSON.parse(JSON.stringify(ev)),
                ttl: ttlEpochSeconds(30),
              },
            }),
          ),
        ),
      ),
    );

    const snapshot = await writeSnapshot(
      job,
      prefs,
      cards,
      jobId,
      state,
      Array.from(
        new Set(enriched.flatMap((e) => e.providerFailures)),
      ).map((provider) => ({
        provider,
        message: `${provider} was unavailable during this run; results continue without it.`,
      })),
    );

    // Shared-snapshot cache (6h) for preference-identical reuse.
    const evidenceByDestAll: Record<string, Evidence[]> = {};
    for (const s of scored) evidenceByDestAll[s.dest.id] = s.evidence;
    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          pk: pkCache(sharedKey),
          sk: skCacheResult("snapshot"),
          cards,
          evidenceByDest: evidenceByDestAll,
          jobId,
          observedAt,
          ttl: ttlFromMs(SHARED_SNAPSHOT_TTL_MS, nowMs),
        },
      }),
    );

    await setJobState(jobId, state, { progress: 100, snapshotId: snapshot.snapshotId });
  } catch (err) {
    console.error(JSON.stringify({ msg: "job failed", jobId, err: String(err) }));
    const message = err instanceof ApiError ? err.message : "Feed generation failed";
    const errorClass: ErrorClass = err instanceof ApiError ? err.errorClass : "PROVIDER_UNAVAILABLE";
    await fail(errorClass, message);
  }
}

/** Write the immutable FEED# snapshot row + FEEDID# lookup link. */
async function writeSnapshot(
  job: FeedJob,
  prefs: NormalizedPreferences,
  cards: FeedCard[],
  evidenceJobId: string,
  state: "READY" | "PARTIAL",
  partialFailures: { provider: string; message: string }[],
): Promise<FeedSnapshot> {
  const createdAt = nowIso();
  const snapshot: FeedSnapshot = {
    snapshotId: randomUUID(),
    owner: job.owner,
    jobId: job.jobId,
    evidenceJobId,
    createdAt,
    state,
    preferencesHash: prefs.preferencesHash,
    scoreVersion: SCORE_VERSION,
    catalogVersion: CATALOG_VERSION,
    cards,
    partialFailures: partialFailures.length > 0 ? partialFailures : undefined,
    visibility: "private",
  };
  await ddb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        pk: pkUser(job.owner),
        sk: skFeed(createdAt),
        gsi1pk: gsi1pkUser(job.owner),
        gsi1sk: gsi1skFeed(createdAt),
        ttl: ttlEpochSeconds(90),
        ...JSON.parse(JSON.stringify(snapshot)),
      },
      ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
    }),
  );
  await ddb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        pk: pkUser(job.owner),
        sk: skFeedId(snapshot.snapshotId),
        snapshotId: snapshot.snapshotId,
        createdAt,
        ttl: ttlEpochSeconds(90),
      },
    }),
  );
  return snapshot;
}

/* ------------------------------------------------------------------ */
/* SQS entrypoint (batchSize 1)                                        */
/* ------------------------------------------------------------------ */

export async function handler(event: SQSEvent): Promise<{ batchItemFailures: { itemIdentifier: string }[] }> {
  const failures: { itemIdentifier: string }[] = [];
  for (const record of event.Records ?? []) {
    try {
      const body = JSON.parse(record.body) as { jobId?: string };
      if (!body.jobId || typeof body.jobId !== "string") {
        throw new ApiError("INVALID_PREFERENCES", "SQS message missing jobId");
      }
      // Validate the jobId shape to avoid key injection.
      if (!/^[0-9a-fA-F-]{1,64}$/.test(body.jobId)) {
        throw new ApiError("INVALID_PREFERENCES", "Invalid jobId");
      }
      await processJob(body.jobId);
    } catch (err) {
      console.error(JSON.stringify({ msg: "record failed", messageId: record.messageId, err: String(err) }));
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
}

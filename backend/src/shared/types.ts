/**
 * Domain types for the TravelBook backend.
 * Mirrors the architecture plan (single DynamoDB table, evidence pipeline,
 * deterministic scoring, risk engine, social/trip entities).
 */

export type FeedJobState = "PENDING" | "RUNNING" | "READY" | "PARTIAL" | "FAILED";

export type ErrorClass =
  | "INVALID_PREFERENCES"
  | "PROVIDER_UNAVAILABLE"
  | "INSUFFICIENT_EVIDENCE"
  | "BUDGET_EXHAUSTED"
  | "POLICY_BLOCKED";

export type Severity = "low" | "moderate" | "high" | "critical" | "unknown";

export type RiskType =
  | "ENTRY_RULE"
  | "ADVISORY"
  | "HAZARD"
  | "SEASONAL"
  | "BOOKING_CONFIDENCE";

export type RiskStatus = "OK" | "CAUTION" | "UNRESOLVED" | "BLOCKED";

export type Confidence = "high" | "medium" | "low";

export type EvidenceKind = "fare" | "weather" | "event" | "advisory" | "entry";

/** Raw traveler input for PUT /v1/preferences. */
export interface PreferencesInput {
  origin: string;
  departDate?: string;
  returnDate?: string;
  dateFlexDays?: number;
  tempMin?: number;
  tempMax?: number;
  tempUnit?: "F" | "C";
  /** True = temperature band is a hard constraint (fail candidates outside it). */
  tempHard?: boolean;
  airfareMaxPerPerson?: number;
  currency?: string;
  partySize?: number;
  interests?: string[];
  /** Reject destinations whose advisory severity exceeds this. Default "high". */
  advisoryMaxSeverity?: Severity;
  /** Opt-in only. Never stored unless the traveler provides it. */
  passportCountry?: string;
  cabin?: "economy" | "premium" | "business";
}

/** Validated, normalized preferences stored at USER#<uid> / PREF#ACTIVE. */
export interface NormalizedPreferences {
  version: 1;
  originAirports: string[];
  originLabel: string;
  originLat: number;
  originLon: number;
  departDate: string | null;
  returnDate: string | null;
  dateFlexDays: number;
  tripDays: number | null;
  tempMinF: number;
  tempMaxF: number;
  tempHard: boolean;
  airfareMaxPerPerson: number;
  currency: "USD";
  partySize: number;
  /** Normalized interest-taxonomy ids. */
  interests: string[];
  interestWarnings: string[];
  advisoryMaxSeverity: Severity;
  passportCountry: string | null;
  cabin: "economy" | "premium" | "business";
  warnings: string[];
  /** sha256 (16 hex) of the canonical normalized bundle; keys shared-snapshot reuse. */
  preferencesHash: string;
}

export interface Destination {
  id: string;
  name: string;
  country: string;
  countryCode: string;
  airports: string[];
  lat: number;
  lon: number;
  seasonalityTags: string[];
  interestTags: string[];
  timezone?: string;
}

/** Provenance envelope attached to every piece of evidence. */
export interface Provenance {
  provider: string;
  sourceUrl: string;
  observedAt: string;
  expiresAt: string;
  /** sha256 (16 hex) of the canonical query — never a secret. */
  queryFingerprint: string;
  currency: string;
  timezone: string;
  units: string;
  confidence: Confidence;
  unknowns: string[];
  /** sha256 (16 hex) of the normalized evidence payload. */
  checksum: string;
}

export interface Evidence {
  /** e.g. "fare:duffel", "weather:open-meteo". Also used as an evidenceRef. */
  id: string;
  kind: EvidenceKind;
  destinationId: string;
  summary: string;
  details: Record<string, unknown>;
  provenance: Provenance;
  /** False for illustrative/mock data (e.g. Duffel fares before production access). */
  live: boolean;
}

export interface RiskItem {
  type: RiskType;
  severity: Severity;
  status: RiskStatus;
  appliesTo: Record<string, string>;
  summary: string;
  sourceUrl: string;
  observedAt: string;
  effectiveAt: string | null;
  expiresAt: string | null;
}

export interface ScoreBreakdown {
  airfare: number;
  weather: number;
  interest: number;
  travelTime: number;
  freshness: number;
  novelty: number;
  riskPenalty: number;
  total: number;
}

/**
 * Hero image attribution for a feed card. Supplied by Pexels at
 * feed-generation time; stored on the card so snapshots stay immutable.
 * Illustration only — never part of scoring or evidence.
 */
export interface HeroImage {
  /** Direct CDN URL of a landscape rendition (images.pexels.com). */
  url: string;
  photographer: string;
  photographerUrl: string;
  /** Pexels photo page (credit-link target). */
  pageUrl: string;
}

/** One ranked destination in a feed snapshot: an evidence packet, not a postcard. */
export interface FeedCard {
  destinationId: string;
  name: string;
  country: string;
  /** Destination interest tags (for per-traveler re-scoring in trip recommendations). */
  interestTags: string[];
  /**
   * Optional hero photo (Pexels). ILLUSTRATION ONLY — never evidence, never
   * scored, never cited. Null when no Pexels key is configured or the
   * lookup failed; the card must render identically either way.
   */
  heroImage: HeroImage | null;
  score: number;
  scoreBreakdown: ScoreBreakdown;
  /** Exactly two plain-language sentences tied to score components. */
  reasons: [string, string];
  /** Evidence ids this card cites (each resolves to a stored evidence row). */
  evidenceRefs: string[];
  /** User-facing caution strings (severity preserved, never downgraded). */
  cautions: string[];
  risks: RiskItem[];
  hardConstraintPass: boolean;
  unknowns: string[];
}

/** Immutable feed snapshot stored at USER#<uid> / FEED#<createdAt>. */
export interface FeedSnapshot {
  snapshotId: string;
  owner: string;
  /** Job that produced the snapshot. */
  jobId: string;
  /** Job that owns the EVIDENCE# rows (differs from jobId on the snapshot-reuse path). */
  evidenceJobId: string;
  createdAt: string;
  state: "READY" | "PARTIAL";
  preferencesHash: string;
  scoreVersion: string;
  catalogVersion: string;
  cards: FeedCard[];
  /** Provider-level gaps for PARTIAL snapshots: [{provider, message}]. */
  partialFailures?: { provider: string; message: string }[];
  /** "private" until the owner explicitly shares with friends. */
  visibility?: "private" | "friends";
  sharedAt?: string;
}

/** Async feed-generation job stored at JOB#<jobId> / META. */
export interface FeedJob {
  jobId: string;
  owner: string;
  state: FeedJobState;
  /** 0-100 for polling UX. */
  progress: number;
  attempts: number;
  snapshotId?: string;
  error?: { class: ErrorClass; message: string };
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
  nextAttemptAt?: string;
}

export type ReactionKind = "like" | "save" | "hide";
export type ReactionTargetType = "feed-item" | "destination";

export interface Reaction {
  targetType: ReactionTargetType;
  targetId: string;
  kind: ReactionKind;
  owner: string;
  createdAt: string;
  updatedAt: string;
}

export interface Trip {
  tripId: string;
  owner: string;
  name: string | null;
  visibility: "private";
  status: "planning";
  departDate: string | null;
  returnDate: string | null;
  createdAt: string;
  /** Deterministic Borda-count aggregate of member ballots. */
  voteAggregate?: {
    borda: Record<string, number>;
    ballots: number;
    updatedAt: string;
  };
}

export interface TripMember {
  userId: string;
  role: "owner" | "member";
  joinedAt: string;
}

export interface Vote {
  destinationId: string;
  userId: string;
  ranking: string[];
  updatedAt: string;
}

export interface FriendRequest {
  fromUserId: string;
  toUserId: string;
  status: "pending";
  createdAt: string;
}

export interface FriendEdge {
  userId: string;
  friendId: string;
  since: string;
}

/** Structured model input contract (plan: model narrates, never invents). */
export interface LlmNarrateInput {
  preferences: {
    origin: string;
    tempF: { min: number; max: number };
    airfareMaxPerPerson: number;
    partySize: number;
    interests: string[];
  };
  candidates: {
    destinationId: string;
    name: string;
    hardConstraintPass: boolean;
    score: number;
    scoreBreakdown: ScoreBreakdown;
    evidenceRefs: string[];
    unknowns: string[];
    cautions: string[];
  }[];
  instructions: {
    maxItems: 5;
    citeEvidenceRefs: true;
    noNewFacts: true;
  };
}

export interface LlmNarration {
  destinationId: string;
  reasons: [string, string];
  evidenceRefs: string[];
  cautions: string[];
}

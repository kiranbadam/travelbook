/**
 * TravelBook API contract types.
 *
 * Mirrors the backend contract from the architecture plan:
 * same-origin REST at /api/v1/..., async feed jobs (POST + poll),
 * immutable feed snapshots, deterministic score components, per-fact
 * provenance, and first-class risk objects.
 *
 * NOTE (integration): endpoints marked [assumed] below are client-side
 * conveniences not named explicitly in the backend contract; the sibling
 * backend engineer may rename them — reconcile at integration.
 */

/* ---------------------------------- config --------------------------------- */

export interface AppConfig {
  region: string;
  userPoolId: string;
  userPoolClientId: string;
}

/* -------------------------------- preferences ------------------------------ */

export type DateMode = 'fixed' | 'flexible';

export interface PreferencesInput {
  origin: string;
  dateMode: DateMode;
  /** ISO date (YYYY-MM-DD); required when dateMode === 'fixed'. */
  startDate?: string;
  /** ISO date (YYYY-MM-DD); required when dateMode === 'fixed'. */
  endDate?: string;
  /** YYYY-MM; required when dateMode === 'flexible'. */
  flexibleMonth?: string;
  tempF: { min: number; max: number };
  airfareMaxPerPerson: number;
  partySize: number;
  interests: string[];
}

export interface NormalizedPreferences extends PreferencesInput {
  /** Resolved airport set for the origin (e.g. ["SEA"]). */
  airports: string[];
  /** Stable hash of the normalized bundle (used for snapshot reuse). */
  bundleHash: string;
  version: number;
}

export interface PutPreferencesResponse {
  preferences: NormalizedPreferences;
  warnings: string[];
  version: number;
}

/* -------------------------------- feed jobs -------------------------------- */

export type FeedJobStatus = 'PENDING' | 'RUNNING' | 'READY' | 'PARTIAL' | 'FAILED';

export interface FeedJobProgress {
  completedSteps: number;
  totalSteps: number;
  currentStage: string;
}

export interface ApiError {
  /** One of INVALID_PREFERENCES | PROVIDER_UNAVAILABLE | INSUFFICIENT_EVIDENCE
   *  | BUDGET_EXHAUSTED | POLICY_BLOCKED */
  class: string;
  message: string;
}

export interface CreateFeedJobResponse {
  jobId: string;
  status: FeedJobStatus;
}

export interface GetFeedJobResponse {
  jobId: string;
  status: FeedJobStatus;
  progress: FeedJobProgress;
  snapshotId?: string;
  error?: ApiError;
}

/* ------------------------------ provenance --------------------------------- */

export interface SourceRef {
  /** Adapter/provider name, e.g. "Duffel", "Open-Meteo", "Ticketmaster". */
  provider: string;
  /** Short human label for what this source supplied, e.g. "round-trip fare". */
  label: string;
  /** ISO timestamp of when the fact was observed. */
  checkedAt: string;
  /** Optional ISO expiry of the underlying offer/forecast. */
  expiresAt?: string;
  /** Canonical source URL when available. */
  url?: string;
  /** True when the value is served from the stale-if-error window. */
  stale?: boolean;
}

/* ---------------------------------- risk ----------------------------------- */

export type RiskSeverity = 'LOW' | 'MODERATE' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';

export interface RiskItem {
  type: 'ENTRY_RULE' | 'ADVISORY' | 'HAZARD' | 'SEASONAL' | 'BOOKING_CONFIDENCE' | string;
  severity: RiskSeverity;
  /** Short user-facing summary; UNKNOWN entry rules say "Verify before booking". */
  summary: string;
  detail?: string;
  sourceUrl?: string;
  observedAt?: string;
}

/* -------------------------------- feed cards ------------------------------- */

export type FareKind = 'LIVE' | 'ILLUSTRATIVE';

export interface FareInfo {
  amount: number;
  currency: string;
  /** Total for the whole party, if the backend computed it. */
  totalForParty?: number;
  kind: FareKind;
  source: SourceRef;
}

export interface WeatherInfo {
  /** e.g. "24 of 30 trip days within 70–90°F". */
  windowSummary: string;
  daysInBand: number;
  totalDays: number;
  source: SourceRef;
}

export interface EventInfo {
  name: string;
  date?: string;
  venue?: string;
  url?: string;
  source: SourceRef;
}

export interface ScoreComponents {
  airfare: number;
  weather: number;
  interest: number;
  travelTime: number;
  freshness: number;
  novelty: number;
}

export const SCORE_WEIGHTS: Record<keyof ScoreComponents, number> = {
  airfare: 30,
  weather: 25,
  interest: 20,
  travelTime: 10,
  freshness: 10,
  novelty: 5,
};

export const SCORE_LABELS: Record<keyof ScoreComponents, string> = {
  airfare: 'Airfare',
  weather: 'Weather',
  interest: 'Interest',
  travelTime: 'Travel time',
  freshness: 'Freshness',
  novelty: 'Novelty',
};

export interface FeedCard {
  destinationId: string;
  name: string;
  country: string;
  region?: string;
  /** 0–100 deterministic score. */
  score: number;
  components: ScoreComponents;
  /** Points subtracted for risk; shown so the penalty is explainable. */
  riskPenalty?: number;
  /** "Why it matches" — two plain-language reasons tied to score components. */
  reasons: string[];
  /** Additive model prose; NEVER the only explanation (explainability rule). */
  narration?: string;
  fare?: FareInfo;
  weather?: WeatherInfo;
  events?: EventInfo[];
  /** "What could change" — expiry, advisories, uncertainties. */
  uncertainties: string[];
  risks: RiskItem[];
  /** Every displayed fact carries one of these. */
  sources: SourceRef[];
  reaction?: 'like' | 'save' | null;
  /** Feeds are private until explicitly shared. */
  shared?: boolean;
}

export interface PartialFailure {
  provider: string;
  message: string;
}

export type FeedState = 'READY' | 'PARTIAL';

export interface FeedSnapshot {
  snapshotId: string;
  createdAt: string;
  state: FeedState;
  cards: FeedCard[];
  partialFailures?: PartialFailure[];
  visibility?: 'private' | 'friends';
}

/* -------------------------------- reactions -------------------------------- */

export type ReactionKind = 'like' | 'save' | 'hide';

export interface PostReactionRequest {
  destinationId: string;
  kind: ReactionKind;
  snapshotId?: string;
}

/* ---------------------------------- trips ---------------------------------- */

export interface Trip {
  tripId: string;
  name: string;
  startDate?: string;
  endDate?: string;
  ownerSub: string;
  createdAt: string;
}

export interface TripMember {
  userSub: string;
  displayName?: string;
  role: 'owner' | 'member';
  joinedAt: string;
}

export interface TripDetail extends Trip {
  members: TripMember[];
  /** destinationIds the current user ranked, best-first. */
  myRanking: string[];
  candidateIds: string[];
}

export interface GroupRecommendations {
  bestOverall?: string;
  bestBudget?: string;
  bestWeather?: string;
  bestSharedInterest?: string;
  /** Per-member utility, keyed by user sub — who benefits, who compromises. */
  memberScores?: Record<string, Record<string, number>>;
  note?: string;
}

/* ---------------------------------- friends -------------------------------- */

export interface Friend {
  userSub: string;
  displayName?: string;
  email?: string;
  friendsSince: string;
}

export interface FriendRequest {
  requestId: string;
  fromSub: string;
  fromEmail?: string;
  toSub: string;
  createdAt: string;
}

export interface FriendFeed {
  friend: Friend;
  sharedAt: string;
  cards: FeedCard[];
}

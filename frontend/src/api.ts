import type {
  ApiError,
  CreateFeedJobResponse,
  FeedCard,
  FeedJobStatus,
  FeedSnapshot,
  Friend,
  FriendFeed,
  FriendRequest,
  GetFeedJobResponse,
  GroupRecommendations,
  HeroImage,
  NormalizedPreferences,
  PostReactionRequest,
  PreferencesInput,
  PutPreferencesResponse,
  RiskItem,
  Trip,
  TripDetail,
} from './types';

/**
 * Typed client for the TravelBook API. All paths are relative (/api/v1/...)
 * so CloudFront proxies them same-origin to the HTTP API — no CORS needed.
 *
 * The Cognito ID token is attached as `Authorization: Bearer <idToken>` on
 * every call; the API's JWT authorizer derives identity from the token
 * subject (clients never send owner IDs).
 *
 * Endpoints marked [assumed] are client-side conveniences not named
 * explicitly in the architecture contract — reconcile names with the
 * backend engineer at integration.
 */

const BASE = '/api/v1';

/* ------------------------------------------------------------------ */
/* Feed-card wire adapter                                              */
/*                                                                     */
/* The worker emits a flatter card shape than the renderers expect      */
/* (scoreBreakdown instead of components, unknowns instead of          */
/* uncertainties, evidenceRefs instead of sources). Normalize here so   */
/* screens never touch undefined — a missing array used to crash the   */
/* whole feed (TypeError on `.length`).                                 */
/* ------------------------------------------------------------------ */

/** Backend wire shape for a feed card (see backend/src/worker/index.ts). */
interface WireFeedCard {
  destinationId?: unknown;
  name?: unknown;
  country?: unknown;
  region?: unknown;
  heroImage?: unknown;
  score?: unknown;
  scoreBreakdown?: Record<string, unknown>;
  riskPenalty?: unknown;
  reasons?: unknown;
  unknowns?: unknown;
  cautions?: unknown;
  risks?: unknown;
  evidenceRefs?: unknown;
  narration?: unknown;
  reaction?: unknown;
}

const WIRE_PROVIDER_LABELS: Record<string, string> = {
  'open-meteo': 'Open-Meteo',
  duffel: 'Duffel',
  ticketmaster: 'Ticketmaster',
  'state-dept': 'U.S. State Dept',
  'visa-matrix': 'Entry-rules matrix',
};

function wireNum(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function wireStrs(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function wireStr(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

/**
 * Normalize the backend's heroImage envelope. The wire shape is
 * { url, photographer, photographerUrl, pageUrl } (see
 * backend/src/shared/types.ts HeroImage). Anything missing or malformed —
 * including heroImage itself — normalizes to null so the renderer falls
 * back to the imageless layout instead of touching undefined.
 */
function wireHeroImage(v: unknown): HeroImage | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const url = typeof o.url === 'string' ? o.url : '';
  const photographer = typeof o.photographer === 'string' ? o.photographer : '';
  if (!url || !photographer) return null;
  return {
    url,
    photographer,
    photographerUrl:
      typeof o.photographerUrl === 'string' && o.photographerUrl
        ? o.photographerUrl
        : 'https://www.pexels.com',
    pageUrl: typeof o.pageUrl === 'string' && o.pageUrl ? o.pageUrl : 'https://www.pexels.com',
  };
}

function adaptFeedCard(wire: WireFeedCard, checkedAt: string): FeedCard {
  const sb = wire.scoreBreakdown ?? {};
  const refs = wireStrs(wire.evidenceRefs);
  return {
    destinationId: wireStr(wire.destinationId),
    name: wireStr(wire.name, 'Unknown destination'),
    country: wireStr(wire.country),
    region: typeof wire.region === 'string' ? wire.region : undefined,
    heroImage: wireHeroImage(wire.heroImage),
    score: wireNum(wire.score),
    components: {
      airfare: wireNum(sb['airfare']),
      weather: wireNum(sb['weather']),
      interest: wireNum(sb['interest']),
      travelTime: wireNum(sb['travelTime']),
      freshness: wireNum(sb['freshness']),
      novelty: wireNum(sb['novelty']),
    },
    riskPenalty: wireNum(sb['riskPenalty'] ?? wire.riskPenalty),
    reasons: wireStrs(wire.reasons),
    narration: typeof wire.narration === 'string' ? wire.narration : undefined,
    uncertainties: [...wireStrs(wire.cautions), ...wireStrs(wire.unknowns)],
    risks: Array.isArray(wire.risks) ? (wire.risks as RiskItem[]) : [],
    sources: refs.map((ref) => {
      const parts = ref.split(':');
      const label = (parts[0] ?? 'evidence').replace(/[-_]/g, ' ');
      const providerRaw = parts.length > 1 ? parts.slice(1).join(':') : ref;
      return {
        provider: WIRE_PROVIDER_LABELS[providerRaw] ?? providerRaw.replace(/[-_]/g, ' '),
        label,
        checkedAt,
      };
    }),
    reaction: wire.reaction === 'like' || wire.reaction === 'save' ? wire.reaction : undefined,
  };
}

export class ApiRequestError extends Error {
  status: number;
  errorClass?: string;

  constructor(status: number, message: string, errorClass?: string) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.errorClass = errorClass;
  }
}

export type TokenProvider = () => string | null;

export class ApiClient {
  private readonly getToken: TokenProvider;

  constructor(getToken: TokenProvider) {
    this.getToken = getToken;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const token = this.getToken();
    const headers: Record<string, string> = {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...extraHeaders,
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (res.status === 204) return undefined as T;

    let payload: unknown = null;
    try {
      payload = await res.json();
    } catch {
      payload = null;
    }

    if (!res.ok) {
      const apiErr = payload as ApiError | null;
      const message =
        (apiErr && typeof apiErr.message === 'string' && apiErr.message) ||
        `Request failed with status ${res.status}.`;
      throw new ApiRequestError(
        res.status,
        res.status === 401 ? 'Your session expired. Please sign in again.' : message,
        apiErr?.class,
      );
    }
    return payload as T;
  }

  /* ------------------------------ preferences ----------------------------- */

  putPreferences(input: PreferencesInput): Promise<PutPreferencesResponse> {
    return this.request<{
      normalized: NormalizedPreferences;
      warnings: string[];
      version: number;
    }>('PUT', '/preferences', input).then((res) => ({
      preferences: res.normalized,
      warnings: res.warnings,
      version: res.version,
    }));
  }

  /* -------------------------------- feed ---------------------------------- */

  /** Creates (or reuses) a feed-generation job. Requires Idempotency-Key. */
  async createFeedJob(): Promise<CreateFeedJobResponse> {
    const res = await this.request<{ jobId: string; state: FeedJobStatus }>(
      'POST',
      '/feed-jobs',
      undefined,
      { 'Idempotency-Key': crypto.randomUUID() },
    );
    return { jobId: res.jobId, status: res.state };
  }

  async getFeedJob(jobId: string): Promise<GetFeedJobResponse> {
    const res = await this.request<{
      jobId: string;
      state: FeedJobStatus;
      progress: number;
      snapshotId?: string;
      error?: ApiError;
    }>('GET', `/feed-jobs/${encodeURIComponent(jobId)}`);
    const stage =
      res.state === 'PENDING'
        ? 'Queued'
        : res.state === 'RUNNING'
          ? res.progress < 60
            ? 'Gathering evidence'
            : 'Scoring destinations'
          : res.state;
    return {
      jobId: res.jobId,
      status: res.state,
      progress: { completedSteps: res.progress ?? 0, totalSteps: 100, currentStage: stage },
      snapshotId: res.snapshotId,
      error: res.error,
    };
  }

  async getFeed(snapshotId?: string): Promise<FeedSnapshot | null> {
    const qs = snapshotId ? `?snapshotId=${encodeURIComponent(snapshotId)}` : '';
    const res = await this.request<{
      snapshot: {
        snapshotId: string;
        createdAt: string;
        state: FeedSnapshot['state'];
        partialFailures?: { provider: string; message: string }[];
        visibility?: 'private' | 'friends';
      } | null;
      cards: FeedCard[];
      nextCursor: string | null;
    }>('GET', `/feed${qs}`);
    if (!res.snapshot) return null;
    return {
      snapshotId: res.snapshot.snapshotId,
      createdAt: res.snapshot.createdAt,
      state: res.snapshot.state,
      cards: res.cards.map((c) => adaptFeedCard(c as unknown as WireFeedCard, res.snapshot!.createdAt)),
      partialFailures: res.snapshot.partialFailures,
      visibility: res.snapshot.visibility,
    };
  }

  getDestination(destinationId: string): Promise<{ destination: FeedCard }> {
    return this.request('GET', `/destinations/${encodeURIComponent(destinationId)}`);
  }

  /* -------------------------------- reactions ------------------------------ */

  postReaction(req: PostReactionRequest): Promise<{ ok: true }> {
    return this.request('POST', '/reactions', req);
  }

  /* --------------------------------- trips --------------------------------- */

  createTrip(input: { name: string; startDate?: string; endDate?: string }): Promise<{ trip: Trip }> {
    return this.request('POST', '/trips', input);
  }

  /** [assumed] List trips the caller belongs to. */
  listTrips(): Promise<{ trips: Trip[] }> {
    return this.request('GET', '/trips');
  }

  /** [assumed] Trip detail incl. members and the caller's ranking. */
  getTrip(tripId: string): Promise<{ trip: TripDetail }> {
    return this.request('GET', `/trips/${encodeURIComponent(tripId)}`);
  }

  /** Create or replace the caller's ranked vote (best-first destinationIds). */
  voteTrip(tripId: string, ranking: string[]): Promise<{ ok: true }> {
    return this.request('PUT', `/trips/${encodeURIComponent(tripId)}/votes/me`, { ranking });
  }

  /** [assumed] Add a member to a trip by their Cognito user sub. */
  addTripMember(tripId: string, userSub: string): Promise<{ ok: true }> {
    return this.request('POST', `/trips/${encodeURIComponent(tripId)}/members`, { userSub });
  }

  async getTripRecommendations(tripId: string): Promise<{ recommendations: GroupRecommendations }> {
    const res = await this.request<{
      pareto?: {
        bestOverall?: { destinationId?: string } | null;
        bestBudget?: { destinationId?: string } | null;
        bestWeather?: { destinationId?: string } | null;
        bestSharedInterest?: { destinationId?: string } | null;
      };
      feasible?: {
        destinationId: string;
        utilities?: { userId: string; score: number }[];
      }[];
      method?: string;
    }>('GET', `/trips/${encodeURIComponent(tripId)}/recommendations`);
    const memberScores: Record<string, Record<string, number>> = {};
    for (const f of res.feasible ?? []) {
      for (const u of f.utilities ?? []) {
        (memberScores[u.userId] ??= {})[f.destinationId] = u.score;
      }
    }
    return {
      recommendations: {
        bestOverall: res.pareto?.bestOverall?.destinationId,
        bestBudget: res.pareto?.bestBudget?.destinationId,
        bestWeather: res.pareto?.bestWeather?.destinationId,
        bestSharedInterest: res.pareto?.bestSharedInterest?.destinationId,
        memberScores,
        note: res.method,
      },
    };
  }

  /* --------------------------------- friends -------------------------------- */

  /**
   * Send a friend request. The backend resolves identity from the supplied
   * email; if it expects a user ID instead, pass userId.
   */
  requestFriend(input: { email?: string; userId?: string }): Promise<{ request: FriendRequest }> {
    return this.request('POST', '/friends/requests', input);
  }

  /** [assumed] Incoming pending requests (accepting is mutual). */
  listIncomingRequests(): Promise<{ requests: FriendRequest[] }> {
    return this.request('GET', '/friends/requests/incoming');
  }

  acceptFriend(requestId: string): Promise<{ ok: true }> {
    return this.request('POST', '/friends/accept', { requestId });
  }

  /** [assumed] Accepted friends. */
  listFriends(): Promise<{ friends: Friend[] }> {
    return this.request('GET', '/friends');
  }

  /** [assumed] A friend's explicitly shared feed (private until shared). */
  async getFriendFeed(friendSub: string): Promise<FriendFeed> {
    const res = await this.request<{
      friend: Friend;
      sharedAt: string;
      cards: WireFeedCard[];
    }>('GET', `/friends/${encodeURIComponent(friendSub)}/feed`);
    return {
      friend: res.friend,
      sharedAt: res.sharedAt,
      cards: res.cards.map((c) => adaptFeedCard(c, res.sharedAt)),
    };
  }

  /** [assumed] Share (or unshare) my latest feed snapshot with friends. */
  shareFeed(visibility: 'private' | 'friends'): Promise<{ ok: boolean; visibility: string }> {
    return this.request('POST', '/feed/share', { visibility });
  }
}

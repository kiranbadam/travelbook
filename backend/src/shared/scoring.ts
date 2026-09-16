import type {
  Evidence,
  NormalizedPreferences,
  RiskItem,
  RiskStatus,
  ScoreBreakdown,
  Severity,
} from "./types.js";

/**
 * Deterministic scoring + hard-constraint filter (architecture plan, "Recommendation logic").
 * Pure functions: no I/O, no model calls, fully unit-testable.
 */

export const SCORE_VERSION = "2026-09-16.1";

export const SCORE_WEIGHTS = {
  airfare: 0.3,
  weather: 0.25,
  interest: 0.2,
  travelTime: 0.1,
  freshness: 0.1,
  novelty: 0.05,
} as const;

/** Sanity: weights must sum to 1. */
export function weightsSum(): number {
  return (
    SCORE_WEIGHTS.airfare +
    SCORE_WEIGHTS.weather +
    SCORE_WEIGHTS.interest +
    SCORE_WEIGHTS.travelTime +
    SCORE_WEIGHTS.freshness +
    SCORE_WEIGHTS.novelty
  );
}

const SEVERITY_RANK: Record<Severity, number> = {
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
  unknown: 0,
};

/** Penalty subtracted from the weighted score per risk severity (plan decision matrix). */
const RISK_PENALTY: Record<Severity, number> = {
  low: 0,
  moderate: 5,
  high: 20,
  critical: 60,
  unknown: 8,
};
const MAX_RISK_PENALTY = 60;

export function clamp100(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

/* ------------------------------------------------------------------ */
/* Hard-constraint filter (Pass 1)                                     */
/* ------------------------------------------------------------------ */

export interface FilterInputs {
  /** null = no itinerary found for the requested range. */
  fareAmount: number | null;
  ceiling: number;
  daysInBand: number;
  totalDays: number;
  tempHard: boolean;
  advisorySeverity: Severity;
  advisoryThreshold: Severity;
  /** ENTRY_RULE risk status for this destination. */
  entryStatus: RiskStatus;
  entryKnown: boolean;
}

export interface FilterResult {
  pass: boolean;
  reasons: string[];
}

export function hardFilter(i: FilterInputs): FilterResult {
  const reasons: string[] = [];

  if (i.fareAmount === null) {
    reasons.push("No valid itinerary exists for the requested range.");
  } else if (i.fareAmount > i.ceiling) {
    reasons.push(
      `Round-trip fare $${i.fareAmount} exceeds the per-person ceiling of $${i.ceiling}.`,
    );
  }

  if (i.tempHard && i.totalDays > 0 && i.daysInBand / i.totalDays < 0.5) {
    reasons.push(
      `Forecast falls outside the hard temperature band (${i.daysInBand}/${i.totalDays} days in band).`,
    );
  }

  if (
    i.advisorySeverity !== "unknown" &&
    SEVERITY_RANK[i.advisorySeverity] > SEVERITY_RANK[i.advisoryThreshold]
  ) {
    reasons.push(
      `Travel advisory severity "${i.advisorySeverity}" exceeds the configured threshold "${i.advisoryThreshold}".`,
    );
  }

  if (i.entryStatus === "BLOCKED") {
    reasons.push("A required entry rule is known to be unsatisfied.");
  }

  // NOTE: unknown visa/entry status is deliberately NOT a rejection.
  // It stays a prominent unresolved gate ("Verify before booking").

  return { pass: reasons.length === 0, reasons };
}

/* ------------------------------------------------------------------ */
/* Score components (Pass 2)                                           */
/* ------------------------------------------------------------------ */

/** Headroom below ceiling, capped at 100 (fare <= ceiling guaranteed by filter). */
export function airfareFit(fareAmount: number, ceiling: number): number {
  if (ceiling <= 0) return 0;
  return clamp100(100 * (1 - fareAmount / ceiling));
}

/** Share of trip days within the temperature window. */
export function weatherFit(daysInBand: number, totalDays: number): number {
  if (totalDays <= 0) return 0;
  return clamp100((100 * daysInBand) / totalDays);
}

/**
 * Interest fit: taxonomy overlap (70 pts) + event quality/date overlap (30 pts).
 * Pure and deterministic; event counts come from evidence.
 */
export function interestFit(matchedTags: number, totalInterests: number, matchingEvents: number): number {
  const tagPart = totalInterests > 0 ? (70 * matchedTags) / totalInterests : 50;
  const eventPart = matchingEvents > 0 ? 30 : 0;
  return clamp100(tagPart + eventPart);
}

/** Stops and door-to-door duration. */
export function travelTimeFit(stops: number, durationHours: number): number {
  return clamp100(100 - 20 * stops - 8 * Math.max(0, durationHours - 6));
}

/** Decay by evidence type: mean of (1 - age/ttl) across evidence, floored at 0. */
export function freshnessFit(ages: { ageSec: number; ttlSec: number }[]): number {
  if (ages.length === 0) return 0;
  const parts = ages.map((a) =>
    a.ttlSec <= 0 ? 0 : Math.max(0, 100 * (1 - a.ageSec / a.ttlSec)),
  );
  return clamp100(parts.reduce((s, p) => s + p, 0) / parts.length);
}

/** Diversity against recent feeds. */
export function noveltyFit(seenInRecentFeeds: boolean): number {
  return seenInRecentFeeds ? 40 : 100;
}

export function riskPenalty(risks: RiskItem[]): number {
  const total = risks.reduce((s, r) => s + (RISK_PENALTY[r.severity] ?? 8), 0);
  return Math.min(MAX_RISK_PENALTY, total);
}

export interface ScoreFeatures {
  fareAmount: number;
  ceiling: number;
  daysInBand: number;
  totalDays: number;
  interestScore: number;
  stops: number;
  durationHours: number;
  evidenceAges: { ageSec: number; ttlSec: number }[];
  novelty: number;
  risks: RiskItem[];
}

export function computeScore(f: ScoreFeatures): ScoreBreakdown {
  const airfare = airfareFit(f.fareAmount, f.ceiling);
  const weather = weatherFit(f.daysInBand, f.totalDays);
  const interest = clamp100(f.interestScore);
  const travelTime = travelTimeFit(f.stops, f.durationHours);
  const freshness = freshnessFit(f.evidenceAges);
  const novelty = clamp100(f.novelty);
  const penalty = riskPenalty(f.risks);
  const total = Math.max(
    0,
    Math.round(
      SCORE_WEIGHTS.airfare * airfare +
        SCORE_WEIGHTS.weather * weather +
        SCORE_WEIGHTS.interest * interest +
        SCORE_WEIGHTS.travelTime * travelTime +
        SCORE_WEIGHTS.freshness * freshness +
        SCORE_WEIGHTS.novelty * novelty -
        penalty,
    ),
  );
  return { airfare, weather, interest, travelTime, freshness, novelty, riskPenalty: penalty, total };
}

/* ------------------------------------------------------------------ */
/* Risks derived from evidence (worker builds RiskItems from these)    */
/* ------------------------------------------------------------------ */

function isoNow(): string {
  return new Date().toISOString();
}

/** Convert advisory/entry evidence details into RiskItems. */
export function risksFromEvidence(
  evidence: Evidence[],
  prefs: NormalizedPreferences,
  destinationId: string,
): RiskItem[] {
  const risks: RiskItem[] = [];
  for (const ev of evidence) {
    if (ev.kind === "advisory") {
      const level = ev.details["level"] as number | "unknown" | undefined;
      const base = {
        type: "ADVISORY" as const,
        appliesTo: { destination: destinationId },
        sourceUrl: ev.provenance.sourceUrl,
        observedAt: ev.provenance.observedAt,
        effectiveAt: null,
        expiresAt: ev.provenance.expiresAt,
      };
      if (level === "unknown" || level === undefined) {
        risks.push({
          ...base,
          severity: "unknown",
          status: "UNRESOLVED",
          summary: "Advisory status unknown — verify before booking",
        });
      } else if (level <= 1) {
        risks.push({ ...base, severity: "low", status: "OK", summary: `Advisory level ${level}` });
      } else if (level === 2) {
        risks.push({ ...base, severity: "moderate", status: "CAUTION", summary: `Advisory level 2 — exercise increased caution` });
      } else if (level === 3) {
        risks.push({ ...base, severity: "high", status: "CAUTION", summary: `Advisory level 3 — reconsider travel` });
      } else {
        risks.push({ ...base, severity: "critical", status: "BLOCKED", summary: `Advisory level 4 — do not travel` });
      }
    }
    if (ev.kind === "entry") {
      const requirement = ev.details["requirement"] as string | undefined;
      const destCountry = String(ev.details["destinationCountry"] ?? destinationId);
      const base = {
        type: "ENTRY_RULE" as const,
        appliesTo: {
          passportCountry: prefs.passportCountry ?? "US",
          destination: destCountry,
          purpose: "tourism",
        },
        sourceUrl: ev.provenance.sourceUrl,
        observedAt: ev.provenance.observedAt,
        effectiveAt: (ev.details["effectiveDate"] as string | null) ?? null,
        expiresAt: ev.provenance.expiresAt,
      };
      if (!requirement || requirement === "unknown") {
        // Unresolved gate — never a silent pass.
        risks.push({ ...base, severity: "unknown", status: "UNRESOLVED", summary: "Entry requirements not resolved — verify before booking" });
      } else if (requirement === "visa-required") {
        risks.push({ ...base, severity: "moderate", status: "UNRESOLVED", summary: `Visa required for ${base.appliesTo.passportCountry} passport holders — verify before booking` });
      } else {
        risks.push({ ...base, severity: "low", status: "OK", summary: `Entry: ${requirement}` });
      }
    }
  }
  return risks;
}

/* ------------------------------------------------------------------ */
/* Group fairness (trip recommendations)                               */
/* ------------------------------------------------------------------ */

/**
 * Fairness objective: weighted mean utility minus a penalty on the
 * worst-off traveler's shortfall below the mean (avoids "majority wins"
 * outcomes one traveler strongly dislikes).
 *
 * Deviation from the architecture plan's literal expression
 * ("mean - 0.5 x minimum utility"): subtracting the minimum directly
 * penalizes destinations everyone likes MORE than ones someone hates
 * (e.g. [80,80,80] -> 40 vs [80,80,0] -> ~53). Penalizing the shortfall
 * instead rewards high minimum utility, which is the actual fairness goal.
 */
export function groupAggregate(
  utilities: number[],
  weights?: number[],
  minPenalty = 0.5,
): number {
  if (utilities.length === 0) return 0;
  const w =
    weights && weights.length === utilities.length
      ? weights
      : utilities.map(() => 1 / utilities.length);
  const mean = utilities.reduce((s, u, k) => s + u * (w[k] ?? 0), 0);
  const min = Math.min(...utilities);
  return mean - minPenalty * (mean - min);
}

/* ------------------------------------------------------------------ */
/* Validation helpers used by the LLM response contract                */
/* ------------------------------------------------------------------ */

/** All numeric tokens in a text, for the "no unsupported numbers" check. */
export function numericTokens(text: string): string[] {
  const matches = text.match(/\$?\d[\d,]*(?:\.\d+)?%?/g);
  return matches ?? [];
}

/**
 * True when every numeric token in `text` appears in the allowed set
 * (numbers collected from evidence + score components).
 */
export function numbersAreGrounded(text: string, allowedNumbers: Set<string>): boolean {
  return numericTokens(text).every((t) => {
    const bare = t.replace(/[$,%]/g, "");
    return allowedNumbers.has(t) || allowedNumbers.has(bare);
  });
}

/** Collect every numeric token from evidence summaries/details for grounding checks. */
export function collectEvidenceNumbers(evidence: Evidence[]): Set<string> {
  const out = new Set<string>();
  for (const ev of evidence) {
    for (const t of numericTokens(ev.summary)) {
      out.add(t);
      out.add(t.replace(/[$,%]/g, ""));
    }
    const walk = (v: unknown): void => {
      if (typeof v === "number") {
        out.add(String(v));
        out.add(String(Math.round(v)));
      } else if (typeof v === "string") {
        for (const t of numericTokens(v)) {
          out.add(t);
          out.add(t.replace(/[$,%]/g, ""));
        }
      } else if (Array.isArray(v)) {
        v.forEach(walk);
      } else if (v && typeof v === "object") {
        Object.values(v as Record<string, unknown>).forEach(walk);
      }
    };
    walk(ev.details);
  }
  return out;
}

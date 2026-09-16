import { describe, expect, it } from "vitest";
import {
  SCORE_WEIGHTS,
  airfareFit,
  computeScore,
  freshnessFit,
  groupAggregate,
  hardFilter,
  interestFit,
  noveltyFit,
  riskPenalty,
  risksFromEvidence,
  travelTimeFit,
  weatherFit,
  weightsSum,
} from "./shared/scoring.js";
import type { Evidence, NormalizedPreferences, RiskItem } from "./shared/types.js";

const basePrefs = {
  passportCountry: "US",
  tempMinF: 70,
  tempMaxF: 90,
  airfareMaxPerPerson: 1000,
  advisoryMaxSeverity: "high",
  interests: ["luxury-car events"],
} as unknown as NormalizedPreferences;

function risk(severity: RiskItem["severity"], type: RiskItem["type"] = "ADVISORY"): RiskItem {
  return {
    type,
    severity,
    status: severity === "unknown" ? "UNRESOLVED" : "CAUTION",
    appliesTo: { destination: "monterey" },
    summary: `${severity} risk`,
    sourceUrl: "https://example.com",
    observedAt: new Date().toISOString(),
    effectiveAt: null,
    expiresAt: null,
  };
}

describe("scoring weights", () => {
  it("weights sum to 1.0", () => {
    expect(weightsSum()).toBeCloseTo(1.0, 10);
    expect(SCORE_WEIGHTS.airfare).toBe(0.3);
    expect(SCORE_WEIGHTS.weather).toBe(0.25);
    expect(SCORE_WEIGHTS.interest).toBe(0.2);
    expect(SCORE_WEIGHTS.travelTime).toBe(0.1);
    expect(SCORE_WEIGHTS.freshness).toBe(0.1);
    expect(SCORE_WEIGHTS.novelty).toBe(0.05);
  });
});

describe("hardFilter", () => {
  const ok = {
    fareAmount: 500,
    ceiling: 1000,
    daysInBand: 10,
    totalDays: 14,
    tempHard: false,
    advisorySeverity: "low" as const,
    advisoryThreshold: "high" as const,
    entryStatus: "OK" as const,
    entryKnown: true,
  };

  it("passes a clean candidate", () => {
    expect(hardFilter(ok).pass).toBe(true);
  });

  it("rejects fare over ceiling", () => {
    const r = hardFilter({ ...ok, fareAmount: 1200 });
    expect(r.pass).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/exceeds the per-person ceiling/);
  });

  it("rejects when no itinerary exists", () => {
    const r = hardFilter({ ...ok, fareAmount: null });
    expect(r.pass).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/No valid itinerary/);
  });

  it("rejects a hard temperature band miss", () => {
    const r = hardFilter({ ...ok, tempHard: true, daysInBand: 2, totalDays: 14 });
    expect(r.pass).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/hard temperature band/);
  });

  it("does not reject a soft temperature band miss", () => {
    const r = hardFilter({ ...ok, tempHard: false, daysInBand: 2, totalDays: 14 });
    expect(r.pass).toBe(true);
  });

  it("rejects advisory severity over the user threshold", () => {
    const r = hardFilter({ ...ok, advisorySeverity: "critical", advisoryThreshold: "high" });
    expect(r.pass).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/advisory severity/);
  });

  it("never rejects on unknown advisory severity", () => {
    const r = hardFilter({ ...ok, advisorySeverity: "unknown" });
    expect(r.pass).toBe(true);
  });

  it("rejects a known-unsatisfied entry rule", () => {
    const r = hardFilter({ ...ok, entryStatus: "BLOCKED" });
    expect(r.pass).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/entry rule/);
  });

  it("unknown visa/entry status is never a silent pass: it passes the filter but stays an unresolved gate", () => {
    const r = hardFilter({ ...ok, entryStatus: "UNRESOLVED", entryKnown: false });
    expect(r.pass).toBe(true);
    // The gate must surface as a risk item, not disappear.
    const evidence: Evidence[] = [
      {
        id: "entry:visa-matrix",
        kind: "entry",
        destinationId: "monterey",
        summary: "Entry requirements not resolved",
        details: { requirement: "unknown", destinationCountry: "United States" },
        provenance: {
          provider: "entry:visa-matrix",
          sourceUrl: "https://travel.state.gov/",
          observedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          queryFingerprint: "abc",
          currency: "USD",
          timezone: "UTC",
          units: "n/a",
          confidence: "low",
          unknowns: ["No matrix entry"],
          checksum: "def",
        },
        live: false,
      },
    ];
    const risks = risksFromEvidence(evidence, basePrefs, "monterey");
    const entry = risks.find((x) => x.type === "ENTRY_RULE");
    expect(entry).toBeDefined();
    expect(entry?.severity).toBe("unknown");
    expect(entry?.status).toBe("UNRESOLVED");
    expect(entry?.summary).toMatch(/verify before booking/i);
  });
});

describe("score components", () => {
  it("airfareFit rewards headroom below ceiling, capped at 100", () => {
    expect(airfareFit(0, 1000)).toBe(100);
    expect(airfareFit(500, 1000)).toBe(50);
    expect(airfareFit(1000, 1000)).toBe(0);
  });

  it("weatherFit is the share of in-band days", () => {
    expect(weatherFit(7, 14)).toBe(50);
    expect(weatherFit(0, 0)).toBe(0);
  });

  it("interestFit combines taxonomy overlap and events", () => {
    expect(interestFit(2, 2, 1)).toBe(100);
    expect(interestFit(1, 2, 0)).toBe(35);
    expect(interestFit(0, 0, 0)).toBe(50);
  });

  it("travelTimeFit penalizes stops and long durations", () => {
    expect(travelTimeFit(0, 4)).toBe(100);
    expect(travelTimeFit(1, 8)).toBe(64);
    expect(travelTimeFit(5, 30)).toBe(0);
  });

  it("freshnessFit decays with age relative to TTL", () => {
    expect(freshnessFit([{ ageSec: 0, ttlSec: 3600 }])).toBe(100);
    expect(freshnessFit([{ ageSec: 1800, ttlSec: 3600 }])).toBe(50);
    expect(freshnessFit([{ ageSec: 7200, ttlSec: 3600 }])).toBe(0);
    expect(freshnessFit([])).toBe(0);
  });

  it("noveltyFit rewards unseen destinations", () => {
    expect(noveltyFit(false)).toBe(100);
    expect(noveltyFit(true)).toBe(40);
  });

  it("riskPenalty follows the decision matrix and caps", () => {
    expect(riskPenalty([risk("low")])).toBe(0);
    expect(riskPenalty([risk("moderate")])).toBe(5);
    expect(riskPenalty([risk("high")])).toBe(20);
    expect(riskPenalty([risk("unknown")])).toBe(8);
    expect(riskPenalty([risk("critical"), risk("high"), risk("moderate")])).toBe(60);
  });
});

describe("computeScore", () => {
  it("applies weights and subtracts the risk penalty", () => {
    const perfect = computeScore({
      fareAmount: 0,
      ceiling: 1000,
      daysInBand: 14,
      totalDays: 14,
      interestScore: 100,
      stops: 0,
      durationHours: 4,
      evidenceAges: [{ ageSec: 0, ttlSec: 3600 }],
      novelty: 100,
      risks: [],
    });
    expect(perfect.total).toBe(100);

    const penalized = computeScore({
      fareAmount: 0,
      ceiling: 1000,
      daysInBand: 14,
      totalDays: 14,
      interestScore: 100,
      stops: 0,
      durationHours: 4,
      evidenceAges: [{ ageSec: 0, ttlSec: 3600 }],
      novelty: 100,
      risks: [risk("high")],
    });
    expect(penalized.total).toBe(80);
    expect(penalized.riskPenalty).toBe(20);
  });

  it("never goes below zero", () => {
    const s = computeScore({
      fareAmount: 999,
      ceiling: 1000,
      daysInBand: 0,
      totalDays: 14,
      interestScore: 0,
      stops: 5,
      durationHours: 30,
      evidenceAges: [],
      novelty: 40,
      risks: [risk("critical")],
    });
    expect(s.total).toBe(0);
  });
});

describe("groupAggregate", () => {
  it("penalizes the worst-off traveler's shortfall below the mean", () => {
    // mean([80,78,82])=80, min=78 -> 80 - 0.5*2 = 79
    expect(groupAggregate([80, 78, 82])).toBeCloseTo(79, 5);
    // Weights are respected: mean=90, min=0 -> 90 - 0.5*90 = 45
    // (a traveler at 0 drags the aggregate down hard — fairness works)
    expect(groupAggregate([100, 0], [0.9, 0.1])).toBeCloseTo(45, 5);
    expect(groupAggregate([])).toBe(0);
  });

  it("equals the mean when all utilities are equal", () => {
    expect(groupAggregate([70, 70])).toBeCloseTo(70, 5);
  });

  it("rewards a high minimum utility over a spread one", () => {
    // Everyone happy beats one traveler miserable, same mean-ish
    expect(groupAggregate([80, 80, 80])).toBeGreaterThan(
      groupAggregate([100, 100, 20]),
    );
  });
});

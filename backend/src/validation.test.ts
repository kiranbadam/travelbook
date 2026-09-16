import { describe, expect, it } from "vitest";
import {
  normalizeInterests,
  normalizePreferences,
  resolveOrigin,
  sharedSnapshotKey,
} from "./shared/validation.js";
import { ApiError } from "./shared/errors.js";

function prefs(overrides: Record<string, unknown> = {}) {
  return normalizePreferences({ origin: "SEA", ...overrides });
}

describe("resolveOrigin", () => {
  it("resolves airport codes", () => {
    expect(resolveOrigin("SEA").map((a) => a.code)).toEqual(["SEA"]);
    expect(resolveOrigin("sea").map((a) => a.code)).toEqual(["SEA"]);
  });

  it("resolves city names", () => {
    expect(resolveOrigin("Seattle").map((a) => a.code)).toEqual(["SEA"]);
  });

  it("resolves metros to airport sets", () => {
    expect(resolveOrigin("NYC").map((a) => a.code).sort()).toEqual(["EWR", "JFK", "LGA"]);
  });

  it("rejects unknown origins with INVALID_PREFERENCES", () => {
    try {
      resolveOrigin("ZZZ");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).errorClass).toBe("INVALID_PREFERENCES");
      expect((err as ApiError).status).toBe(400);
    }
  });
});

describe("normalizePreferences", () => {
  it("applies defaults", () => {
    const p = prefs();
    expect(p.originAirports).toEqual(["SEA"]);
    expect(p.tempMinF).toBe(70);
    expect(p.tempMaxF).toBe(90);
    expect(p.currency).toBe("USD");
    expect(p.partySize).toBe(2);
    expect(p.tempHard).toBe(false);
    expect(p.advisoryMaxSeverity).toBe("high");
    expect(p.passportCountry).toBeNull();
  });

  it("converts Celsius to Fahrenheit", () => {
    const p = prefs({ tempMin: 21, tempMax: 32, tempUnit: "C" });
    expect(p.tempMinF).toBe(70); // 21C = 69.8F -> 70
    expect(p.tempMaxF).toBe(90); // 32C = 89.6F -> 90
  });

  it("rejects inverted temperature bands", () => {
    expect(() => prefs({ tempMin: 90, tempMax: 70 })).toThrow(ApiError);
  });

  it("rejects invalid date ranges", () => {
    expect(() => prefs({ departDate: "2026-10-10", returnDate: "2026-10-01" })).toThrow(ApiError);
    expect(() => prefs({ departDate: "10/10/2026" })).toThrow(ApiError);
  });

  it("computes trip days from dates", () => {
    const p = prefs({ departDate: "2026-10-10", returnDate: "2026-10-16" });
    expect(p.tripDays).toBe(7);
  });

  it("rejects bad party sizes and budgets", () => {
    expect(() => prefs({ partySize: 0 })).toThrow(ApiError);
    expect(() => prefs({ airfareMaxPerPerson: -5 })).toThrow(ApiError);
  });

  it("keeps passport country opt-in only", () => {
    expect(prefs().passportCountry).toBeNull();
    expect(prefs({ passportCountry: "in" }).passportCountry).toBe("IN");
    expect(() => prefs({ passportCountry: "USA" })).toThrow(ApiError);
  });

  it("produces a stable preferences hash", () => {
    const a = prefs({ interests: ["luxury-car events"] });
    const b = prefs({ interests: ["luxury-car events"] });
    expect(a.preferencesHash).toBe(b.preferencesHash);
    expect(a.preferencesHash).toHaveLength(16);
    const c = prefs({ interests: ["beach"] });
    expect(c.preferencesHash).not.toBe(a.preferencesHash);
  });

  it("shared snapshot key ignores cosmetic differences", () => {
    const a = prefs({ origin: "SEA" });
    const b = prefs({ origin: "sea" });
    expect(sharedSnapshotKey(a)).toBe(sharedSnapshotKey(b));
  });
});

describe("normalizeInterests", () => {
  it("resolves taxonomy ids and aliases", () => {
    const { interests, warnings } = normalizeInterests(["Luxury-Car Events", "f1", "beach"]);
    expect(interests).toEqual(["luxury-car events", "motorsport", "beach"]);
    expect(warnings).toEqual([]);
  });

  it("warns on unknown interests instead of failing", () => {
    const { interests, warnings } = normalizeInterests(["skydiving"]);
    expect(interests).toEqual([]);
    expect(warnings).toHaveLength(1);
  });
});

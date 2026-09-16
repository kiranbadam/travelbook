import { ApiError } from "./errors.js";
import { fingerprint } from "./provenance.js";
import type { NormalizedPreferences, PreferencesInput, Severity } from "./types.js";

/* ------------------------------------------------------------------ */
/* Airport directory: origin resolution (codes, city names, metros)    */
/* ------------------------------------------------------------------ */

export interface AirportInfo {
  code: string;
  city: string;
  lat: number;
  lon: number;
}

const AIRPORTS: AirportInfo[] = [
  { code: "SEA", city: "Seattle", lat: 47.4502, lon: -122.3088 },
  { code: "PDX", city: "Portland", lat: 45.5898, lon: -122.5951 },
  { code: "SFO", city: "San Francisco", lat: 37.6213, lon: -122.379 },
  { code: "LAX", city: "Los Angeles", lat: 33.9416, lon: -118.4085 },
  { code: "SAN", city: "San Diego", lat: 32.7338, lon: -117.1933 },
  { code: "LAS", city: "Las Vegas", lat: 36.084, lon: -115.1537 },
  { code: "PHX", city: "Phoenix", lat: 33.4373, lon: -112.0078 },
  { code: "DEN", city: "Denver", lat: 39.8561, lon: -104.6737 },
  { code: "DFW", city: "Dallas", lat: 32.8998, lon: -97.0403 },
  { code: "AUS", city: "Austin", lat: 30.1945, lon: -97.6699 },
  { code: "IAH", city: "Houston", lat: 29.9902, lon: -95.3368 },
  { code: "ORD", city: "Chicago", lat: 41.9742, lon: -87.9073 },
  { code: "MSP", city: "Minneapolis", lat: 44.8848, lon: -93.2223 },
  { code: "DTW", city: "Detroit", lat: 42.2124, lon: -83.3554 },
  { code: "ATL", city: "Atlanta", lat: 33.6407, lon: -84.4277 },
  { code: "MIA", city: "Miami", lat: 25.7959, lon: -80.287 },
  { code: "MCO", city: "Orlando", lat: 28.4312, lon: -81.3081 },
  { code: "JFK", city: "New York", lat: 40.6413, lon: -73.7781 },
  { code: "EWR", city: "New York", lat: 40.6895, lon: -74.1745 },
  { code: "LGA", city: "New York", lat: 40.7769, lon: -73.874 },
  { code: "BOS", city: "Boston", lat: 42.3656, lon: -71.0096 },
  { code: "DCA", city: "Washington", lat: 38.8512, lon: -77.0402 },
  { code: "IAD", city: "Washington", lat: 38.9531, lon: -77.4565 },
  { code: "YVR", city: "Vancouver", lat: 49.1967, lon: -123.1815 },
  { code: "YYZ", city: "Toronto", lat: 43.6777, lon: -79.6248 },
];

const METRO_AIRPORTS: Record<string, string[]> = {
  NYC: ["JFK", "EWR", "LGA"],
  "NEW YORK": ["JFK", "EWR", "LGA"],
  WAS: ["DCA", "IAD"],
  WASHINGTON: ["DCA", "IAD"],
  "WASHINGTON DC": ["DCA", "IAD"],
  "SAN FRANCISCO BAY AREA": ["SFO"],
  "BAY AREA": ["SFO"],
  "LOS ANGELES": ["LAX"],
  LA: ["LAX"],
  "DALLAS FORT WORTH": ["DFW"],
  "TWIN CITIES": ["MSP"],
};

const AIRPORT_BY_CODE = new Map(AIRPORTS.map((a) => [a.code, a]));

export function resolveOrigin(input: string): AirportInfo[] {
  const raw = (input ?? "").trim();
  if (!raw) throw new ApiError("INVALID_PREFERENCES", "origin is required");
  const key = raw.toUpperCase();

  const direct = AIRPORT_BY_CODE.get(key);
  if (direct) return [direct];

  const metro = METRO_AIRPORTS[key];
  if (metro) {
    return metro
      .map((c) => AIRPORT_BY_CODE.get(c))
      .filter((a): a is AirportInfo => a !== undefined);
  }

  const byCity = AIRPORTS.filter(
    (a) => a.city.toUpperCase() === key || a.city.toUpperCase().startsWith(key),
  );
  if (byCity.length > 0) return byCity;

  throw new ApiError(
    "INVALID_PREFERENCES",
    `Unknown origin "${raw}". Use an airport code (e.g. SEA) or a city name (e.g. Seattle).`,
    { origin: raw },
  );
}

/* ------------------------------------------------------------------ */
/* Interest taxonomy                                                   */
/* ------------------------------------------------------------------ */

export const INTEREST_TAXONOMY = [
  "luxury-car events",
  "motorsport",
  "food",
  "beach",
  "mountains",
  "hiking",
  "museums",
  "music",
  "nightlife",
  "wine",
  "history",
  "art",
  "architecture",
  "shopping",
  "family",
] as const;

export type InterestId = (typeof INTEREST_TAXONOMY)[number];

const INTEREST_ALIASES: Record<string, InterestId> = {
  "car events": "luxury-car events",
  "cars": "luxury-car events",
  "auto events": "luxury-car events",
  "racing": "motorsport",
  "formula 1": "motorsport",
  "f1": "motorsport",
  "dining": "food",
  "restaurants": "food",
  "skiing": "mountains",
  "concerts": "music",
  "live music": "music",
  "clubs": "nightlife",
  "kid friendly": "family",
  "kids": "family",
};

export function normalizeInterests(input: string[] | undefined): {
  interests: string[];
  warnings: string[];
} {
  const interests: string[] = [];
  const warnings: string[] = [];
  for (const raw of input ?? []) {
    const key = raw.trim().toLowerCase();
    if (!key) continue;
    const direct = (INTEREST_TAXONOMY as readonly string[]).find((t) => t === key);
    const aliased = INTEREST_ALIASES[key];
    const resolved = direct ?? aliased;
    if (resolved) {
      if (!interests.includes(resolved)) interests.push(resolved);
    } else {
      warnings.push(`Unknown interest "${raw}" ignored; supported: ${INTEREST_TAXONOMY.join(", ")}.`);
    }
  }
  return { interests, warnings };
}

/* ------------------------------------------------------------------ */
/* Dates                                                               */
/* ------------------------------------------------------------------ */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(value: string | undefined, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (!ISO_DATE.test(value)) {
    throw new ApiError("INVALID_PREFERENCES", `${field} must be YYYY-MM-DD`, { field, value });
  }
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) {
    throw new ApiError("INVALID_PREFERENCES", `${field} is not a valid date`, { field, value });
  }
  return value;
}

function toF(value: number, unit: "F" | "C"): number {
  return unit === "C" ? value * 1.8 + 32 : value;
}

/* ------------------------------------------------------------------ */
/* Main normalization                                                  */
/* ------------------------------------------------------------------ */

const VALID_SEVERITIES: Severity[] = ["low", "moderate", "high", "critical", "unknown"];

export function normalizePreferences(input: PreferencesInput): NormalizedPreferences {
  if (!input || typeof input !== "object") {
    throw new ApiError("INVALID_PREFERENCES", "preferences body must be a JSON object");
  }

  const airports = resolveOrigin(input.origin);
  const originAirports = airports.map((a) => a.code);
  const originLat = airports.reduce((s, a) => s + a.lat, 0) / airports.length;
  const originLon = airports.reduce((s, a) => s + a.lon, 0) / airports.length;

  const departDate = parseDate(input.departDate, "departDate");
  const returnDate = parseDate(input.returnDate, "returnDate");
  if (departDate && returnDate && returnDate < departDate) {
    throw new ApiError("INVALID_PREFERENCES", "returnDate must be on or after departDate");
  }
  const tripDays =
    departDate && returnDate
      ? Math.round(
          (Date.parse(`${returnDate}T00:00:00Z`) - Date.parse(`${departDate}T00:00:00Z`)) / 86400000,
        ) + 1
      : null;

  const warnings: string[] = [];
  const today = new Date().toISOString().slice(0, 10);
  if (departDate && departDate < today) {
    warnings.push("departDate is in the past; results may be limited to forecasts from today.");
  }

  const dateFlexDays = input.dateFlexDays ?? 0;
  if (!Number.isInteger(dateFlexDays) || dateFlexDays < 0 || dateFlexDays > 30) {
    throw new ApiError("INVALID_PREFERENCES", "dateFlexDays must be an integer 0..30");
  }

  const tempUnit = input.tempUnit ?? "F";
  if (tempUnit !== "F" && tempUnit !== "C") {
    throw new ApiError("INVALID_PREFERENCES", 'tempUnit must be "F" or "C"');
  }
  const tempMin = input.tempMin ?? 70;
  const tempMax = input.tempMax ?? 90;
  if (!Number.isFinite(tempMin) || !Number.isFinite(tempMax)) {
    throw new ApiError("INVALID_PREFERENCES", "tempMin/tempMax must be numbers");
  }
  const tempMinF = Math.round(toF(tempMin, tempUnit));
  const tempMaxF = Math.round(toF(tempMax, tempUnit));
  if (tempMinF >= tempMaxF) {
    throw new ApiError("INVALID_PREFERENCES", "tempMin must be below tempMax");
  }
  const tempHard = input.tempHard ?? false;

  const airfareMaxPerPerson = input.airfareMaxPerPerson ?? 1000;
  if (!Number.isFinite(airfareMaxPerPerson) || airfareMaxPerPerson <= 0) {
    throw new ApiError("INVALID_PREFERENCES", "airfareMaxPerPerson must be a positive number");
  }
  if (input.currency && input.currency.toUpperCase() !== "USD") {
    warnings.push(`Only USD is supported in this alpha; treating budget as USD.`);
  }

  const partySize = input.partySize ?? 2;
  if (!Number.isInteger(partySize) || partySize < 1 || partySize > 20) {
    throw new ApiError("INVALID_PREFERENCES", "partySize must be an integer 1..20");
  }

  const { interests, warnings: interestWarnings } = normalizeInterests(input.interests);
  warnings.push(...interestWarnings);

  const advisoryMaxSeverity = input.advisoryMaxSeverity ?? "high";
  if (!VALID_SEVERITIES.includes(advisoryMaxSeverity) || advisoryMaxSeverity === "unknown") {
    throw new ApiError(
      "INVALID_PREFERENCES",
      'advisoryMaxSeverity must be one of "low", "moderate", "high", "critical"',
    );
  }

  const cabin = input.cabin ?? "economy";
  if (cabin !== "economy" && cabin !== "premium" && cabin !== "business") {
    throw new ApiError("INVALID_PREFERENCES", 'cabin must be "economy", "premium" or "business"');
  }

  // Passport country is opt-in only; default to US for the visa matrix.
  const passportCountry = input.passportCountry ? input.passportCountry.toUpperCase() : null;
  if (input.passportCountry && !/^[A-Z]{2}$/.test(input.passportCountry.toUpperCase())) {
    throw new ApiError("INVALID_PREFERENCES", "passportCountry must be a 2-letter country code");
  }

  const normalized: NormalizedPreferences = {
    version: 1,
    originAirports,
    originLabel: input.origin.trim(),
    originLat,
    originLon,
    departDate,
    returnDate,
    dateFlexDays,
    tripDays,
    tempMinF,
    tempMaxF,
    tempHard,
    airfareMaxPerPerson,
    currency: "USD",
    partySize,
    interests,
    interestWarnings,
    advisoryMaxSeverity,
    passportCountry,
    cabin,
    warnings,
    preferencesHash: "",
  };
  normalized.preferencesHash = fingerprint({
    v: 1,
    originAirports,
    departDate,
    returnDate,
    dateFlexDays,
    tempMinF,
    tempMaxF,
    tempHard,
    airfareMaxPerPerson,
    partySize,
    interests,
    advisoryMaxSeverity,
    passportCountry,
    cabin,
  });
  return normalized;
}

/** Shared-snapshot cache key inputs: origin, date bucket, party, cabin, weather band, interest family. */
export function sharedSnapshotKey(p: NormalizedPreferences): string {
  return fingerprint({
    originAirports: p.originAirports,
    departDate: p.departDate,
    tripDays: p.tripDays,
    partySize: p.partySize,
    cabin: p.cabin,
    tempBand: [p.tempMinF, p.tempMaxF],
    interestFamily: [...p.interests].sort().join("|"),
  });
}

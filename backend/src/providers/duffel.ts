import { buildProvenance, fingerprint } from "../shared/provenance.js";
import { nowIso } from "../shared/ddb.js";
import { distanceMiles } from "../shared/catalog.js";
import type { Evidence } from "../shared/types.js";
import type { EnrichInput, EvidenceProvider, ProviderHealth } from "./interface.js";
import { getSsmParam, ssmPrefix } from "./ssm.js";

/**
 * Duffel flight adapter — MOCK ONLY until production access is confirmed.
 *
 * Launch gate (architecture plan): "Production access and pricing must be
 * confirmed. Sandbox results are never shown as live fares."
 *
 * Every item this adapter emits is live:false with an explicit unknown
 * stating the fare is illustrative. The SSM param /travelbook/dev/duffel/mode
 * is read so a future "live" switch is deliberate and auditable — but this
 * alpha build never shapes output to look like a live offer.
 */

const FARES_SUMMARY =
  "Illustrative fare \u2014 Duffel production access pending; do not treat as a live price.";

interface MockFare {
  amount: number;
  stops: number;
  durationHours: number;
}

/** Deterministic illustrative fare from distance bands (stable for tests). */
export function illustrativeFare(originLat: number, originLon: number, destLat: number, destLon: number, seedKey: string): MockFare {
  const miles = distanceMiles(originLat, originLon, destLat, destLon);
  let band: [number, number];
  if (miles < 1500) band = [180, 350];
  else if (miles < 3000) band = [350, 600];
  else if (miles < 5000) band = [600, 900];
  else band = [900, 1400];
  // Deterministic pick inside the band from the seed key.
  const h = parseInt(fingerprint({ seedKey, miles: Math.round(miles) }).slice(0, 8), 16);
  const frac = (h % 1000) / 1000;
  const amount = Math.round(band[0] + frac * (band[1] - band[0]));
  const stops = miles < 1500 ? h % 2 : miles < 3000 ? 1 : 1 + (h % 2);
  const durationHours = Math.round((miles / 450 + stops * 1.5) * 10) / 10;
  return { amount, stops, durationHours };
}

export class DuffelProvider implements EvidenceProvider<MockFare> {
  readonly name = "fare:duffel";
  freshnessMs(): number {
    return 45 * 60 * 1000; // plan: flights 30-60 min -> 45 min
  }
  health(): ProviderHealth {
    return { ok: true, mode: "mock", message: "Duffel adapter is mock-only until production access is confirmed" };
  }

  async search(input: EnrichInput): Promise<MockFare[]> {
    const { destination, prefs } = input;
    // Read the mode flag for auditability; mock regardless in this build.
    await getSsmParam(`${ssmPrefix()}/duffel/mode`).catch(() => null);
    const fare = illustrativeFare(
      prefs.originLat,
      prefs.originLon,
      destination.lat,
      destination.lon,
      `${prefs.originAirports.join(",")}>${destination.id}`,
    );
    return [fare];
  }

  normalize(raw: MockFare[], input: EnrichInput): Evidence[] {
    const { destination, prefs } = input;
    const fare = raw[0];
    const observedAt = nowIso();
    if (!fare) return [];
    const destAirport = destination.airports[0] ?? destination.id.toUpperCase();
    const details = {
      amount: fare.amount,
      currency: "USD",
      perPerson: true,
      roundTrip: true,
      cabin: prefs.cabin,
      origin: prefs.originAirports,
      destinationAirport: destAirport,
      stops: fare.stops,
      durationHours: fare.durationHours,
      live: false,
    };
    const query = {
      provider: this.name,
      originAirports: prefs.originAirports,
      destinationId: destination.id,
      cabin: prefs.cabin,
      partySize: prefs.partySize,
      mode: "mock",
    };
    return [
      {
        id: this.name,
        kind: "fare",
        destinationId: destination.id,
        summary: `Illustrative round-trip ~$${fare.amount} per person (${FARES_SUMMARY})`,
        details,
        provenance: buildProvenance({
          provider: this.name,
          sourceUrl: "https://duffel.com/",
          observedAt,
          ttlMs: this.freshnessMs(),
          query,
          currency: "USD",
          timezone: destination.timezone ?? "UTC",
          units: "USD",
          confidence: "low",
          unknowns: [FARES_SUMMARY],
          payload: details,
        }),
        live: false,
      },
    ];
  }
}

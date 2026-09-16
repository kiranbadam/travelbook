import { buildProvenance, fingerprint } from "../shared/provenance.js";
import { nowIso } from "../shared/ddb.js";
import type { Evidence } from "../shared/types.js";
import { fetchWithTimeout } from "./egress.js";
import type { EnrichInput, EvidenceProvider, ProviderHealth } from "./interface.js";
import { getSsmParam, isUnset, ssmPrefix } from "./ssm.js";

/**
 * Ticketmaster Discovery API v2 (events).
 * Key comes from SSM /travelbook/dev/ticketmaster/api-key at runtime.
 * UNSET/missing -> deterministic mock events, clearly flagged
 * (live:false, confidence low, unknowns explain the sample data).
 * Default quota 5,000 calls/day and 5 req/s: client-side throttle (250ms)
 * plus 12h caching keeps us far below both.
 */

interface TmEvent {
  id: string;
  name: string;
  dates?: { start?: { localDate?: string; localTime?: string } };
  _embedded?: { venues?: { name?: string; city?: { name?: string } }[] };
  url?: string;
  classifications?: { segment?: { name?: string }; genre?: { name?: string } }[];
  priceRanges?: { min?: number; max?: number; currency?: string }[];
}

const SOURCE_URL = "https://www.ticketmaster.com";
let lastCallMs = 0;

function classificationFor(interests: string[]): string | undefined {
  if (interests.includes("motorsport") || interests.includes("luxury-car events")) return "Sports";
  if (interests.includes("music")) return "Music";
  if (interests.includes("museums") || interests.includes("art")) return "Arts & Theatre";
  return undefined;
}

export class TicketmasterProvider implements EvidenceProvider<TmEvent> {
  readonly name = "events:ticketmaster";
  freshnessMs(): number {
    return 12 * 60 * 60 * 1000; // plan: events 12h
  }
  health(): ProviderHealth {
    return { ok: true, mode: "live", message: "Ticketmaster Discovery API v2 (key from SSM; mock when unset)" };
  }

  private async apiKey(): Promise<string | null> {
    const v = await getSsmParam(`${ssmPrefix()}/ticketmaster/api-key`);
    return isUnset(v) ? null : v;
  }

  async search(input: EnrichInput): Promise<TmEvent[]> {
    const key = await this.apiKey();
    if (!key) return this.mockEvents(input);
    // Client-side throttle: stay well under 5 req/s.
    const now = Date.now();
    const wait = 250 - (now - lastCallMs);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCallMs = Date.now();

    const { destination, prefs } = input;
    const params = new URLSearchParams({
      apikey: key,
      latlong: `${destination.lat},${destination.lon}`,
      radius: "50",
      unit: "miles",
      size: "10",
      sort: "date,asc",
    });
    const classification = classificationFor(prefs.interests);
    if (classification) params.set("classificationName", classification);
    const res = await fetchWithTimeout(
      `https://api.ticketmaster.com/discovery/v2/events.json?${params.toString()}`,
      { headers: { "User-Agent": "travelbook-alpha/0.1.0" } },
      input.timeoutMs,
    );
    if (!res.ok) throw new Error(`Ticketmaster HTTP ${res.status}`);
    const data = (await res.json()) as { _embedded?: { events?: TmEvent[] } };
    return data._embedded?.events ?? [];
  }

  /** Deterministic sample events when no key is configured — never live. */
  private mockEvents(input: EnrichInput): TmEvent[] {
    const { destination, prefs } = input;
    const seed = fingerprint({ d: destination.id, i: prefs.interests });
    const tags = destination.interestTags.filter((t) => prefs.interests.includes(t));
    const picks = (tags.length ? tags : destination.interestTags).slice(0, 2);
    return picks.map((tag, k) => ({
      id: `mock-${seed.slice(0, 8)}-${k}`,
      name: `Sample ${tag} event — ${destination.name}`,
      dates: { start: { localDate: prefs.departDate ?? undefined } },
      _embedded: { venues: [{ name: "Sample venue", city: { name: destination.name } }] },
      url: SOURCE_URL,
      classifications: [{ segment: { name: tag } }],
    }));
  }

  normalize(raw: TmEvent[], input: EnrichInput): Evidence[] {
    const { destination, prefs } = input;
    const observedAt = nowIso();
    const isMock = raw.length > 0 && raw[0]?.id.startsWith("mock-");
    const events = raw.slice(0, 5).map((e) => ({
      id: e.id,
      name: e.name,
      date: e.dates?.start?.localDate ?? null,
      venue: e._embedded?.venues?.[0]?.name ?? null,
      url: e.url ?? SOURCE_URL,
      classification:
        e.classifications?.[0]?.segment?.name ?? e.classifications?.[0]?.genre?.name ?? null,
      priceRange: e.priceRanges?.[0]
        ? { min: e.priceRanges[0].min ?? null, max: e.priceRanges[0].max ?? null, currency: e.priceRanges[0].currency ?? "USD" }
        : null,
      status: isMock ? "mock" : "live",
    }));
    const matchingEvents = events.filter((e) =>
      prefs.interests.some((i) =>
        (e.classification ?? "").toLowerCase().includes(i.split(" ")[0] ?? ""),
      ),
    ).length;

    const query = {
      provider: this.name,
      destinationId: destination.id,
      lat: destination.lat,
      lon: destination.lon,
      interests: prefs.interests,
      mock: isMock,
    };
    const unknowns = isMock
      ? ["Ticketmaster key not configured \u2014 showing sample events"]
      : ["Event availability and prices can change; confirm on the event page."];
    const details = { events, matchingEvents, totalEvents: events.length };
    const summary = isMock
      ? `${events.length} sample event${events.length === 1 ? "" : "s"} (Ticketmaster key not configured)`
      : `${events.length} upcoming event${events.length === 1 ? "" : "s"} near ${destination.name}`;

    return [
      {
        id: this.name,
        kind: "event",
        destinationId: destination.id,
        summary,
        details,
        provenance: buildProvenance({
          provider: this.name,
          sourceUrl: SOURCE_URL,
          observedAt,
          ttlMs: this.freshnessMs(),
          query,
          currency: "USD",
          timezone: destination.timezone ?? "UTC",
          units: "n/a",
          confidence: isMock ? "low" : "medium",
          unknowns,
          payload: details,
        }),
        live: !isMock,
      },
    ];
  }
}

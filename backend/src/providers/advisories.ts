import { buildProvenance } from "../shared/provenance.js";
import { nowIso } from "../shared/ddb.js";
import type { Evidence } from "../shared/types.js";
import { fetchWithTimeout } from "./egress.js";
import type { EnrichInput, EvidenceProvider, ProviderHealth } from "./interface.js";

/**
 * U.S. Department of State travel advisories.
 * Treated as monitored ingestion, not a guaranteed REST contract:
 * we attempt to parse the advisory level from the country page, and on
 * ANY failure emit an UNKNOWN / UNRESOLVED risk ("Verify before booking")
 * with the canonical source URL. Official wording is preserved, never
 * paraphrased into a lower severity.
 */

const ADVISORIES_INDEX = "https://travel.state.gov/content/travel/en/traveladvisories/traveladvisories.html";

interface AdvisoryRaw {
  level: number | "unknown";
  indicators: string[];
  pageUrl: string;
  updatedAt: string | null;
}

function countryPageUrl(country: string): string {
  const slug = country.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return `https://travel.state.gov/content/travel/en/traveladvisories/traveladvisories/${slug}-travel-advisory.html`;
}

export class AdvisoryProvider implements EvidenceProvider<AdvisoryRaw> {
  readonly name = "advisory:state-dept";
  freshnessMs(): number {
    return 6 * 60 * 60 * 1000; // plan: advisories 6h
  }
  health(): ProviderHealth {
    return { ok: true, mode: "live", message: "travel.state.gov ingestion with unknown-on-failure fallback" };
  }

  async search(input: EnrichInput): Promise<AdvisoryRaw[]> {
    const { destination } = input;
    const pageUrl = countryPageUrl(destination.country);
    try {
      const res = await fetchWithTimeout(pageUrl, { headers: { "User-Agent": "travelbook-alpha/0.1.0" } }, input.timeoutMs);
      if (!res.ok) throw new Error(`state.gov HTTP ${res.status}`);
      const html = await res.text();
      // Look for "Level 1/2/3/4" markers in the page text.
      const text = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
      const m = text.match(/Level\s*([1-4])\s*:\s*([A-Za-z,\s-]{0,80})/i) ?? text.match(/Travel Advisory Level\s*([1-4])/i);
      const level = m ? (parseInt(m[1] ?? "0", 10) as 1 | 2 | 3 | 4) : "unknown";
      const indicators: string[] = [];
      const ind = text.match(/risk indicators?[:\s]+([A-Za-z,\s-]{0,120})/i);
      if (ind?.[1]) indicators.push(ind[1].trim());
      if (level === "unknown") throw new Error("advisory level not parseable");
      const updated = text.match(/(?:Updated|Last Updated)[:\s]+([A-Z][a-z]+ \d{1,2}, \d{4})/);
      return [{ level, indicators, pageUrl, updatedAt: updated?.[1] ?? null }];
    } catch {
      // ANY failure -> unknown, surfaced as UNRESOLVED downstream.
      return [{ level: "unknown", indicators: [], pageUrl, updatedAt: null }];
    }
  }

  normalize(raw: AdvisoryRaw[], input: EnrichInput): Evidence[] {
    const { destination } = input;
    const adv = raw[0] ?? { level: "unknown" as const, indicators: [], pageUrl: countryPageUrl(destination.country), updatedAt: null };
    const observedAt = nowIso();
    const query = { provider: this.name, country: destination.country, countryCode: destination.countryCode };
    const unknownLevel = adv.level === "unknown";
    const details = {
      country: destination.country,
      countryCode: destination.countryCode,
      level: adv.level,
      indicators: adv.indicators,
      updatedAt: adv.updatedAt,
      sourceUrl: adv.pageUrl,
    };
    const summary = unknownLevel
      ? `Advisory status unknown for ${destination.country} \u2014 verify before booking`
      : `${destination.country}: Travel Advisory Level ${adv.level}${adv.indicators.length ? ` (${adv.indicators.join(", ")})` : ""}`;
    return [
      {
        id: this.name,
        kind: "advisory",
        destinationId: destination.id,
        summary,
        details,
        provenance: buildProvenance({
          provider: this.name,
          sourceUrl: adv.pageUrl,
          observedAt,
          ttlMs: this.freshnessMs(),
          query,
          currency: "USD",
          timezone: destination.timezone ?? "UTC",
          units: "n/a",
          confidence: unknownLevel ? "low" : "high",
          unknowns: unknownLevel
            ? ["Advisory page unreachable or level not parseable \u2014 verify before booking"]
            : [],
          payload: details,
        }),
        live: !unknownLevel,
      },
    ];
  }
}

import { buildProvenance } from "../shared/provenance.js";
import { nowIso } from "../shared/ddb.js";
import type { Evidence } from "../shared/types.js";
import type { EnrichInput, EvidenceProvider, ProviderHealth } from "./interface.js";

/**
 * Entry/visa guidance from a deliberately small static matrix for US
 * passport holders (architecture plan: start small, authoritative sources).
 * Passport country is only used when the traveler opts in (default US);
 * unresolved -> UNKNOWN "Verify before booking", never a silent pass.
 */

export type EntryRequirement =
  | "domestic"
  | "visa-free"
  | "eta"
  | "visa-on-arrival"
  | "visa-required"
  | "unknown";

interface VisaMatrixRow {
  requirement: EntryRequirement;
  stayLimit: string | null;
  effectiveDate: string | null;
  sourceUrl: string;
}

function stateDeptUrl(country: string): string {
  const slug = country.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return `https://travel.state.gov/content/travel/en/traveladvisories/traveladvisories/${slug}-travel-advisory.html`;
}

/** US passport matrix. Keep small and sourced; expand only with ownership. */
const US_MATRIX: Record<string, VisaMatrixRow> = {
  US: { requirement: "domestic", stayLimit: null, effectiveDate: null, sourceUrl: "https://www.usa.gov/" },
  GB: { requirement: "visa-free", stayLimit: "6 months", effectiveDate: null, sourceUrl: stateDeptUrl("United Kingdom") },
  AE: { requirement: "visa-free", stayLimit: "30 days", effectiveDate: null, sourceUrl: stateDeptUrl("United Arab Emirates") },
  JP: { requirement: "visa-free", stayLimit: "90 days", effectiveDate: null, sourceUrl: stateDeptUrl("Japan") },
  SG: { requirement: "visa-free", stayLimit: "90 days", effectiveDate: null, sourceUrl: stateDeptUrl("Singapore") },
  MC: { requirement: "visa-free", stayLimit: "90 days (Schengen)", effectiveDate: null, sourceUrl: stateDeptUrl("Monaco") },
  DE: { requirement: "visa-free", stayLimit: "90 days (Schengen)", effectiveDate: null, sourceUrl: stateDeptUrl("Germany") },
  FR: { requirement: "visa-free", stayLimit: "90 days (Schengen)", effectiveDate: null, sourceUrl: stateDeptUrl("France") },
  IT: { requirement: "visa-free", stayLimit: "90 days (Schengen)", effectiveDate: null, sourceUrl: stateDeptUrl("Italy") },
  ES: { requirement: "visa-free", stayLimit: "90 days (Schengen)", effectiveDate: null, sourceUrl: stateDeptUrl("Spain") },
  MX: { requirement: "visa-free", stayLimit: "180 days", effectiveDate: null, sourceUrl: stateDeptUrl("Mexico") },
  CA: { requirement: "visa-free", stayLimit: "6 months", effectiveDate: null, sourceUrl: stateDeptUrl("Canada") },
  AU: { requirement: "eta", stayLimit: "90 days", effectiveDate: null, sourceUrl: stateDeptUrl("Australia") },
};

interface VisaRaw {
  requirement: EntryRequirement;
  stayLimit: string | null;
  effectiveDate: string | null;
  sourceUrl: string;
  passportCountry: string;
  matrixHit: boolean;
}

export class VisaProvider implements EvidenceProvider<VisaRaw> {
  readonly name = "entry:visa-matrix";
  freshnessMs(): number {
    return 24 * 60 * 60 * 1000; // static matrix; re-check daily
  }
  health(): ProviderHealth {
    return { ok: true, mode: "live", message: "Static US-passport matrix (opt-in passport country)" };
  }

  async search(input: EnrichInput): Promise<VisaRaw[]> {
    const passportCountry = input.prefs.passportCountry ?? "US";
    const row =
      passportCountry === "US" ? US_MATRIX[input.destination.countryCode] : undefined;
    if (row) {
      return [{ ...row, passportCountry, matrixHit: true }];
    }
    return [
      {
        requirement: "unknown",
        stayLimit: null,
        effectiveDate: null,
        sourceUrl: stateDeptUrl(input.destination.country),
        passportCountry,
        matrixHit: false,
      },
    ];
  }

  normalize(raw: VisaRaw[], input: EnrichInput): Evidence[] {
    const { destination, prefs } = input;
    const v = raw[0];
    const observedAt = nowIso();
    const query = {
      provider: this.name,
      passportCountry: prefs.passportCountry ?? "US",
      destinationCountry: destination.countryCode,
    };
    const requirement = v?.requirement ?? "unknown";
    const details = {
      passportCountry: v?.passportCountry ?? "US",
      destinationCountry: destination.country,
      destinationCountryCode: destination.countryCode,
      requirement,
      stayLimit: v?.stayLimit ?? null,
      effectiveDate: v?.effectiveDate ?? null,
      sourceUrl: v?.sourceUrl ?? stateDeptUrl(destination.country),
      matrixHit: v?.matrixHit ?? false,
    };
    const summary =
      requirement === "unknown"
        ? `Entry requirements for ${destination.country} not resolved \u2014 verify before booking`
        : requirement === "domestic"
          ? `Domestic travel within the United States`
          : `${destination.country}: ${requirement}${details.stayLimit ? `, up to ${details.stayLimit}` : ""} for ${details.passportCountry} passport holders`;
    return [
      {
        id: this.name,
        kind: "entry",
        destinationId: destination.id,
        summary,
        details,
        provenance: buildProvenance({
          provider: this.name,
          sourceUrl: details.sourceUrl,
          observedAt,
          ttlMs: this.freshnessMs(),
          query,
          currency: "USD",
          timezone: destination.timezone ?? "UTC",
          units: "n/a",
          confidence: requirement === "unknown" ? "low" : "medium",
          unknowns:
            requirement === "unknown"
              ? ["No matrix entry for this passport/destination pair \u2014 verify before booking"]
              : ["Rules depend on passport, residency, transit points, duration and purpose; confirm against the source."],
          payload: details,
        }),
        live: requirement !== "unknown",
      },
    ];
  }
}

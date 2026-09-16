import type { Destination, Evidence, NormalizedPreferences } from "../shared/types.js";

/** Input to every provider search call. */
export interface EnrichInput {
  destination: Destination;
  prefs: NormalizedPreferences;
  /** Per-call deadline in ms (plan: <= 8s per call). */
  timeoutMs: number;
  signal: AbortSignal;
}

export interface ProviderHealth {
  ok: boolean;
  mode: "live" | "mock" | "degraded";
  message?: string;
}

/**
 * Replaceable evidence adapter.
 * search() performs the (bounded) remote or synthetic lookup;
 * normalize() converts raw results to Evidence with provenance.
 */
export interface EvidenceProvider<TRaw = unknown> {
  readonly name: string;
  search(input: EnrichInput): Promise<TRaw[]>;
  normalize(raw: TRaw[], input: EnrichInput): Evidence[];
  /** Suggested freshness (cache TTL) for this provider's data. */
  freshnessMs(): number;
  health(): ProviderHealth;
}

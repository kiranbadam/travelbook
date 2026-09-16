import { createHash } from "node:crypto";
import type { Provenance } from "./types.js";

/** sha256 hex digest. */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Canonical JSON: object keys sorted recursively, so hashes are stable. */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** 16-hex-char fingerprint of a canonical payload (query or evidence). */
export function fingerprint(payload: unknown): string {
  return sha256Hex(stableStringify(payload)).slice(0, 16);
}

export interface ProvenanceParams {
  provider: string;
  sourceUrl: string;
  observedAt: string;
  /** TTL in ms for this provider's data (drives expiresAt). */
  ttlMs: number;
  query: unknown;
  currency?: string;
  timezone?: string;
  units?: string;
  confidence: Provenance["confidence"];
  unknowns?: string[];
  /** The normalized evidence payload the checksum covers. */
  payload: unknown;
}

/** Build a provenance envelope; checksum = sha256(normalized payload)[:16]. */
export function buildProvenance(p: ProvenanceParams): Provenance {
  const observedMs = Date.parse(p.observedAt);
  const expiresAt = new Date(observedMs + p.ttlMs).toISOString();
  return {
    provider: p.provider,
    sourceUrl: p.sourceUrl,
    observedAt: p.observedAt,
    expiresAt,
    queryFingerprint: fingerprint(p.query),
    currency: p.currency ?? "USD",
    timezone: p.timezone ?? "UTC",
    units: p.units ?? "metric",
    confidence: p.confidence,
    unknowns: p.unknowns ?? [],
    checksum: fingerprint(p.payload),
  };
}

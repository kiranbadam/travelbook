import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  ddb,
  TABLE_NAME,
  pkCache,
  skCacheResult,
  ttlFromMs,
  nowIso,
} from "../shared/ddb.js";
import { fingerprint } from "../shared/provenance.js";
import type { Evidence } from "../shared/types.js";

/**
 * CACHE#<queryHash> / RESULT#<provider> rows.
 * Stores normalized Evidence arrays; freshness is provider-specific and the
 * stale-if-error window equals one additional freshness period (labeled stale).
 */

export interface CachedEvidence {
  evidence: Evidence[];
  observedAt: string;
  stale: boolean;
}

export function evidenceQueryHash(parts: {
  provider: string;
  destinationId: string;
  lat: number;
  lon: number;
  airports: string[];
  departDate: string | null;
  tripDays: number | null;
  extra?: unknown;
}): string {
  return fingerprint(parts);
}

export async function getCachedEvidence(
  queryHash: string,
  provider: string,
  freshnessMs: number,
  nowMs: number = Date.now(),
): Promise<CachedEvidence | null> {
  const res = await ddb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { pk: pkCache(queryHash), sk: skCacheResult(provider) },
    }),
  );
  const item = res.Item as
    | { evidence: Evidence[]; observedAt: string; ttl: number }
    | undefined;
  if (!item?.evidence) return null;
  const observedMs = Date.parse(item.observedAt);
  if (Number.isNaN(observedMs)) return null;
  const ageMs = nowMs - observedMs;
  if (ageMs < 0) return null;
  if (ageMs <= freshnessMs) {
    return { evidence: item.evidence, observedAt: item.observedAt, stale: false };
  }
  // Stale-if-error window: one extra freshness period, labeled stale.
  if (ageMs <= freshnessMs * 2) {
    return { evidence: item.evidence, observedAt: item.observedAt, stale: true };
  }
  return null;
}

export async function putCachedEvidence(
  queryHash: string,
  provider: string,
  evidence: Evidence[],
  freshnessMs: number,
  nowMs: number = Date.now(),
): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        pk: pkCache(queryHash),
        sk: skCacheResult(provider),
        evidence,
        observedAt: nowIso(nowMs),
        // DynamoDB TTL: expire after freshness + stale window so rows vanish.
        ttl: ttlFromMs(freshnessMs * 2, nowMs),
      },
    }),
  );
}

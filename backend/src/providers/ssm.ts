import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

/**
 * SSM parameter reads with a 5-minute in-memory cache.
 * Secrets (Ticketmaster key, LLM key) come from SSM at runtime only —
 * never from code, never from chat. A value of "UNSET" (or a missing
 * parameter) means mock/degraded mode.
 */
const ssm = new SSMClient({ maxAttempts: 2 });
const cache = new Map<string, { value: string | null; exp: number }>();
const CACHE_MS = 5 * 60 * 1000;

export function ssmPrefix(): string {
  return process.env.SSM_PREFIX ?? "/travelbook/dev";
}

export async function getSsmParam(name: string): Promise<string | null> {
  const now = Date.now();
  const hit = cache.get(name);
  if (hit && hit.exp > now) return hit.value;
  try {
    const res = await ssm.send(
      new GetParameterCommand({ Name: name, WithDecryption: true }),
    );
    const value = res.Parameter?.Value ?? null;
    cache.set(name, { value, exp: now + CACHE_MS });
    return value;
  } catch {
    // Missing parameter / no permission -> treat as unset, not fatal.
    cache.set(name, { value: null, exp: now + CACHE_MS });
    return null;
  }
}

export function isUnset(value: string | null): boolean {
  return value === null || value.trim() === "" || value.trim().toUpperCase() === "UNSET";
}

/** Test hook: clear the in-memory SSM cache. */
export function clearSsmCache(): void {
  cache.clear();
}

import { ApiError } from "../shared/errors.js";

/**
 * Egress allowlist (hard constraint). Outbound HTTPS is permitted ONLY to
 * these hosts. Any other host throws POLICY_BLOCKED — this is what keeps
 * provider adapters (and the optional LLM branch) inside the approved set.
 */
const ALLOWLIST = [
  "open-meteo.com",
  "api.ticketmaster.com",
  "api.duffel.com",
  "travel.state.gov",
] as const;

export function assertEgressAllowed(url: string): void {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    throw new ApiError("POLICY_BLOCKED", `Refusing egress to malformed URL`);
  }
  const ok = (ALLOWLIST as readonly string[]).some(
    (a) => host === a || host.endsWith(`.${a}`),
  );
  if (!ok) {
    throw new ApiError("POLICY_BLOCKED", `Egress to ${host} is not allowlisted`, { host });
  }
}

/** fetch() with an allowlist check and a hard timeout. */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 8000,
): Promise<Response> {
  assertEgressAllowed(url);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal, redirect: "follow" });
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new Error(
      `fetch failed for ${new URL(url).hostname}: ${(err as Error).message}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

import { fetchWithTimeout } from "./egress.js";
import { getSsmParam, isUnset, ssmPrefix } from "./ssm.js";
import type { HeroImage } from "../shared/types.js";

/**
 * Pexels hero images — ILLUSTRATION ONLY, never evidence.
 *
 * The Pexels API (api.pexels.com) is free tier: 200 requests/hour and
 * 20,000/month. The worker makes at most 5 search calls per feed
 * generation, so we stay far below both limits.
 *
 * Auth: raw `Authorization: <API_KEY>` header (Pexels scheme — no Bearer
 * prefix). Key comes from SSM /travelbook/dev/pexels/api-key at runtime.
 * Missing/UNSET key -> every call returns null and cards render exactly
 * as they do today (graceful degradation, zero impact on the job).
 *
 * Any failure (network, non-200, empty results, unexpected shape) also
 * returns null — hero images must never fail a feed job. The served image
 * URL lives on images.pexels.com (the Pexels CDN host).
 *
 * Attribution (Pexels API terms): the frontend renders
 * "Photo by {photographer} on Pexels" with links to the photographer
 * profile and the photo page.
 */

interface PexelsPhoto {
  url?: unknown;
  photographer?: unknown;
  photographer_url?: unknown;
  src?: { landscape?: unknown; large?: unknown };
}

interface PexelsSearchResponse {
  photos?: PexelsPhoto[];
}

async function apiKey(): Promise<string | null> {
  const v = await getSsmParam(`${ssmPrefix()}/pexels/api-key`);
  return isUnset(v) ? null : (v as string);
}

/**
 * Fetch one landscape hero image for a destination name.
 * Returns null on ANY failure — the caller must treat null as
 * "no photo available" and continue normally.
 */
export async function fetchHeroImage(
  destinationName: string,
  timeoutMs = 8000,
): Promise<HeroImage | null> {
  try {
    const key = await apiKey();
    if (!key) return null;
    const params = new URLSearchParams({
      query: `${destinationName} travel`,
      orientation: "landscape",
      per_page: "3",
    });
    const res = await fetchWithTimeout(
      `https://api.pexels.com/v1/search?${params.toString()}`,
      {
        headers: {
          Authorization: key,
          "User-Agent": "travelbook-alpha/0.1.0",
        },
      },
      timeoutMs,
    );
    if (!res.ok) return null;
    const data = (await res.json()) as PexelsSearchResponse;
    const photo = (Array.isArray(data.photos) ? data.photos : []).find(
      (p) =>
        typeof p?.src?.landscape === "string" ||
        typeof p?.src?.large === "string",
    );
    if (!photo) return null;
    const url =
      typeof photo.src?.landscape === "string"
        ? photo.src.landscape
        : (photo.src?.large as string);
    if (typeof photo.photographer !== "string" || photo.photographer.trim() === "")
      return null;
    return {
      url,
      photographer: photo.photographer,
      photographerUrl:
        typeof photo.photographer_url === "string" && photo.photographer_url
          ? photo.photographer_url
          : "https://www.pexels.com",
      pageUrl:
        typeof photo.url === "string" && photo.url
          ? photo.url
          : "https://www.pexels.com",
    };
  } catch {
    return null;
  }
}

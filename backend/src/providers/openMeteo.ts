import { buildProvenance } from "../shared/provenance.js";
import { nowIso } from "../shared/ddb.js";
import type { Evidence } from "../shared/types.js";
import { fetchWithTimeout } from "./egress.js";
import type { EnrichInput, EvidenceProvider, ProviderHealth } from "./interface.js";

/**
 * Open-Meteo hosted free API (non-commercial prototype use only —
 * commercial launch requires a licensed endpoint, self-hosting, or a
 * replacement; see README "Launch gates").
 */

interface OpenMeteoDaily {
  time: string[];
  temperature_2m_max: number[];
  temperature_2m_min: number[];
  precipitation_probability_max: number[];
  windspeed_10m_max: number[];
}

interface OpenMeteoResponse {
  daily?: OpenMeteoDaily;
  timezone?: string;
}

const SOURCE_URL = "https://open-meteo.com/";

function tripWindow(input: EnrichInput, dayCount: number): { start: number; count: number; note: string | null } {
  const tripDays = input.prefs.tripDays ?? dayCount;
  const count = Math.min(tripDays, dayCount, 16);
  if (!input.prefs.departDate) return { start: 0, count, note: null };
  const departMs = Date.parse(`${input.prefs.departDate}T00:00:00Z`);
  const todayMs = Date.parse(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
  const offset = Math.round((departMs - todayMs) / 86400000);
  if (offset < 0 || offset >= 16) {
    return {
      start: 0,
      count,
      note: "Trip dates fall outside the 16-day forecast window; showing the available forecast instead.",
    };
  }
  return { start: offset, count: Math.min(count, 16 - offset), note: null };
}

export class OpenMeteoProvider implements EvidenceProvider<OpenMeteoResponse> {
  readonly name = "weather:open-meteo";
  freshnessMs(): number {
    return 3 * 60 * 60 * 1000; // plan: forecast weather 3h
  }
  health(): ProviderHealth {
    return { ok: true, mode: "live", message: "Open-Meteo hosted free API (non-commercial prototype use)" };
  }

  async search(input: EnrichInput): Promise<OpenMeteoResponse[]> {
    const { destination } = input;
    const params = new URLSearchParams({
      latitude: String(destination.lat),
      longitude: String(destination.lon),
      daily: "temperature_2m_max,temperature_2m_min,precipitation_probability_max,windspeed_10m_max",
      temperature_unit: "fahrenheit",
      windspeed_unit: "mph",
      timezone: "auto",
      forecast_days: "16",
    });
    const res = await fetchWithTimeout(
      `https://api.open-meteo.com/v1/forecast?${params.toString()}`,
      { headers: { "User-Agent": "travelbook-alpha/0.1.0" } },
      input.timeoutMs,
    );
    if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
    const data = (await res.json()) as OpenMeteoResponse;
    if (!data.daily?.time?.length) throw new Error("Open-Meteo returned no daily data");
    return [data];
  }

  normalize(raw: OpenMeteoResponse[], input: EnrichInput): Evidence[] {
    const data = raw[0];
    const daily = data?.daily;
    if (!daily) return [];
    const observedAt = nowIso();
    const { destination, prefs } = input;
    const { start, count, note } = tripWindow(input, daily.time.length);

    const days: { date: string; maxF: number; minF: number; precipProb: number; windMph: number }[] = [];
    let daysInBand = 0;
    for (let k = 0; k < count; k++) {
      const idx = start + k;
      const maxF = Math.round(daily.temperature_2m_max[idx] ?? NaN);
      const minF = Math.round(daily.temperature_2m_min[idx] ?? NaN);
      if (Number.isNaN(maxF) || Number.isNaN(minF)) continue;
      const inBand = maxF >= prefs.tempMinF && maxF <= prefs.tempMaxF;
      if (inBand) daysInBand++;
      days.push({
        date: daily.time[idx] ?? "",
        maxF,
        minF,
        precipProb: daily.precipitation_probability_max[idx] ?? 0,
        windMph: Math.round(daily.windspeed_10m_max[idx] ?? 0),
      });
    }
    const totalDays = days.length;
    const maxHigh = days.length ? Math.max(...days.map((d) => d.maxF)) : 0;
    const minHigh = days.length ? Math.min(...days.map((d) => d.maxF)) : 0;

    const query = {
      provider: this.name,
      destinationId: destination.id,
      lat: destination.lat,
      lon: destination.lon,
      departDate: prefs.departDate,
      tripDays: prefs.tripDays,
      band: [prefs.tempMinF, prefs.tempMaxF],
    };
    const unknowns = ["Forecast is a model estimate, not observed weather."];
    if (note) unknowns.push(note);

    const details = {
      days,
      daysInBand,
      totalDays,
      bandMinF: prefs.tempMinF,
      bandMaxF: prefs.tempMaxF,
    };
    const summary =
      totalDays > 0
        ? `${daysInBand} of ${totalDays} days ${prefs.tempMinF}\u2013${prefs.tempMaxF}\u00B0F; highs ${minHigh}\u2013${maxHigh}\u00B0F`
        : "No forecast data available for the trip window";
    return [
      {
        id: this.name,
        kind: "weather",
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
          timezone: data.timezone ?? destination.timezone ?? "UTC",
          units: "fahrenheit/mph",
          confidence: "high",
          unknowns,
          payload: details,
        }),
        live: true,
      },
    ];
  }
}

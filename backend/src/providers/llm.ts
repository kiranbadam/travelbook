import {
  collectEvidenceNumbers,
  numbersAreGrounded,
} from "../shared/scoring.js";
import type {
  Evidence,
  LlmNarrateInput,
  LlmNarration,
} from "../shared/types.js";
import { assertEgressAllowed, fetchWithTimeout } from "./egress.js";
import { getSsmParam, isUnset, ssmPrefix } from "./ssm.js";

/**
 * Agent narration adapter.
 *
 * Default provider is "template": deterministic two-sentence explanations
 * built ONLY from score components and evidence — no network, no invention.
 *
 * If SSM /travelbook/dev/llm/provider is "gemini" or "groq" AND a key is
 * present, the adapter attempts the structured contract from the plan and
 * validates the response strictly:
 *   - destinationId must match an input candidate
 *   - every numeric token in reason must exist in evidence
 *   - evidenceRefs >= 2 and must resolve against stored evidence rows
 *   - cautions are preserved (the model cannot downgrade risk)
 * On ANY failure or invalid response -> deterministic template fallback.
 *
 * NOTE: the backend egress allowlist (providers/egress.ts) currently permits
 * only open-meteo.com, api.ticketmaster.com, api.duffel.com and
 * travel.state.gov. Model hosts are NOT allowlisted, so the model branch
 * falls back to templates until the allowlist + launch gates (provider terms,
 * retention, quota, safety evaluation) are reviewed and extended. This is
 * deliberate: prose quality degrades, factual coverage does not.
 */

export interface NarrateResult {
  narrations: LlmNarration[];
  provider: string;
  fallback: boolean;
  fallbackReason?: string;
}

function templateNarration(
  c: LlmNarrateInput["candidates"][number],
  prefs: LlmNarrateInput["preferences"],
): LlmNarration {
  const b = c.scoreBreakdown;
  const s1 =
    `${c.name} scores ${c.score}/100: airfare fit ${b.airfare} against your $${prefs.airfareMaxPerPerson} ceiling, ` +
    `weather fit ${b.weather} for ${prefs.tempF.min}\u2013${prefs.tempF.max}\u00B0F, interest match ${b.interest}.`;
  const caution = c.cautions[0] ?? "Verify entry requirements before booking";
  const s2 =
    c.unknowns.length > 0
      ? `Watch out: ${caution}; unknowns include ${c.unknowns[0]}.`
      : `Watch out: ${caution}.`;
  return {
    destinationId: c.destinationId,
    reasons: [s1, s2],
    evidenceRefs: c.evidenceRefs.slice(0, 5),
    // Template path preserves deterministic cautions verbatim.
    cautions: c.cautions.slice(0, 3),
  };
}

function templateAll(input: LlmNarrateInput): LlmNarration[] {
  return input.candidates
    .slice(0, input.instructions.maxItems)
    .map((c) => templateNarration(c, input.preferences));
}

interface ModelConfig {
  provider: "gemini" | "groq";
  key: string;
}

async function modelConfig(): Promise<ModelConfig | null> {
  const provider = (await getSsmParam(`${ssmPrefix()}/llm/provider`))?.trim().toLowerCase();
  if (provider !== "gemini" && provider !== "groq") return null;
  const key = await getSsmParam(`${ssmPrefix()}/llm/api-key`);
  if (isUnset(key)) return null;
  return { provider, key: key as string };
}

function modelUrl(cfg: ModelConfig): string {
  if (cfg.provider === "gemini") {
    return "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";
  }
  return "https://api.groq.com/openai/v1/chat/completions";
}

function modelBody(cfg: ModelConfig, input: LlmNarrateInput): unknown {
  const system = [
    "You write feed-card explanations for a travel app.",
    "RULES: output JSON only, an array of {destinationId, reasons:[s1,s2], evidenceRefs[], cautions[]}.",
    "destinationId must be one of the input candidates. reasons: exactly two sentences.",
    "noNewFacts: every number you write must appear in the supplied evidence; never invent fares, weather, events, visas or advisories.",
    "citeEvidenceRefs: include at least two evidenceRefs per recommendation, all from the input.",
    "Preserve all input cautions verbatim; you may add cautions but never remove or soften them.",
  ].join(" ");
  if (cfg.provider === "gemini") {
    return {
      system_instruction: { parts: [{ text: system }] },
      contents: [{ parts: [{ text: JSON.stringify(input) }] }],
      generationConfig: { response_mime_type: "application/json", temperature: 0.2, maxOutputTokens: 2000 },
    };
  }
  return {
    model: "llama-3.3-70b-versatile",
    temperature: 0.2,
    max_tokens: 2000,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(input) },
    ],
  };
}

function extractText(cfg: ModelConfig, json: unknown): string | null {
  try {
    if (cfg.provider === "gemini") {
      const j = json as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
      return j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? null;
    }
    const j = json as { choices?: { message?: { content?: string } }[] };
    return j.choices?.[0]?.message?.content ?? null;
  } catch {
    return null;
  }
}

/**
 * Strict response-contract validation (plan: "Response contract out of the model").
 * Returns validated narrations, or null on ANY violation -> template fallback.
 */
function validateModelResponse(
  parsed: unknown,
  input: LlmNarrateInput,
  evidenceByDest: Map<string, Evidence[]>,
  evidenceIds: Set<string>,
): LlmNarration[] | null {
  const arr = Array.isArray(parsed) ? parsed : (parsed as { recommendations?: unknown })?.recommendations;
  if (!Array.isArray(arr)) return null;
  const candidates = new Map(input.candidates.map((c) => [c.destinationId, c]));
  const out: LlmNarration[] = [];
  for (const item of arr.slice(0, input.instructions.maxItems)) {
    const r = item as Partial<LlmNarration> & { destinationId?: unknown };
    if (typeof r.destinationId !== "string" || !candidates.has(r.destinationId)) return null;
    const cand = candidates.get(r.destinationId)!;
    if (!Array.isArray(r.reasons) || r.reasons.length !== 2 || r.reasons.some((s) => typeof s !== "string")) return null;
    if (!Array.isArray(r.evidenceRefs) || r.evidenceRefs.length < 2) return null;
    if (!r.evidenceRefs.every((ref) => typeof ref === "string" && evidenceIds.has(ref))) return null;
    const evidence = evidenceByDest.get(r.destinationId) ?? [];
    const allowed = collectEvidenceNumbers(evidence);
    // Score components are deterministic facts the narration may cite.
    for (const n of Object.values(cand.scoreBreakdown)) allowed.add(String(Math.round(n as number)));
    allowed.add(String(cand.score));
    const reasons = r.reasons as [string, string];
    if (!reasons.every((s) => numbersAreGrounded(s, allowed))) return null;
    // Cautions preserved: model cannot downgrade risk — keep deterministic cautions verbatim.
    const cautions = Array.from(new Set([...cand.cautions, ...((r.cautions ?? []) as string[]).filter((s) => typeof s === "string")])).slice(0, 5);
    out.push({ destinationId: r.destinationId, reasons, evidenceRefs: r.evidenceRefs.slice(0, 5), cautions });
  }
  return out.length > 0 ? out : null;
}

export async function narrate(
  input: LlmNarrateInput,
  evidenceByDest: Map<string, Evidence[]>,
): Promise<NarrateResult> {
  const cfg = await modelConfig();
  if (!cfg) {
    return { narrations: templateAll(input), provider: "template", fallback: false };
  }
  try {
    const url = modelUrl(cfg);
    // Egress allowlist is enforced here; unlisted hosts fall back to templates.
    assertEgressAllowed(url);
    const headers: Record<string, string> =
      cfg.provider === "gemini"
        ? { "Content-Type": "application/json", "x-goog-api-key": cfg.key }
        : { "Content-Type": "application/json", Authorization: `Bearer ${cfg.key}` };
    const res = await fetchWithTimeout(url, { method: "POST", headers, body: JSON.stringify(modelBody(cfg, input)) }, 8000);
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
    const text = extractText(cfg, await res.json());
    if (!text) throw new Error("LLM returned no text");
    const parsed: unknown = JSON.parse(text);
    const evidenceIds = new Set<string>();
    for (const list of evidenceByDest.values()) for (const e of list) evidenceIds.add(e.id);
    const validated = validateModelResponse(parsed, input, evidenceByDest, evidenceIds);
    if (!validated) throw new Error("LLM response failed contract validation");
    return { narrations: validated, provider: cfg.provider, fallback: false };
  } catch (err) {
    return {
      narrations: templateAll(input),
      provider: "template",
      fallback: true,
      fallbackReason: (err as Error).message,
    };
  }
}

/** Test hook: expose strict validation without network. */
export function validateForTest(
  parsed: unknown,
  input: LlmNarrateInput,
  evidenceByDest: Map<string, Evidence[]>,
): LlmNarration[] | null {
  const evidenceIds = new Set<string>();
  for (const list of evidenceByDest.values()) for (const e of list) evidenceIds.add(e.id);
  return validateModelResponse(parsed, input, evidenceByDest, evidenceIds);
}

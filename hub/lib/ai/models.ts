/**
 * Model defaults and cost estimation.
 *
 * Anthropic ids are pinned here because they are stable, undated strings.
 * OpenAI ids deliberately are NOT pinned: the picker is populated from
 * `GET /v1/models` at connect time, so it can never go stale.
 */

import type { ModelOption, ProviderId } from "./types.ts";

export type Rates = { inputPerMTok: number; outputPerMTok: number };

export const ANTHROPIC_DEFAULT = "claude-opus-5";

export const ANTHROPIC_MODELS: (ModelOption & { rates: Rates })[] = [
  {
    id: "claude-opus-5",
    label: "Opus 5 — best quality",
    note: "$5 / $25 per million tokens",
    rates: { inputPerMTok: 5, outputPerMTok: 25 },
  },
  {
    id: "claude-sonnet-5",
    label: "Sonnet 5 — balanced",
    note: "$3 / $15 per million tokens",
    rates: { inputPerMTok: 3, outputPerMTok: 15 },
  },
  {
    id: "claude-haiku-4-5",
    label: "Haiku 4.5 — cheapest",
    note: "$1 / $5 per million tokens",
    rates: { inputPerMTok: 1, outputPerMTok: 5 },
  },
];

export function defaultModel(provider: ProviderId): string {
  return provider === "anthropic" ? ANTHROPIC_DEFAULT : "";
}

/** Highest wins: an explicit request model, then the saved override, then the default. */
export function resolveModel(
  provider: ProviderId,
  override: string | undefined,
  requested?: string,
): string {
  return (requested || override || defaultModel(provider)).trim();
}

export function ratesFor(provider: ProviderId, model: string): Rates | null {
  if (provider !== "anthropic") return null;
  return ANTHROPIC_MODELS.find((entry) => entry.id === model)?.rates || null;
}

export function estimateCost(
  provider: ProviderId,
  model: string,
  inputTokens: number | null,
  outputTokens: number | null,
): number | null {
  const rates = ratesFor(provider, model);
  if (!rates) return null;
  const input = ((inputTokens || 0) / 1_000_000) * rates.inputPerMTok;
  const output = ((outputTokens || 0) / 1_000_000) * rates.outputPerMTok;
  return input + output;
}

/** Deliberately rough — a real tokenizer is not worth the bundle weight here. */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 3.6);
}

export function formatUsd(amount: number): string {
  if (amount < 0.01) return "under $0.01";
  return `$${amount.toFixed(2)}`;
}

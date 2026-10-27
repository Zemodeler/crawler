/**
 * The only entry point feature code imports.
 *
 * Everything downstream of here — the conversion pipeline, the Connect page's
 * test button — sees one `AiClient` and never learns which of the four cells is
 * behind it.
 */

import { createAnthropicClient } from "./anthropic.ts";
import { createHostClient } from "./host.ts";
import { createOpenAiClient } from "./openai.ts";
import { effectiveModel, loadKey, loadSettings, type AiSettings } from "./settings.ts";
import { AiError, type AiClient } from "./types.ts";

export type { AiClient } from "./types.ts";

/** Build a client from explicit settings plus an already-loaded key. */
export function createAiClient(settings: AiSettings, key: string): AiClient {
  const model = effectiveModel(settings);
  if (settings.transport === "subscription" || settings.provider === "google") return createHostClient(settings.provider, settings.model);
  if (!key.trim())
    throw new AiError("no_credentials", `No ${settings.provider === "anthropic" ? "Anthropic" : "OpenAI"} API key set.`, {
      hint: "Add one on the AI settings page.",
    });
  return settings.provider === "anthropic"
    ? createAnthropicClient(key, model)
    : createOpenAiClient(key, model);
}

/** Build a client from whatever the user has saved. The common path. */
export async function createConfiguredAiClient(): Promise<AiClient> {
  const settings = loadSettings();
  const key = settings.transport === "apikey" ? await loadKey(settings.provider) : "";
  return createAiClient(settings, key);
}

/**
 * Claude via an API key, called directly from the browser.
 *
 * No server hop: `api.anthropic.com` sends permissive CORS and accepts the
 * `anthropic-dangerous-direct-browser-access` opt-in, so the key only ever
 * travels from the user's browser to Anthropic. Routing it through this app's
 * own Worker would put the key in a request log we operate, which is strictly
 * worse for a key we never need to see.
 *
 * Request-shape rules for the current models, which 400 if broken:
 *  - No `temperature`, `top_p`, `top_k`, or `budget_tokens`.
 *  - Leave `thinking` unset. Thinking is on by default and `max_tokens` covers
 *    thinking plus output, which is why the budget below is generous.
 *  - Never `thinking: {type: "disabled"}` — at high effort it 400s, and with
 *    thinking off the model can leak `<thinking>` tags that would corrupt the
 *    JSON we are about to parse.
 */

import { ANTHROPIC_MODELS, approxTokens, estimateCost, resolveModel } from "./models.ts";
import { stripForProvider, withSchemaLimits } from "./schema.ts";
import { fenceUntrusted, withRepair } from "./structured.ts";
import {
  AiError,
  type AiClient,
  type AiTarget,
  type ChatRequest,
  type ChatResult,
  type GenerateRequest,
  type GenerateResult,
  type ModelOption,
} from "./types.ts";

/**
 * Anthropic's own hosted web-search tool — the search runs on Anthropic's
 * infrastructure, never in this browser, so it needs no CSP change here.
 * `max_uses` caps cost and turnaround; five searches is generous for a single
 * chat turn about one topic's course material.
 */
const WEB_SEARCH_TOOL = { type: "web_search_20250305", name: "web_search", max_uses: 5 };

const API = "https://api.anthropic.com/v1";
const VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 32_000;

function headers(key: string): HeadersInit {
  return {
    "content-type": "application/json",
    "x-api-key": key,
    "anthropic-version": VERSION,
    // Required in addition to CORS: without it the API rejects browser origins.
    "anthropic-dangerous-direct-browser-access": "true",
  };
}

function classify(status: number, body: string): AiError {
  const message = extractMessage(body) || `Anthropic returned ${status}.`;
  if (status === 401) return new AiError("invalid_key", "That Anthropic API key was rejected.");
  if (status === 403) return new AiError("invalid_key", message);
  if (status === 404) return new AiError("model_not_found", message);
  if (status === 429) return new AiError("rate_limited", message);
  if (/credit balance|quota/i.test(body)) return new AiError("insufficient_quota", message);
  if (status >= 500) return new AiError("network", message);
  return new AiError("unknown", message, { detail: body.slice(0, 600) });
}

function extractMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    return parsed.error?.message || "";
  } catch {
    return "";
  }
}

async function request(path: string, key: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, { ...init, headers: headers(key) });
  } catch (error) {
    if ((error as Error).name === "AbortError") throw new AiError("aborted", "Cancelled.");
    throw new AiError("network", "Could not reach api.anthropic.com. Check your connection.");
  }
  if (!response.ok) throw classify(response.status, await response.text().catch(() => ""));
  return response;
}

/** Reads an SSE stream, accumulating text deltas and usage. */
async function readStream(
  response: Response,
  onChars: (chars: number) => void,
): Promise<{ text: string; inputTokens: number | null; outputTokens: number | null; stopReason: string | null; refusalCategory?: string }> {
  const reader = response.body?.getReader();
  if (!reader) throw new AiError("network", "Anthropic returned an empty response body.");
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let stopReason: string | null = null;
  let refusalCategory: string | undefined;
  let toolInput = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(payload);
      } catch {
        continue;
      }
      const type = event.type as string;
      if (type === "message_start") {
        const usage = (event.message as { usage?: { input_tokens?: number } })?.usage;
        inputTokens = usage?.input_tokens ?? null;
      } else if (type === "content_block_delta") {
        const delta = event.delta as { type?: string; text?: string; partial_json?: string };
        if (delta?.type === "text_delta" && delta.text) {
          text += delta.text;
          onChars(text.length);
        } else if (delta?.type === "input_json_delta" && delta.partial_json) {
          toolInput += delta.partial_json;
          onChars(toolInput.length);
        }
      } else if (type === "message_delta") {
        const delta = event.delta as { stop_reason?: string; stop_details?: { category?: string } };
        stopReason = delta?.stop_reason ?? stopReason;
        refusalCategory = delta?.stop_details?.category ?? refusalCategory;
        outputTokens = (event.usage as { output_tokens?: number })?.output_tokens ?? outputTokens;
      } else if (type === "error") {
        const err = event.error as { message?: string };
        throw new AiError("unknown", err?.message || "Anthropic reported a stream error.");
      }
    }
  }
  // A forced tool call carries the JSON in the tool input rather than in text.
  return { text: text.trim() || toolInput.trim(), inputTokens, outputTokens, stopReason, refusalCategory };
}

/**
 * Reads a chat stream. Distinct from `readStream` above because chat has no
 * tool-forced JSON to accumulate and does need to notice a server-run web
 * search, which `readStream` never had a reason to look for.
 */
async function readChatStream(
  response: Response,
  onChars: (chars: number) => void,
): Promise<{
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
  usedWebSearch: boolean;
  stopReason: string | null;
  refusalCategory?: string;
}> {
  const reader = response.body?.getReader();
  if (!reader) throw new AiError("network", "Anthropic returned an empty response body.");
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let stopReason: string | null = null;
  let refusalCategory: string | undefined;
  let usedWebSearch = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(payload);
      } catch {
        continue;
      }
      const type = event.type as string;
      if (type === "message_start") {
        const usage = (event.message as { usage?: { input_tokens?: number } })?.usage;
        inputTokens = usage?.input_tokens ?? null;
      } else if (type === "content_block_start") {
        const block = event.content_block as { type?: string; name?: string };
        if (block?.type === "server_tool_use" && block.name === "web_search") usedWebSearch = true;
      } else if (type === "content_block_delta") {
        const delta = event.delta as { type?: string; text?: string };
        if (delta?.type === "text_delta" && delta.text) {
          text += delta.text;
          onChars(text.length);
        }
      } else if (type === "message_delta") {
        const delta = event.delta as { stop_reason?: string; stop_details?: { category?: string } };
        stopReason = delta?.stop_reason ?? stopReason;
        refusalCategory = delta?.stop_details?.category ?? refusalCategory;
        outputTokens = (event.usage as { output_tokens?: number })?.output_tokens ?? outputTokens;
      } else if (type === "error") {
        const err = event.error as { message?: string };
        throw new AiError("unknown", err?.message || "Anthropic reported a stream error.");
      }
    }
  }
  return { text: text.trim(), inputTokens, outputTokens, usedWebSearch, stopReason, refusalCategory };
}

export function createAnthropicClient(key: string, modelOverride: string): AiClient {
  const model = resolveModel("anthropic", modelOverride);
  const target: AiTarget = { provider: "anthropic", transport: "apikey", model };

  /** One attempt. `mode` picks native structured output or the tool fallback. */
  async function attempt(
    request_: GenerateRequest,
    messages: GenerateRequest["messages"],
    mode: "output_config" | "tool",
  ) {
    const providerSchema = stripForProvider(request_.schema);
    const body: Record<string, unknown> = {
      model,
      max_tokens: request_.maxOutputTokens || DEFAULT_MAX_TOKENS,
      stream: true,
      system: withSchemaLimits(request_.system, request_.schema),
      messages: messages.map((message) => ({ role: message.role, content: message.content })),
      output_config: {
        effort: request_.effort || "high",
        ...(mode === "output_config"
          ? { format: { type: "json_schema", name: request_.schemaName, schema: providerSchema } }
          : {}),
      },
    };
    if (mode === "tool") {
      body.tools = [
        {
          name: request_.schemaName,
          description: "Return the result in this exact shape.",
          input_schema: providerSchema,
          strict: true,
        },
      ];
      body.tool_choice = { type: "tool", name: request_.schemaName };
    }

    request_.onProgress?.({ phase: "connecting" });
    const response = await request("/messages", key, {
      method: "POST",
      body: JSON.stringify(body),
      signal: request_.signal,
    });
    const result = await readStream(response, (chars) =>
      request_.onProgress?.({ phase: "streaming", chars }),
    );
    if (result.stopReason === "refusal")
      throw new AiError(
        "refused",
        `Claude declined this request${result.refusalCategory ? ` (${result.refusalCategory})` : ""}.`,
      );
    if (result.stopReason === "max_tokens")
      throw new AiError("unknown", "The response hit the output limit before finishing.", {
        detail: "Try a smaller batch, or raise maxOutputTokens.",
      });
    return { text: result.text, inputTokens: result.inputTokens, outputTokens: result.outputTokens };
  }

  return {
    target,

    async probe(signal) {
      if (!key.trim()) return { ok: false, code: "no_credentials", message: "No Anthropic API key set." };
      try {
        // Smallest possible real call: one token of output.
        const response = await request("/messages", key, {
          method: "POST",
          signal,
          body: JSON.stringify({
            model,
            max_tokens: 1,
            messages: [{ role: "user", content: "Reply with the single word OK." }],
          }),
        });
        await response.text();
        return { ok: true, detail: `${model} reachable with this key` };
      } catch (error) {
        const aiError = error as AiError;
        return {
          ok: false,
          code: aiError.code || "unknown",
          message: aiError.message,
          hint: aiError.code === "invalid_key" ? "Keys start with sk-ant-" : aiError.hint,
        };
      }
    },

    async generate<T>(generateRequest: GenerateRequest): Promise<GenerateResult<T>> {
      let mode: "output_config" | "tool" = "output_config";
      const result = await withRepair<T>(generateRequest, async (messages) => {
        try {
          return await attempt(generateRequest, messages, mode);
        } catch (error) {
          const aiError = error as AiError;
          // An older model may not accept output_config.format. Fall back once
          // to a forced tool call, which every tool-capable model supports.
          const looksLikeFormatRejection =
            aiError.code === "unknown" && /output_config|format|json_schema/i.test(aiError.message);
          if (mode === "output_config" && looksLikeFormatRejection) {
            mode = "tool";
            return attempt(generateRequest, messages, mode);
          }
          throw error;
        }
      });

      return {
        ...result,
        costUsd: estimateCost("anthropic", model, result.usage.inputTokens, result.usage.outputTokens),
        model,
        transport: "apikey",
      };
    },

    async chat(chatRequest: ChatRequest): Promise<ChatResult> {
      chatRequest.onProgress?.({ phase: "connecting" });
      const response = await request("/messages", key, {
        method: "POST",
        signal: chatRequest.signal,
        body: JSON.stringify({
          model,
          max_tokens: chatRequest.maxOutputTokens || DEFAULT_MAX_TOKENS,
          stream: true,
          system: chatRequest.system,
          messages: chatRequest.messages.map((message) => ({ role: message.role, content: message.content })),
          ...(chatRequest.webSearch ? { tools: [WEB_SEARCH_TOOL] } : {}),
        }),
      });
      const result = await readChatStream(response, (chars) =>
        chatRequest.onProgress?.({ phase: "streaming", chars }),
      );
      if (result.stopReason === "refusal")
        throw new AiError(
          "refused",
          `Claude declined this request${result.refusalCategory ? ` (${result.refusalCategory})` : ""}.`,
        );
      return {
        text: result.text,
        usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens },
        costUsd: estimateCost("anthropic", model, result.inputTokens, result.outputTokens),
        model,
        transport: "apikey",
        usedWebSearch: result.usedWebSearch,
      };
    },

    chatCapabilities() {
      return { webSearch: true };
    },

    async listModels(signal) {
      try {
        const response = await request("/models?limit=40", key, { method: "GET", signal });
        const body = (await response.json()) as { data?: { id: string; display_name?: string }[] };
        const live = (body.data || [])
          .filter((entry) => entry.id.startsWith("claude-"))
          .map<ModelOption>((entry) => {
            const known = ANTHROPIC_MODELS.find((option) => option.id === entry.id);
            return { id: entry.id, label: known?.label || entry.display_name || entry.id, note: known?.note };
          });
        // Keep the curated three first so the common choice needs no thought.
        const curated = ANTHROPIC_MODELS.filter((option) => live.some((entry) => entry.id === option.id));
        const rest = live.filter((entry) => !curated.some((option) => option.id === entry.id));
        return [...curated, ...rest];
      } catch {
        return ANTHROPIC_MODELS;
      }
    },
  };
}

export { approxTokens, fenceUntrusted };

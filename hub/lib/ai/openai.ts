/**
 * ChatGPT via an API key, called directly from the browser.
 *
 * One hard constraint drives this file: `api.openai.com` advertises exactly
 * `authorization, content-type` in its CORS allow-headers. Sending anything
 * else — `OpenAI-Beta`, `OpenAI-Organization`, a request id — fails the
 * preflight, and the failure looks like a network error rather than a header
 * problem. So: two headers, never more.
 *
 * No model id is hardcoded. The picker is populated from `GET /v1/models` at
 * connect time, which is the only way to be sure the list is current.
 */

import { resolveModel } from "./models.ts";
import { stripForProvider } from "./schema.ts";
import { withRepair } from "./structured.ts";
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

/** OpenAI's own hosted web-search tool on the Responses API — runs on
 *  OpenAI's infrastructure, never in this browser, so no CSP change is needed. */
const WEB_SEARCH_TOOL = { type: "web_search" };

const API = "https://api.openai.com/v1";
const DEFAULT_MAX_TOKENS = 32_000;

/** Exactly the two headers the CORS policy allows. */
function headers(key: string): HeadersInit {
  return { "content-type": "application/json", authorization: `Bearer ${key}` };
}

function extractMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string; code?: string } };
    return parsed.error?.message || "";
  } catch {
    return "";
  }
}

function classify(status: number, body: string): AiError {
  const message = extractMessage(body) || `OpenAI returned ${status}.`;
  if (status === 401) return new AiError("invalid_key", "That OpenAI API key was rejected.");
  if (status === 404) return new AiError("model_not_found", message);
  if (status === 429)
    return /insufficient_quota/i.test(body)
      ? new AiError("insufficient_quota", "That OpenAI account is out of credit.")
      : new AiError("rate_limited", message);
  if (status === 403) return new AiError("invalid_key", message);
  if (status >= 500) return new AiError("network", message);
  return new AiError("unknown", message, { detail: body.slice(0, 600) });
}

async function request(path: string, key: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, { ...init, headers: headers(key) });
  } catch (error) {
    if ((error as Error).name === "AbortError") throw new AiError("aborted", "Cancelled.");
    throw new AiError(
      "network",
      "Could not reach api.openai.com. Check your connection, and note that browser " +
        "requests only work with the default headers.",
    );
  }
  if (!response.ok) throw classify(response.status, await response.text().catch(() => ""));
  return response;
}

async function readStream(
  response: Response,
  onChars: (chars: number) => void,
): Promise<{ text: string; inputTokens: number | null; outputTokens: number | null; incomplete: string | null }> {
  const reader = response.body?.getReader();
  if (!reader) throw new AiError("network", "OpenAI returned an empty response body.");
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let incomplete: string | null = null;

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
      if (type === "response.output_text.delta") {
        text += (event.delta as string) || "";
        onChars(text.length);
      } else if (type === "response.completed" || type === "response.incomplete") {
        const response_ = event.response as {
          usage?: { input_tokens?: number; output_tokens?: number };
          incomplete_details?: { reason?: string };
          status?: string;
        };
        inputTokens = response_?.usage?.input_tokens ?? inputTokens;
        outputTokens = response_?.usage?.output_tokens ?? outputTokens;
        if (type === "response.incomplete") incomplete = response_?.incomplete_details?.reason || "incomplete";
      } else if (type === "response.refusal.delta" || type === "response.refusal.done") {
        throw new AiError("refused", "ChatGPT declined this request.");
      } else if (type === "error" || type === "response.failed") {
        const err = (event.error || (event.response as { error?: { message?: string } })?.error) as {
          message?: string;
        };
        throw new AiError("unknown", err?.message || "OpenAI reported a stream error.");
      }
    }
  }
  return { text: text.trim(), inputTokens, outputTokens, incomplete };
}

/** Chat's counterpart to `readStream`: no forced-JSON accumulation, but it does
 *  need to notice a server-run web search, which `readStream` never checks for. */
async function readChatStream(
  response: Response,
  onChars: (chars: number) => void,
): Promise<{
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
  usedWebSearch: boolean;
  incomplete: string | null;
}> {
  const reader = response.body?.getReader();
  if (!reader) throw new AiError("network", "OpenAI returned an empty response body.");
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let incomplete: string | null = null;
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
      if (type === "response.output_text.delta") {
        text += (event.delta as string) || "";
        onChars(text.length);
      } else if (type === "response.output_item.added" || type === "response.output_item.done") {
        const item = event.item as { type?: string };
        if (item?.type === "web_search_call") usedWebSearch = true;
      } else if (type === "response.completed" || type === "response.incomplete") {
        const response_ = event.response as {
          usage?: { input_tokens?: number; output_tokens?: number };
          incomplete_details?: { reason?: string };
          output?: { type?: string }[];
        };
        inputTokens = response_?.usage?.input_tokens ?? inputTokens;
        outputTokens = response_?.usage?.output_tokens ?? outputTokens;
        if ((response_?.output || []).some((item) => item.type === "web_search_call")) usedWebSearch = true;
        if (type === "response.incomplete") incomplete = response_?.incomplete_details?.reason || "incomplete";
      } else if (type === "response.refusal.delta" || type === "response.refusal.done") {
        throw new AiError("refused", "ChatGPT declined this request.");
      } else if (type === "error" || type === "response.failed") {
        const err = (event.error || (event.response as { error?: { message?: string } })?.error) as {
          message?: string;
        };
        throw new AiError("unknown", err?.message || "OpenAI reported a stream error.");
      }
    }
  }
  return { text: text.trim(), inputTokens, outputTokens, usedWebSearch, incomplete };
}

export function createOpenAiClient(key: string, modelOverride: string): AiClient {
  const model = resolveModel("openai", modelOverride);
  const target: AiTarget = { provider: "openai", transport: "apikey", model };

  function requireModel(): string {
    if (!model)
      throw new AiError("model_not_found", "Pick a ChatGPT model on the AI settings page first.", {
        hint: "The list is loaded from your account when you connect.",
      });
    return model;
  }

  return {
    target,

    async probe(signal) {
      if (!key.trim()) return { ok: false, code: "no_credentials", message: "No OpenAI API key set." };
      if (!model)
        return { ok: false, code: "model_not_found", message: "No ChatGPT model chosen yet." };
      try {
        const response = await request("/responses", key, {
          method: "POST",
          signal,
          body: JSON.stringify({ model, input: "Reply with the single word OK.", max_output_tokens: 16 }),
        });
        await response.text();
        return { ok: true, detail: `${model} reachable with this key` };
      } catch (error) {
        const aiError = error as AiError;
        return {
          ok: false,
          code: aiError.code || "unknown",
          message: aiError.message,
          hint: aiError.code === "invalid_key" ? "Keys start with sk-" : aiError.hint,
        };
      }
    },

    async generate<T>(generateRequest: GenerateRequest): Promise<GenerateResult<T>> {
      const chosen = requireModel();
      const result = await withRepair<T>(generateRequest, async (messages) => {
        generateRequest.onProgress?.({ phase: "connecting" });
        const response = await request("/responses", key, {
          method: "POST",
          signal: generateRequest.signal,
          body: JSON.stringify({
            model: chosen,
            stream: true,
            max_output_tokens: generateRequest.maxOutputTokens || DEFAULT_MAX_TOKENS,
            instructions: generateRequest.system,
            input: messages.map((message) => ({
              role: message.role,
              content: [
                {
                  type: message.role === "assistant" ? "output_text" : "input_text",
                  text: message.content,
                },
              ],
            })),
            text: {
              format: {
                type: "json_schema",
                name: generateRequest.schemaName,
                strict: true,
                schema: stripForProvider(generateRequest.schema),
              },
            },
          }),
        });
        const streamed = await readStream(response, (chars) =>
          generateRequest.onProgress?.({ phase: "streaming", chars }),
        );
        if (streamed.incomplete === "max_output_tokens")
          throw new AiError("unknown", "The response hit the output limit before finishing.", {
            detail: "Try a smaller batch, or raise maxOutputTokens.",
          });
        return {
          text: streamed.text,
          inputTokens: streamed.inputTokens,
          outputTokens: streamed.outputTokens,
        };
      });

      return {
        ...result,
        // Rates vary per model and are not published on the API, so we cannot
        // honestly price a ChatGPT call. Showing a made-up number is worse.
        costUsd: null,
        model: chosen,
        transport: "apikey",
      };
    },

    async chat(chatRequest: ChatRequest): Promise<ChatResult> {
      const chosen = requireModel();
      chatRequest.onProgress?.({ phase: "connecting" });
      const response = await request("/responses", key, {
        method: "POST",
        signal: chatRequest.signal,
        body: JSON.stringify({
          model: chosen,
          stream: true,
          max_output_tokens: chatRequest.maxOutputTokens || DEFAULT_MAX_TOKENS,
          instructions: chatRequest.system,
          input: chatRequest.messages.map((message) => ({
            role: message.role,
            content: [
              {
                type: message.role === "assistant" ? "output_text" : "input_text",
                text: message.content,
              },
            ],
          })),
          ...(chatRequest.webSearch ? { tools: [WEB_SEARCH_TOOL] } : {}),
        }),
      });
      const streamed = await readChatStream(response, (chars) =>
        chatRequest.onProgress?.({ phase: "streaming", chars }),
      );
      if (streamed.incomplete === "max_output_tokens")
        throw new AiError("unknown", "The response hit the output limit before finishing.", {
          detail: "Try a shorter question, or start a new conversation.",
        });
      return {
        text: streamed.text,
        usage: { inputTokens: streamed.inputTokens, outputTokens: streamed.outputTokens },
        // Same reasoning as generate(): per-model rates are not published, so we
        // cannot honestly price a ChatGPT call.
        costUsd: null,
        model: chosen,
        transport: "apikey",
        usedWebSearch: streamed.usedWebSearch,
      };
    },

    chatCapabilities() {
      return { webSearch: true };
    },

    async listModels(signal) {
      const response = await request("/models", key, { method: "GET", signal });
      const body = (await response.json()) as { data?: { id: string; created?: number }[] };
      return (body.data || [])
        .filter((entry) => /^(gpt|o\d)/.test(entry.id))
        .filter((entry) => !/audio|realtime|transcribe|tts|image|embedding|moderation/.test(entry.id))
        .sort((a, b) => (b.created || 0) - (a.created || 0))
        .map<ModelOption>((entry) => ({ id: entry.id, label: entry.id }));
    },
  };
}

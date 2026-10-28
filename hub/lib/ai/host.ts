/**
 * Subscription mode: Study Hub runs the `claude` or `codex` command-line tool
 * the student is already signed in to.
 *
 * No public API lets a website spend a Claude Pro or ChatGPT Plus
 * subscription, so this only works in the desktop app, whose host serves this
 * page and runs the CLI on the same origin. The session is an HttpOnly cookie
 * the browser attaches by itself; the custom header forces a CORS preflight
 * the host never approves, so no other site can drive it.
 */

import { isHosted } from "./settings.ts";
import { schemaPromptHint, withRepair } from "./structured.ts";
import {
  AiError,
  type AiClient,
  type AiTarget,
  type ChatRequest,
  type ChatResult,
  type GenerateRequest,
  type GenerateResult,
  type ModelOption,
  type ProviderId,
} from "./types.ts";

const GENERATE_TIMEOUT_MS = 200_000;
const GUARD_HEADER = "x-study-hub-host";
const BASE = "/api/ai";

export type CliStatus = {
  present: boolean;
  version: string | null;
  path?: string | null;
  /** Why it is not usable: not found, failed to run (with its output) or timed out. */
  error?: string | null;
  authenticated?: boolean | "unknown";
  authDetail?: string | null;
  checkedAt?: string;
};

export type HostHealth = {
  name: string;
  version: string;
  clis: Record<"claude" | "codex", CliStatus> & { gemini?: CliStatus };
  searched?: string[];
  capabilities?: { claudeWeb: boolean; codexWeb: boolean; geminiWeb?: boolean };
};

export const CLI_FOR: Record<ProviderId, "claude" | "codex" | "gemini"> = {
  anthropic: "claude",
  openai: "codex",
  google: "gemini",
};

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const original = init.signal;
  const onAbort = () => controller.abort();
  original?.addEventListener("abort", onAbort);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    original?.removeEventListener("abort", onAbort);
  }
}

/**
 * Ask the host which CLIs it found. `refresh` makes it search again (and run
 * each candidate's `--version`, which can take several seconds), for "Check
 * again" after installing or signing in to one.
 */
export async function discover(signal?: AbortSignal, options: { refresh?: boolean } = {}): Promise<HostHealth> {
  if (!isHosted())
    throw new AiError("host_unavailable", "Your subscription can only be used from the Study Hub desktop app.", {
      hint: "Open Study Hub from the desktop app, or use an API key here.",
    });
  try {
    const response = await fetchWithTimeout(
      `${BASE}/healthz${options.refresh ? "?refresh=1" : ""}`,
      { method: "GET", signal, headers: { [GUARD_HEADER]: "1" } },
      options.refresh ? 60_000 : 5_000,
    );
    if (response.ok) {
      const health = (await response.json()) as HostHealth;
      if (health?.name === "study-hub-host") return health;
    }
  } catch {
    if (signal?.aborted) throw new AiError("aborted", "Cancelled.");
  }
  throw new AiError("host_unavailable", "Study Hub's built-in connection did not answer.", {
    hint: "Reload the page. If that does not help, quit Study Hub and open it again.",
  });
}

function classify(status: number, body: string): AiError {
  let parsed: { code?: string; message?: string; detail?: string } = {};
  try {
    parsed = JSON.parse(body);
  } catch {
    /* plain-text body */
  }
  const message = parsed.message || body.slice(0, 400) || `Study Hub returned ${status}.`;
  if (status === 401)
    return new AiError("host_unavailable", "This Study Hub session has expired.", {
      hint: "Reload the page. If that does not help, quit Study Hub and open it again.",
    });
  if (status === 421) return new AiError("host_unavailable", "Study Hub refused that host name.");
  const known: Record<string, AiError["code"]> = {
    cli_not_found: "cli_not_found",
    cli_not_authenticated: "cli_not_authenticated",
    cli_incompatible: "cli_incompatible",
    timeout: "timeout",
    rate_limited: "rate_limited",
  };
  const code = parsed.code && known[parsed.code] ? known[parsed.code] : "unknown";
  return new AiError(code, message, { detail: parsed.detail });
}

async function call(body: unknown, signal: AbortSignal | undefined, timeoutMs: number): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchWithTimeout(
      `${BASE}/v1/generate`,
      {
        method: "POST",
        signal,
        headers: { "content-type": "application/json", [GUARD_HEADER]: "1" },
        body: JSON.stringify(body),
      },
      timeoutMs,
    );
  } catch (error) {
    if (signal?.aborted) throw new AiError("aborted", "Cancelled.");
    if ((error as Error).name === "AbortError") throw new AiError("timeout", "Study Hub did not answer in time.");
    throw new AiError("host_unavailable", "Lost contact with Study Hub's built-in connection.", {
      hint: "Check Study Hub is still open, then retry.",
    });
  }
  if (!response.ok) throw classify(response.status, await response.text().catch(() => ""));
  return (await response.json()) as Record<string, unknown>;
}

/** `background` marks automatic runs, which the host keeps out of the student's way. */
export function createHostClient(provider: ProviderId, modelOverride: string, options: { background?: boolean } = {}): AiClient {
  const cli = CLI_FOR[provider];
  const target: AiTarget = { provider, transport: "subscription", model: modelOverride || `${cli} (subscription)` };

  return {
    target,

    async probe(signal) {
      try {
        const health = await discover(signal);
        const status = health.clis?.[cli];
        if (!status?.present)
          return {
            ok: false,
            code: "cli_not_found",
            message: status?.error || `Study Hub could not find the \`${cli}\` command on this computer.`,
            hint: health.searched?.length ? `Searched: ${health.searched.join(", ")}` : undefined,
          };
        const result = await call({ provider, probe: true }, signal, 30_000);
        return {
          ok: true,
          detail: `${cli}${status.version ? ` ${status.version}` : ""} via your subscription${
            result.model ? ` (${String(result.model)})` : ""
          }`,
        };
      } catch (error) {
        const aiError = error as AiError;
        return { ok: false, code: aiError.code || "unknown", message: aiError.message, hint: aiError.hint };
      }
    },

    async generate<T>(generateRequest: GenerateRequest): Promise<GenerateResult<T>> {
      await discover(generateRequest.signal);

      const result = await withRepair<T>(generateRequest, async (messages) => {
        // No structured-output mode on a CLI, so the schema goes in the prompt
        // and structured.ts enforces it on the way back.
        generateRequest.onProgress?.({ phase: "connecting" });
        const prompt = [
          generateRequest.system,
          schemaPromptHint(generateRequest.schema, generateRequest.schemaName),
          "",
          ...messages.map((message) =>
            message.role === "assistant" ? `[your previous reply]\n${message.content}` : message.content,
          ),
        ].join("\n\n");

        const response = await call({ provider, prompt, model: modelOverride || undefined, background: options.background || undefined },
          generateRequest.signal,
          GENERATE_TIMEOUT_MS,
        );
        const text = String(response.text || "");
        generateRequest.onProgress?.({ phase: "streaming", chars: text.length });
        return { text, inputTokens: null, outputTokens: null };
      });

      return {
        ...result,
        // Subscription usage has no per-call price to report.
        costUsd: null,
        model: target.model,
        transport: "subscription",
      };
    },

    async chat(chatRequest: ChatRequest): Promise<ChatResult> {
      const health = await discover(chatRequest.signal);
      // The host's own capabilities are the authority, not this client's
      // best-case default: for codex the sandbox cannot yet separate network
      // access from filesystem access, so there is no real web access even when
      // the caller asked for it. Proceeding without it beats erroring each chat.
      const webAccess = Boolean(chatRequest.webSearch) && cli === "claude" && Boolean(health.capabilities?.claudeWeb);

      chatRequest.onProgress?.({ phase: "connecting" });
      // No multi-turn API on a CLI: every call is a fresh process, so the whole
      // conversation is flattened into one prompt, same as generate().
      const prompt = [
        chatRequest.system,
        "",
        ...chatRequest.messages.map((message) =>
          message.role === "assistant" ? `[your previous reply]\n${message.content}` : message.content,
        ),
      ].join("\n\n");

      const response = await call({ provider, prompt, model: modelOverride || undefined, webAccess },
        chatRequest.signal,
        GENERATE_TIMEOUT_MS,
      );
      const text = String(response.text || "");
      chatRequest.onProgress?.({ phase: "streaming", chars: text.length });
      return {
        text,
        usage: { inputTokens: null, outputTokens: null },
        costUsd: null,
        model: target.model,
        transport: "subscription",
        // The host relays plain text — it cannot report whether the CLI chose
        // to search, only whether it was allowed to. Claiming "used" here would
        // be a guess, so this stays false rather than conflating the two.
        usedWebSearch: false,
      };
    },

    chatCapabilities() {
      // Best-case default for this transport. Codex's sandbox mechanism cannot
      // yet be confirmed to separate "network on" from "filesystem off" on this
      // platform, so it stays off here until that is verified — see host/cli.mjs.
      return { webSearch: cli === "claude" };
    },

    async listModels() {
      // The CLI uses whatever model the user configured; we do not second-guess it.
      return [] as ModelOption[];
    },
  };
}

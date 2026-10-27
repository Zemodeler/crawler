/**
 * The AI integration's public shape.
 *
 * Feature code imports `createAiClient` from ./provider.ts and never learns
 * which provider or transport is in use. Four cells sit behind that interface:
 *
 *                  |  API key                    |  Subscription
 *   Claude         |  api.anthropic.com direct   |  desktop app -> `claude` CLI
 *   ChatGPT        |  api.openai.com direct      |  desktop app -> `codex` CLI
 *   Gemini         |  (not offered)              |  desktop app -> `gemini` CLI
 */

export type ProviderId = "anthropic" | "openai" | "google";
export type TransportId = "apikey" | "subscription";

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  anthropic: "Claude",
  openai: "ChatGPT",
  google: "Gemini",
};

/** Gemini is offered only through the student's own `gemini` CLI sign-in. */
export const API_KEY_PROVIDERS: ProviderId[] = ["anthropic", "openai"];

/**
 * The JSON Schema subset that survives every cell.
 *
 * Both providers' structured-output modes reject the validation keywords
 * (`maxLength`, `minItems`, `minimum`, `pattern`, …) and require every property
 * to be required with `additionalProperties: false`. We keep those keywords in
 * our own schemas because they are genuinely useful, strip them on the way out
 * to the provider, and enforce them locally instead — see ./schema.ts.
 */
export type JsonSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: false;
  $defs?: Record<string, unknown>;
};

export type AiTarget = { provider: ProviderId; transport: TransportId; model: string };

export type Progress =
  | { phase: "connecting" }
  | { phase: "streaming"; chars: number }
  | { phase: "validating" }
  | { phase: "repairing"; attempt: number };

export type GenerateRequest = {
  /** Trusted operator instructions. Never contains course text. */
  system: string;
  /** Course text lives here, wrapped in an untrusted-content fence. */
  messages: { role: "user" | "assistant"; content: string }[];
  schema: JsonSchema;
  /** snake_case identifier, e.g. "topic_pack". Providers require a name. */
  schemaName: string;
  maxOutputTokens?: number;
  effort?: "low" | "medium" | "high";
  signal?: AbortSignal;
  onProgress?: (progress: Progress) => void;
};

export type Usage = { inputTokens: number | null; outputTokens: number | null };

export type GenerateResult<T> = {
  data: T;
  /** The model's raw JSON text, kept for the debug drawer. */
  raw: string;
  usage: Usage;
  /** null for a subscription — usage has no per-call price. */
  costUsd: number | null;
  model: string;
  transport: TransportId;
  repaired: boolean;
};

export type ProbeResult =
  | { ok: true; detail: string }
  | { ok: false; code: AiErrorCode; message: string; hint?: string };

export type ModelOption = { id: string; label: string; note?: string };

/**
 * The chat surface: free-form, multi-turn, no schema and no repair — the
 * opposite of `generate()`'s contract. Every cell resends the full system
 * prompt and message history on every call; none of the four keeps
 * server-side session state (see lib/ai/chat.ts for why).
 */
export type ChatMessage = { role: "user" | "assistant"; content: string };

export type ChatRequest = {
  /** Trusted operator instructions, resent in full every turn. */
  system: string;
  messages: ChatMessage[];
  maxOutputTokens?: number;
  /** Only honoured when `chatCapabilities().webSearch` is true; a cell that
   *  cannot support it must ignore this rather than silently misbehave. */
  webSearch?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: Progress) => void;
};

export type ChatResult = {
  text: string;
  usage: Usage;
  costUsd: number | null;
  model: string;
  transport: TransportId;
  /** True only when the model actually searched this turn — distinct from
   *  `webSearch` merely having been allowed. */
  usedWebSearch: boolean;
};

export type ChatCapabilities = { webSearch: boolean };

export interface AiClient {
  readonly target: AiTarget;
  /** Cheap reachability and credential check. */
  probe(signal?: AbortSignal): Promise<ProbeResult>;
  generate<T>(request: GenerateRequest): Promise<GenerateResult<T>>;
  /** One conversational turn. No schema, no repair, free-form prose back. */
  chat(request: ChatRequest): Promise<ChatResult>;
  /** What this client can do in chat mode, known without a network call. */
  chatCapabilities(): ChatCapabilities;
  /** Populates the model picker. Empty array when unavailable. */
  listModels(signal?: AbortSignal): Promise<ModelOption[]>;
}

export type AiErrorCode =
  | "no_credentials"
  | "invalid_key"
  | "insufficient_quota"
  | "rate_limited"
  | "model_not_found"
  | "host_unavailable"
  | "cli_not_found"
  | "cli_not_authenticated"
  | "cli_incompatible"
  | "schema_invalid_after_repair"
  | "refused"
  | "timeout"
  | "network"
  | "aborted"
  | "unknown";

export class AiError extends Error {
  readonly code: AiErrorCode;
  readonly hint?: string;
  readonly detail?: string;

  constructor(code: AiErrorCode, message: string, options: { hint?: string; detail?: string } = {}) {
    super(message);
    this.name = "AiError";
    this.code = code;
    this.hint = options.hint;
    this.detail = options.detail;
  }
}

/** Plain-English copy and a named next step for every failure. */
export const ERROR_COPY: Record<AiErrorCode, { title: string; action: string }> = {
  no_credentials: { title: "No AI connection set up yet", action: "Set up your AI connection" },
  invalid_key: { title: "That API key was rejected", action: "Check the key and try again" },
  insufficient_quota: {
    title: "That account is out of credit",
    action: "Add credit, or switch to subscription mode",
  },
  rate_limited: { title: "Rate limited by the provider", action: "Wait and retry" },
  model_not_found: { title: "That model name was not recognised", action: "Reset to the default model" },
  host_unavailable: { title: "Your subscription needs the Study Hub desktop app", action: "Open Study Hub from the desktop app" },
  cli_not_found: { title: "The command-line tool was not found", action: "Install it, or enter its path" },
  cli_not_authenticated: {
    title: "The command-line tool is not signed in",
    action: "Sign in to it once, then retry",
  },
  cli_incompatible: { title: "The command-line tool rejected our options", action: "Update the tool, then retry" },
  schema_invalid_after_repair: {
    title: "The model's answer did not match the expected shape",
    action: "Try again, or use a stronger model",
  },
  refused: { title: "The model declined this request", action: "Try a different topic" },
  timeout: { title: "That took too long and was stopped", action: "Retry this step" },
  network: { title: "Could not reach the provider", action: "Check your connection and retry" },
  aborted: { title: "Cancelled", action: "Resume when ready" },
  unknown: { title: "Something went wrong", action: "Retry" },
};

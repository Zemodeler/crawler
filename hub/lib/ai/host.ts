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

/** chat() and probe() still use the single long POST /v1/generate. */
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

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const original = init.signal;
  const onAbort = () => controller.abort();
  original?.addEventListener("abort", onAbort);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
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
export function discover(signal?: AbortSignal, options: { refresh?: boolean } = {}): Promise<HostHealth> {
  return discoverWith(signal, options);
}

async function discoverWith(
  signal: AbortSignal | undefined,
  options: { refresh?: boolean },
  hosted: () => boolean = isHosted,
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): Promise<HostHealth> {
  if (!hosted())
    throw new AiError("host_unavailable", "Your subscription can only be used from the Study Hub desktop app.", {
      hint: "Open Study Hub from the desktop app, or use an API key here.",
    });
  try {
    const response = await fetchWithTimeout(
      `${BASE}/healthz${options.refresh ? "?refresh=1" : ""}`,
      { method: "GET", signal, headers: { [GUARD_HEADER]: "1" } },
      options.refresh ? 60_000 : 5_000,
      fetchImpl,
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
  let parsed: { code?: string; message?: string; detail?: string; hint?: string } = {};
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
  return new AiError(code, message, { detail: parsed.detail, hint: parsed.hint });
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

/* -------------------------------------------------------------------- jobs */

/**
 * generate() runs as a host job (POST /api/ai/v1/jobs, then polling), so a
 * page load does not lose the run: with a `jobKey` the next page finds the
 * same job by its meta.key and waits for it instead of starting a new one.
 * The host enforces the idle and overall time limits; this side has none.
 */

export type HostJobStatus = "queued" | "running" | "done" | "failed" | "cancelled" | "interrupted";

export type HostJob = {
  id: string;
  kind: string;
  lane: string;
  label: string;
  meta: unknown;
  status: HostJobStatus;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  lastActivityAt: number | null;
  chars: number;
  text?: string;
  partialText?: string;
  error?: { code: string; message?: string; hint?: string; detail?: string } | null;
};

/** What a host client needs from its surroundings; tests replace these. */
export type HostClientDeps = {
  fetch?: typeof fetch;
  hosted?: () => boolean;
  now?: () => number;
  /** Rejects with an AbortError-like error when `signal` aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** How often a running job is polled. */
  pollMs?: number;
  /** How many failed polls in a row are tolerated before giving up. */
  pollRetries?: number;
};

/** The meta.key of one attempt (repair round) of a keyed call. */
export const jobKeyFor = (key: string, round: number) => `${key}#${round}`;

/** How many times `"field":` occurs in (possibly unfinished) JSON text: a rough count of items written so far. */
export function countItems(partialText: string | undefined, field: string): number {
  if (!partialText) return 0;
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return partialText.match(new RegExp(`"${escaped}"\\s*:`, "g"))?.length ?? 0;
}

const KNOWN_CODES: Record<string, AiError["code"]> = {
  cli_not_found: "cli_not_found",
  cli_not_authenticated: "cli_not_authenticated",
  cli_incompatible: "cli_incompatible",
  timeout: "timeout",
  rate_limited: "rate_limited",
};

/** The AiError a finished, unsuccessful job stands for. */
export function mapJobError(job: Pick<HostJob, "status" | "error">): AiError {
  if (job.status === "cancelled") return new AiError("aborted", "Cancelled.");
  if (job.status === "interrupted")
    return new AiError("unknown", "Study Hub was closed while your assistant was working.", {
      hint: "Retry to run it again.",
    });
  const error = job.error ?? null;
  const code = error?.code && KNOWN_CODES[error.code] ? KNOWN_CODES[error.code] : "unknown";
  return new AiError(code, error?.message || "Your assistant stopped without an answer.", {
    hint: error?.hint,
    detail: error?.detail,
  });
}

const abortError = () => new AiError("aborted", "Cancelled.");

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const LOST_HOST = () =>
  new AiError("host_unavailable", "Lost contact with Study Hub's built-in connection.", {
    hint: "Check Study Hub is still open, then retry.",
  });

type JobRun = {
  provider: ProviderId;
  prompt: string;
  model?: string;
  background?: boolean;
  label?: string;
  /** meta.key, when the call can be reattached to. */
  key?: string;
  signal?: AbortSignal;
  onProgress?: GenerateRequest["onProgress"];
};

/** A request that never reached the host (as opposed to an HTTP error from it). */
class Unreachable extends Error {}

function jobRunner(deps: Required<Pick<HostClientDeps, "fetch" | "now" | "sleep" | "pollMs" | "pollRetries">>) {
  const headers = { [GUARD_HEADER]: "1" };

  /** One JSON request; a network failure throws Unreachable so callers can tell it from an HTTP error. */
  async function request<T>(method: string, path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    let response: Response;
    try {
      response = await deps.fetch(`${BASE}${path}`, {
        method,
        signal,
        headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      if (signal?.aborted) throw abortError();
      throw new Unreachable("unreachable");
    }
    if (response.status === 404 && path.startsWith("/v1/jobs/"))
      throw new AiError("unknown", "Study Hub lost track of this run.", { hint: "Retry to run it again." });
    if (!response.ok) throw classify(response.status, await response.text().catch(() => ""));
    return (await response.json()) as T;
  }

  /** A GET that rides out a few network failures in a row. */
  async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
    for (let failures = 0; ; failures++) {
      try {
        return await request<T>("GET", path, undefined, signal);
      } catch (error) {
        if (!(error instanceof Unreachable)) throw error;
        if (failures >= deps.pollRetries) throw LOST_HOST();
        await deps.sleep(deps.pollMs, signal);
      }
    }
  }

  async function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    try {
      return await request<T>("POST", path, body, signal);
    } catch (error) {
      throw error instanceof Unreachable ? LOST_HOST() : error;
    }
  }

  /** Newest reattachable job carrying this key. */
  async function findByKey(key: string, signal?: AbortSignal): Promise<HostJob | null> {
    const { jobs } = await get<{ jobs: HostJob[] }>("/v1/jobs", signal);
    const matches = (Array.isArray(jobs) ? jobs : []).filter(
      (job) =>
        job?.meta !== null &&
        typeof job?.meta === "object" &&
        (job.meta as { key?: unknown }).key === key &&
        (job.status === "queued" || job.status === "running" || job.status === "done"),
    );
    matches.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    return matches[0] ?? null;
  }

  return async function run(spec: JobRun): Promise<string> {
    const { signal, onProgress } = spec;
    if (signal?.aborted) throw abortError();
    let job: HostJob | null = null;
    try {
      if (spec.key) job = await findByKey(spec.key, signal);
      if (!job) {
        const created = await post<{ job: HostJob }>(
          "/v1/jobs",
          {
            provider: spec.provider,
            prompt: spec.prompt,
            model: spec.model || undefined,
            background: spec.background || undefined,
            label: spec.label || undefined,
            meta: spec.key ? { key: spec.key } : undefined,
          },
          signal,
        );
        job = created.job;
      }
      if (!job?.id) throw new AiError("unknown", "Study Hub did not start the run.");

      for (;;) {
        if (job.status === "done") {
          if (typeof job.text === "string") return job.text;
          job = (await get<{ job: HostJob }>(`/v1/jobs/${encodeURIComponent(job.id)}`, signal)).job;
          if (job.status === "done") return String(job.text ?? "");
          continue;
        }
        if (job.status === "failed" || job.status === "interrupted" || job.status === "cancelled") throw mapJobError(job);

        const elapsedMs = Math.max(0, deps.now() - (job.startedAt ?? job.createdAt ?? deps.now()));
        const text = job.partialText ?? "";
        if (job.status === "running" && (text || job.chars > 0))
          onProgress?.({ phase: "streaming", chars: text.length || job.chars, text, elapsedMs });
        else onProgress?.({ phase: "connecting", elapsedMs });

        await deps.sleep(deps.pollMs, signal);
        job = (await get<{ job: HostJob }>(`/v1/jobs/${encodeURIComponent(job.id)}?partial=1`, signal)).job;
      }
    } catch (error) {
      if (signal?.aborted) {
        if (job?.id)
          await request("DELETE", `/v1/jobs/${encodeURIComponent(job.id)}`, undefined).catch(() => undefined);
        throw abortError();
      }
      throw error instanceof Unreachable ? LOST_HOST() : error;
    }
  };
}

/** `background` marks automatic runs, which the host keeps out of the student's way. */
export function createHostClient(
  provider: ProviderId,
  modelOverride: string,
  options: { background?: boolean } & HostClientDeps = {},
): AiClient {
  const fetchImpl: typeof fetch = options.fetch ?? ((...args) => fetch(...args));
  const hosted = options.hosted ?? isHosted;
  const runJob = jobRunner({
    fetch: fetchImpl,
    now: options.now ?? Date.now,
    sleep: options.sleep ?? defaultSleep,
    pollMs: options.pollMs ?? 1_000,
    pollRetries: options.pollRetries ?? 4,
  });
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
      await discoverWith(generateRequest.signal, {}, hosted, fetchImpl);

      let round = -1;
      const result = await withRepair<T>(generateRequest, async (messages) => {
        round++;
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

        const text = await runJob({
          provider,
          prompt,
          model: modelOverride || undefined,
          background: options.background,
          label: generateRequest.label,
          key: generateRequest.jobKey ? jobKeyFor(generateRequest.jobKey, round) : undefined,
          signal: generateRequest.signal,
          onProgress: generateRequest.onProgress,
        });
        generateRequest.onProgress?.({ phase: "streaming", chars: text.length, text });
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

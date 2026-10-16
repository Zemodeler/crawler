/**
 * Google OAuth 2.0 for installed apps: PKCE (S256), the system browser and a
 * one-shot loopback redirect on 127.0.0.1. Design: docs/design/05.
 *
 * `authorize` yields the refresh token, which the caller stores (OS credential
 * store in the app); `accessTokenFrom` turns it into short-lived access tokens,
 * cached in memory until shortly before they expire. The browser and fetch are
 * injected. No token ever appears in an error message.
 */

import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const DEFAULT_SCOPES = ["https://www.googleapis.com/auth/calendar.app.created"];

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
/** An access token is treated as expired this long before Google says it is. */
const EXPIRY_MARGIN_MS = 60_000;

export class GoogleAuthError extends Error {
  readonly code: "denied" | "state-mismatch" | "timeout" | "revoked" | "no-token" | "bad-response";
  constructor(code: GoogleAuthError["code"], message: string) {
    super(message);
    this.name = "GoogleAuthError";
    this.code = code;
  }
}

export type OAuthClientDeps = { clientId: string; clientSecret?: string; fetch?: typeof fetch };

export type AuthorizeDeps = OAuthClientDeps & {
  openBrowser(url: string): Promise<void>;
  scopes?: string[];
  /** How long to wait for the browser to come back. Default 5 minutes. */
  timeoutMs?: number;
};

/* --------------------------------------------------------- authorize */

export async function authorize(deps: AuthorizeDeps): Promise<{ refreshToken: string }> {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = base64url(randomBytes(16));

  const { redirectUri, code } = await receiveCode(deps, state, challenge);

  const body = tokenParams(deps, {
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
  });
  const json = await postToken(deps, body);
  if (typeof json.refresh_token !== "string" || json.refresh_token === "") {
    throw new GoogleAuthError("bad-response", "Google did not return a refresh token");
  }
  if (typeof json.access_token === "string" && typeof json.expires_in === "number") {
    cache.set(cacheKey(deps.clientId, json.refresh_token), {
      token: json.access_token,
      expiresAt: Date.now() + json.expires_in * 1000 - EXPIRY_MARGIN_MS,
    });
  }
  return { refreshToken: json.refresh_token };
}

/** Starts the loopback server, sends the browser to Google, waits for the redirect. */
function receiveCode(
  deps: AuthorizeDeps,
  state: string,
  challenge: string,
): Promise<{ redirectUri: string; code: string }> {
  return new Promise((resolve, reject) => {
    let redirectUri = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (settled || url.pathname !== "/") {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
        return;
      }
      const params = url.searchParams;
      if (params.get("state") !== state) {
        page(res, 400, "Sign-in failed: this response did not come from Crawler's request. Close this tab and try again.");
        finish(new GoogleAuthError("state-mismatch", "OAuth redirect had a missing or wrong state"));
        return;
      }
      const error = params.get("error");
      if (error !== null) {
        page(res, 400, "Sign-in was cancelled. You can close this tab.");
        finish(new GoogleAuthError("denied", `Google sign-in failed: ${error}`));
        return;
      }
      const code = params.get("code");
      if (code === null || code === "") {
        page(res, 400, "Sign-in failed: Google sent no code. Close this tab and try again.");
        finish(new GoogleAuthError("bad-response", "OAuth redirect had no code"));
        return;
      }
      page(res, 200, "Crawler is connected to Google Calendar. You can close this tab.");
      finish(null, code);
    });

    function finish(err: Error | null, code?: string): void {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      // The answering socket closes itself once its page is sent (connection: close).
      server.close();
      server.closeIdleConnections();
      if (err !== null) reject(err);
      else resolve({ redirectUri, code: code ?? "" });
    }

    server.on("error", (err) => finish(err));
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      redirectUri = `http://127.0.0.1:${port}`;
      timer = setTimeout(
        () => finish(new GoogleAuthError("timeout", "Timed out waiting for Google sign-in")),
        deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
      const url = new URL(AUTH_URL);
      url.search = new URLSearchParams({
        client_id: deps.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: (deps.scopes ?? DEFAULT_SCOPES).join(" "),
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
        access_type: "offline",
        prompt: "consent",
      }).toString();
      deps.openBrowser(url.toString()).catch((err: unknown) => finish(err instanceof Error ? err : new Error(String(err))));
    });
  });
}

function page(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", connection: "close" });
  res.end(`<!doctype html><meta charset="utf-8"><title>Crawler</title><p>${message}</p>`);
}

/* --------------------------------------------------- access tokens */

type CachedToken = { token: string; expiresAt: number };
const cache = new Map<string, CachedToken>();
const inFlight = new Map<string, Promise<string>>();

/** An access token for `refreshToken`, from the cache while it is still fresh. */
export async function accessTokenFrom(deps: OAuthClientDeps, refreshToken: string): Promise<string> {
  const key = cacheKey(deps.clientId, refreshToken);
  const cached = cache.get(key);
  if (cached !== undefined && cached.expiresAt > Date.now()) return cached.token;
  const pending = inFlight.get(key);
  if (pending !== undefined) return pending;

  const request = (async () => {
    try {
      const json = await postToken(deps, tokenParams(deps, { grant_type: "refresh_token", refresh_token: refreshToken }));
      if (typeof json.access_token !== "string" || typeof json.expires_in !== "number") {
        throw new GoogleAuthError("bad-response", "Google's token response had no access token");
      }
      cache.set(key, { token: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 - EXPIRY_MARGIN_MS });
      return json.access_token;
    } catch (err) {
      cache.delete(key);
      throw err;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, request);
  return request;
}

/** Drops the cached access token, e.g. after the API answered 401. */
export function forgetAccessToken(clientId: string, refreshToken: string): void {
  cache.delete(cacheKey(clientId, refreshToken));
}

/** Keyed by a hash so the map never holds the refresh token itself. */
function cacheKey(clientId: string, refreshToken: string): string {
  return createHash("sha256").update(clientId).update("\0").update(refreshToken).digest("hex");
}

/* ----------------------------------------------------- token endpoint */

type TokenResponse = {
  access_token?: unknown;
  expires_in?: unknown;
  refresh_token?: unknown;
  error?: unknown;
  error_description?: unknown;
};

function tokenParams(deps: OAuthClientDeps, params: Record<string, string>): URLSearchParams {
  const body = new URLSearchParams({ client_id: deps.clientId, ...params });
  if (deps.clientSecret !== undefined) body.set("client_secret", deps.clientSecret);
  return body;
}

async function postToken(deps: OAuthClientDeps, body: URLSearchParams): Promise<TokenResponse> {
  const doFetch = deps.fetch ?? fetch;
  const res = await doFetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: body.toString(),
  });
  let json: TokenResponse;
  try {
    json = (await res.json()) as TokenResponse;
  } catch {
    throw new GoogleAuthError("bad-response", `Google's token endpoint answered ${res.status} without JSON`);
  }
  if (json === null || typeof json !== "object") {
    throw new GoogleAuthError("bad-response", `Google's token endpoint answered ${res.status} without JSON`);
  }
  if (!res.ok || json.error !== undefined) {
    const error = typeof json.error === "string" ? json.error : `HTTP ${res.status}`;
    if (error === "invalid_grant") {
      throw new GoogleAuthError("revoked", "Google access was revoked or expired; sign in to Google again");
    }
    const detail = typeof json.error_description === "string" ? `: ${json.error_description}` : "";
    throw new GoogleAuthError("bad-response", `Google's token endpoint refused the request (${error}${detail})`);
  }
  return json;
}

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

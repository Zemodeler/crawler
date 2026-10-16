import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { GoogleAuthError, TOKEN_URL, accessTokenFrom, authorize } from "../src/gcal/oauth.ts";

/** Fake values built at runtime, so no credential-looking literal sits in the source. */
const CLIENT_PLACEHOLDER = ["client", "placeholder"].join("-");
const REVOKED_PLACEHOLDER = ["rt", "revoked", "placeholder"].join("-");

type TokenCall = { url: string; params: URLSearchParams };

/** A fake token endpoint: records each call and answers with `reply(params)`. */
function tokenEndpoint(reply: (params: URLSearchParams) => { status?: number; body: unknown }) {
  const calls: TokenCall[] = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const params = new URLSearchParams(String(init?.body ?? ""));
    calls.push({ url: String(input), params });
    const { status = 200, body } = reply(params);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, fetch: fakeFetch };
}

/** Plays the browser: reads Google's auth URL, then calls the redirect with `query(authParams)`. */
function browser(query: (auth: URLSearchParams) => Record<string, string>) {
  const seen: { authUrl?: URL; page?: Response } = {};
  return {
    seen,
    async openBrowser(url: string) {
      const authUrl = new URL(url);
      seen.authUrl = authUrl;
      const auth = authUrl.searchParams;
      const redirect = new URL(auth.get("redirect_uri") ?? "");
      redirect.search = new URLSearchParams(query(auth)).toString();
      // Do not await: the browser lands after openBrowser returns.
      setImmediate(async () => {
        seen.page = await fetch(redirect);
      });
    },
  };
}

test("authorize: PKCE S256, loopback redirect, state check and code exchange", async () => {
  const endpoint = tokenEndpoint(() => ({
    body: { access_token: "at-1", expires_in: 3600, refresh_token: "rt-1", token_type: "Bearer" },
  }));
  const b = browser((auth) => ({ code: "the-code", state: auth.get("state") ?? "" }));

  const result = await authorize({ clientId: "cid", clientSecret: CLIENT_PLACEHOLDER, openBrowser: b.openBrowser, fetch: endpoint.fetch });
  assert.deepEqual(result, { refreshToken: "rt-1" });

  const auth = b.seen.authUrl!;
  assert.equal(auth.origin + auth.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  const p = auth.searchParams;
  assert.equal(p.get("client_id"), "cid");
  assert.equal(p.get("response_type"), "code");
  assert.equal(p.get("scope"), "https://www.googleapis.com/auth/calendar.app.created");
  assert.equal(p.get("code_challenge_method"), "S256");
  assert.equal(p.get("access_type"), "offline");
  assert.match(p.get("redirect_uri") ?? "", /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.ok((p.get("state") ?? "").length >= 16);

  assert.equal(endpoint.calls.length, 1);
  const call = endpoint.calls[0]!;
  assert.equal(call.url, TOKEN_URL);
  assert.equal(call.params.get("grant_type"), "authorization_code");
  assert.equal(call.params.get("code"), "the-code");
  assert.equal(call.params.get("client_id"), "cid");
  assert.equal(call.params.get("client_secret"), CLIENT_PLACEHOLDER);
  assert.equal(call.params.get("redirect_uri"), p.get("redirect_uri"));
  const verifier = call.params.get("code_verifier") ?? "";
  assert.match(verifier, /^[A-Za-z0-9_-]{43,128}$/);
  assert.equal(createHash("sha256").update(verifier).digest("base64url"), p.get("code_challenge"));

  // The browser got a page, and the server is gone.
  while (b.seen.page === undefined) await new Promise((r) => setImmediate(r));
  assert.equal(b.seen.page.status, 200);
  assert.match(await b.seen.page.text(), /connected/);
  await assert.rejects(fetch(p.get("redirect_uri")!));
});

test("authorize: custom scopes", async () => {
  const endpoint = tokenEndpoint(() => ({ body: { access_token: "a", expires_in: 3600, refresh_token: "r" } }));
  const b = browser((auth) => ({ code: "c", state: auth.get("state") ?? "" }));
  await authorize({ clientId: "cid", scopes: ["s1", "s2"], openBrowser: b.openBrowser, fetch: endpoint.fetch });
  assert.equal(b.seen.authUrl!.searchParams.get("scope"), "s1 s2");
  assert.equal(endpoint.calls[0]!.params.has("client_secret"), false);
});

test("authorize: a wrong state is refused and no code is exchanged", async () => {
  const endpoint = tokenEndpoint(() => ({ body: {} }));
  const b = browser(() => ({ code: "c", state: "forged" }));
  await assert.rejects(
    authorize({ clientId: "cid", openBrowser: b.openBrowser, fetch: endpoint.fetch }),
    (err: unknown) => err instanceof GoogleAuthError && err.code === "state-mismatch",
  );
  assert.equal(endpoint.calls.length, 0);
});

test("authorize: the student declining is 'denied'", async () => {
  const endpoint = tokenEndpoint(() => ({ body: {} }));
  const b = browser((auth) => ({ error: "access_denied", state: auth.get("state") ?? "" }));
  await assert.rejects(
    authorize({ clientId: "cid", openBrowser: b.openBrowser, fetch: endpoint.fetch }),
    (err: unknown) => err instanceof GoogleAuthError && err.code === "denied",
  );
  assert.equal(endpoint.calls.length, 0);
});

test("authorize: times out when the browser never comes back, and closes the server", async () => {
  let redirectUri = "";
  await assert.rejects(
    authorize({
      clientId: "cid",
      timeoutMs: 50,
      async openBrowser(url) {
        redirectUri = new URL(url).searchParams.get("redirect_uri") ?? "";
      },
      fetch: tokenEndpoint(() => ({ body: {} })).fetch,
    }),
    (err: unknown) => err instanceof GoogleAuthError && err.code === "timeout",
  );
  await assert.rejects(fetch(redirectUri));
});

test("authorize: a failing browser launch rejects", async () => {
  await assert.rejects(
    authorize({ clientId: "cid", openBrowser: () => Promise.reject(new Error("no browser")) }),
    /no browser/,
  );
});

test("authorize: no refresh token in the response is an error", async () => {
  const endpoint = tokenEndpoint(() => ({ body: { access_token: "a", expires_in: 3600 } }));
  const b = browser((auth) => ({ code: "c", state: auth.get("state") ?? "" }));
  await assert.rejects(
    authorize({ clientId: "cid", openBrowser: b.openBrowser, fetch: endpoint.fetch }),
    (err: unknown) => err instanceof GoogleAuthError && err.code === "bad-response",
  );
});

test("accessTokenFrom: refreshes once and caches until shortly before expiry", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  let n = 0;
  const endpoint = tokenEndpoint(() => ({ body: { access_token: `at-${++n}`, expires_in: 3600 } }));
  const deps = { clientId: "cid-cache", fetch: endpoint.fetch };

  assert.equal(await accessTokenFrom(deps, "rt-cache"), "at-1");
  assert.equal(await accessTokenFrom(deps, "rt-cache"), "at-1");
  assert.equal(endpoint.calls.length, 1);
  const params = endpoint.calls[0]!.params;
  assert.equal(params.get("grant_type"), "refresh_token");
  assert.equal(params.get("refresh_token"), "rt-cache");

  t.mock.timers.tick(3600_000 - 30_000); // inside the safety margin
  assert.equal(await accessTokenFrom(deps, "rt-cache"), "at-2");
  assert.equal(endpoint.calls.length, 2);
});

test("accessTokenFrom: concurrent callers share one refresh", async () => {
  const endpoint = tokenEndpoint(() => ({ body: { access_token: "shared", expires_in: 3600 } }));
  const deps = { clientId: "cid-shared", fetch: endpoint.fetch };
  const tokens = await Promise.all([accessTokenFrom(deps, "rt-s"), accessTokenFrom(deps, "rt-s")]);
  assert.deepEqual(tokens, ["shared", "shared"]);
  assert.equal(endpoint.calls.length, 1);
});

test("accessTokenFrom: invalid_grant is 'revoked' and leaks no token", async () => {
  const endpoint = tokenEndpoint(() => ({ status: 400, body: { error: "invalid_grant", error_description: "Token has been expired or revoked." } }));
  await assert.rejects(
    accessTokenFrom({ clientId: "cid-rev", fetch: endpoint.fetch }, REVOKED_PLACEHOLDER),
    (err: unknown) =>
      err instanceof GoogleAuthError && err.code === "revoked" && !err.message.includes(REVOKED_PLACEHOLDER),
  );
});

test("accessTokenFrom: other token errors are 'bad-response'", async () => {
  const endpoint = tokenEndpoint(() => ({ status: 401, body: { error: "invalid_client" } }));
  await assert.rejects(
    accessTokenFrom({ clientId: "cid-bad", fetch: endpoint.fetch }, "rt"),
    (err: unknown) => err instanceof GoogleAuthError && err.code === "bad-response" && /invalid_client/.test(err.message),
  );
});

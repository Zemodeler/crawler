import assert from "node:assert/strict";
import { test } from "node:test";

import { createBrightspaceAdapter } from "../src/adapters/brightspace.ts";

test("brightspace keeps cookies the site renews and hands them back for saving", async () => {
  const sent: string[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    sent.push(String((init.headers as Record<string, string>).cookie));
    const headers = new Headers({ "content-type": "application/json" });
    if (String(url).includes("/versions/")) {
      headers.append("set-cookie", "d2lSessionVal=renewed; path=/; HttpOnly");
      headers.append("set-cookie", "gone=; expires=Thu, 01 Jan 1970 00:00:00 GMT");
      return new Response(JSON.stringify([
        { ProductCode: "lp", LatestVersion: "1.47", SupportedVersions: ["1.47"] },
        { ProductCode: "le", LatestVersion: "1.74", SupportedVersions: ["1.74"] },
      ]), { headers });
    }
    return new Response(JSON.stringify({ Identifier: "42" }), { headers });
  }) as typeof globalThis.fetch;
  const adapter = createBrightspaceAdapter({ id: "surrey", displayName: "Surrey", site: "https://learn.example" }, { fetch });
  const credentials = { site: "https://learn.example", token: "", privateToken: null, cookies: "d2lSessionVal=old; d2lSecureSessionVal=keep; gone=1" };

  assert.equal((await adapter.whoAmI(credentials)).userId, 42);
  assert.equal(sent.at(-1), "d2lSessionVal=renewed; d2lSecureSessionVal=keep; gone=1");
  await adapter.whoAmI(credentials);
  assert.equal(credentials.cookies, "d2lSessionVal=renewed; d2lSecureSessionVal=keep; gone=1");
});

/**
 * Source-level guards.
 *
 * These are greps, not behaviour tests — `tests/course-format.test.mjs` holds the
 * real unit tests. What they protect is a set of invariants that are easy to
 * break silently in a refactor and expensive to discover later: that the old
 * OAuth relay is really gone, that an API key can only ever reach the provider,
 * that the desktop host cannot touch your files, and that the writer cannot
 * overwrite anything.
 */

import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

/**
 * Negative assertions are about the code, not the prose around it. These files
 * document what they deliberately never send — "no temperature, no top_k",
 * "binds 127.0.0.1, never 0.0.0.0" — and a naive grep flags the explanation
 * as if it were the violation.
 */
const code = async (path) =>
  (await read(path)).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const gone = async (path) => {
  try {
    await access(new URL(path, import.meta.url));
    return false;
  } catch {
    return true;
  }
};

test("study hub exposes the requested learning experience", async () => {
  const page = await read("../app/page.tsx");
  assert.match(page, /confidence <= 2/);
  assert.doesNotMatch(page, /Tomorrow|3 days|6 hours/);
  assert.match(page, /setQuery\(""\);\s*openFile/);
  assert.match(page, /overallPackProgress/);
  assert.match(page, /packProgress\(pack\)/);
  assert.match(page, /Source materials/);
  assert.match(page, /Saved locally/);
  assert.match(page, /className="flashcards-link" href="\/flashcards\?mode=smart"/);
  assert.match(page, /className="metric-link"/);

  // The AI entry points replaced the old /ai page.
  assert.match(page, /className="ai-button" href="\/connect"/);
  assert.match(page, /className="convert-link" href="\/generate"/);
  assert.doesNotMatch(page, /href="\/ai"|\/api\/me|oai-authenticated/);

  // Topics group on the canonical key, which is what stops "Offer & Acceptance"
  // and "Offer and Acceptance" showing up as two topics with no cards.
  assert.match(page, /canonicalTopicKey/);
});

test("the old OAuth relay and polling companion are fully removed", async () => {
  for (const path of [
    "../lib/oauth.ts",
    "../lib/study-hub-instructions.ts",
    "../app/api/mcp/route.ts",
    "../app/api/companion/jobs/route.ts",
    "../app/api/me/route.ts",
    "../app/chatgpt-auth.ts",
    "../app/ai/page.tsx",
    "../app/account/page.tsx",
    "../app/oauth/token/route.ts",
    "../app/oauth/authorize/route.ts",
    "../app/oauth/device/page.tsx",
    "../app/.well-known/oauth-authorization-server/route.ts",
    "../companion/index.mjs",
    "../db/schema.ts",
    "../drizzle.config.ts",
    "../public/study-hub-companion.zip",
    "../AI.md",
  ])
    assert.ok(await gone(path), `${path} should have been deleted`);

  // The D1 database and R2 bucket existed only to carry OAuth tokens and relay
  // jobs. With those gone the app needs no server-side storage at all.
  const hosting = JSON.parse(await read("../.openai/hosting.json"));
  assert.equal(hosting.d1, undefined);
  assert.equal(hosting.r2, undefined);

  const pkg = JSON.parse(await read("../package.json"));
  assert.equal(pkg.dependencies["drizzle-orm"], undefined);
  assert.equal(pkg.devDependencies["drizzle-kit"], undefined);
  assert.equal(pkg.scripts["db:generate"], undefined);

  const worker = await read("../worker/index.ts");
  assert.doesNotMatch(worker, /D1Database|relay_jobs|FILES/);
});

test("the provider layer covers both providers and never routes a key through us", async () => {
  const [types, provider, anthropic, openai, hostClient, models, structured, settings] = await Promise.all([
    read("../lib/ai/types.ts"),
    read("../lib/ai/provider.ts"),
    read("../lib/ai/anthropic.ts"),
    read("../lib/ai/openai.ts"),
    read("../lib/ai/host.ts"),
    read("../lib/ai/models.ts"),
    read("../lib/ai/structured.ts"),
    read("../lib/ai/settings.ts"),
  ]);

  assert.match(types, /interface AiClient/);
  assert.match(types, /generate<T>\(request: GenerateRequest\)/);
  assert.match(provider, /createAiClient/);
  assert.match(provider, /createAnthropicClient/);
  assert.match(provider, /createOpenAiClient/);
  assert.match(provider, /createHostClient/);

  // Anthropic: browser-direct, with the opt-in header, and none of the
  // parameters the current models reject with a 400.
  assert.match(anthropic, /https:\/\/api\.anthropic\.com\/v1/);
  assert.match(anthropic, /request\("\/messages"/);
  assert.match(anthropic, /anthropic-dangerous-direct-browser-access/);
  assert.match(anthropic, /anthropic-version/);
  assert.match(anthropic, /output_config/);
  assert.match(anthropic, /json_schema/);
  const anthropicCode = await code("../lib/ai/anthropic.ts");
  // The current models reject these with a 400.
  assert.doesNotMatch(anthropicCode, /temperature|top_p|top_k|budget_tokens/);
  // Disabling thinking can leak <thinking> tags into the text we are about to
  // parse as JSON, so it must never be sent either.
  assert.doesNotMatch(anthropicCode, /thinking/);

  // OpenAI's CORS policy allows exactly two request headers. Any other header
  // fails the preflight, and the failure looks like a network error.
  assert.match(openai, /https:\/\/api\.openai\.com\/v1/);
  assert.match(openai, /request\("\/responses"/);
  assert.match(openai, /authorization/i);
  assert.match(openai, /strict:\s*true/);
  const openaiCode = await code("../lib/ai/openai.ts");
  assert.doesNotMatch(openaiCode, /OpenAI-Beta|OpenAI-Organization/);

  // The key must never be posted to this app's own origin.
  for (const source of [anthropicCode, openaiCode])
    assert.doesNotMatch(source, /fetch\(\s*[`"']\/api\//);

  const pkg = JSON.parse(await read("../package.json"));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  for (const dep of ["@anthropic-ai/sdk", "openai", "ai", "@ai-sdk/react", "zod", "ajv"])
    assert.equal(deps[dep], undefined, `${dep} should not be a dependency`);

  // Subscription mode talks only to the host that served the page: no port
  // scanning, no pairing token, no cross-origin credentials.
  assert.match(hostClient, /x-study-hub-host/);
  assert.match(hostClient, /healthz/);
  assert.doesNotMatch(hostClient, /127\.0\.0\.1|localhost|pairing|PORT_RANGE/i);
  assert.doesNotMatch(hostClient, /credentials:\s*"include"/);

  // Pinned, undated model ids.
  assert.match(models, /claude-opus-5/);
  assert.match(models, /claude-sonnet-5/);
  assert.doesNotMatch(models, /claude-\w+-\d(-\d)?-2\d{7}/);
  // No OpenAI id is hardcoded — the picker is loaded from the user's account.
  assert.doesNotMatch(models, /"gpt-[\w.-]+"/);

  // Exactly one repair round-trip, never a loop.
  assert.match(structured, /MAX_REPAIRS\s*=\s*1/);

  // Keys default to the tab, never localStorage, and can always be forgotten.
  assert.match(settings, /sessionStorage/);
  assert.match(settings, /forgetKey/);
  assert.doesNotMatch(settings, /localStorage\.setItem\(\s*`?\$?\{?SESSION_KEY/);
});

test("the desktop host runs the CLI safely and answers only its own page", async () => {
  const [server, cli] = await Promise.all([read("../host/index.mjs"), read("../host/cli.mjs")]);
  const serverCode = await code("../host/index.mjs");
  const cliCode = await code("../host/cli.mjs");

  // Loopback only. Binding 0.0.0.0 would expose it to the whole network.
  assert.match(server, /listen\(port,\s*"127\.0\.0\.1"/);
  assert.doesNotMatch(serverCode, /0\.0\.0\.0/);
  assert.match(server, /hostIsLoopback/);
  assert.match(server, /originAllowed/);
  // A per-launch secret in an HttpOnly, SameSite=Strict cookie, compared in constant time.
  assert.match(server, /HttpOnly; SameSite=Strict/);
  assert.match(server, /timingSafeEqual/);
  // No CORS: the host never grants another origin anything.
  assert.doesNotMatch(serverCode, /access-control-allow-origin/i);

  // The CLI runner cannot write files and makes no requests of its own.
  assert.doesNotMatch(cliCode, /writeFile|createWriteStream|appendFile|copyFile/);
  assert.doesNotMatch(cliCode, /\bfetch\(|node:https|https\.request/);

  // Safe process spawning.
  assert.match(cli, /shell:\s*false/);
  assert.match(cli, /stdin\.end\(/);
  assert.match(cli, /mkdtempSync/);
  assert.match(cli, /delete env\.ANTHROPIC_API_KEY/);
  assert.match(cli, /delete env\.OPENAI_API_KEY/);
  assert.match(cli, /--disallowed-tools|--sandbox/);
  assert.match(cli, /kill\("SIGKILL"\)/);
  assert.match(cli, /claude/);
  assert.match(cli, /codex/);
});

test("the writer is create-only and confined to the course folder", async () => {
  const [fs, format] = await Promise.all([read("../lib/course-fs.ts"), read("../lib/course-format.ts")]);

  assert.match(fs, /createWritable/);
  assert.match(fs, /requestPermission\(\{ mode: "readwrite" \}\)/);
  assert.match(fs, /"pinned"/);
  // Nothing in the writer may ever delete or truncate a user's file.
  assert.doesNotMatch(fs, /removeEntry|truncate/);

  assert.match(format, /isWritablePath/);
  assert.match(format, /isSafeRelativePath/);
  assert.match(format, /WINDOWS_RESERVED/);
  assert.match(format, /WRITABLE_EXTS/);
});

test("the conversion pipeline stages everything before it writes anything", async () => {
  const [run, conversion, profiles] = await Promise.all([
    read("../lib/conversion-run.ts"),
    read("../lib/ai-conversion.ts"),
    read("../lib/subject-profiles.ts"),
  ]);

  // Staging lives in IndexedDB, so a preview needs no write permission and a
  // cancelled run leaves the folder byte-identical.
  assert.match(run, /idbPut\("runs"/);
  assert.match(run, /planDiff/);
  assert.match(run, /validateStaged/);
  // The hub is written last so a partial commit cannot leave dead links.
  assert.match(run, /if \(a\.path === SPEC\.hub\) return 1/);
  assert.match(run, /planCardMoves/);
  assert.match(run, /planCheckMoves/);

  // The model supplies prose only; code owns every path and heading.
  assert.match(conversion, /Never output a file path/);
  // The grounding rule is part of each subject profile's prompt wording.
  assert.match(profiles, /VERBATIM span/);
  assert.match(conversion, /checkGrounding/);
  assert.match(conversion, /unverified-quote/);
  assert.match(conversion, /untrusted_course_content/);
});

test("the single README documents the install and both login routes", async () => {
  const readme = await read("../README.md");
  for (const phrase of [
    "Claude",
    "ChatGPT",
    "API key",
    "subscription",
    "desktop app",
    "My Studies",
    "127.0.0.1",
    "Chrome",
    "never overwritten",
    "pnpm install",
  ])
    assert.match(readme, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), `README should mention ${phrase}`);

  // The old architecture must not be described as if it still exists. "OAuth" is
  // allowed: the README explains that no OAuth flow exists for subscriptions,
  // which is precisely why the desktop app runs the CLI.
  assert.doesNotMatch(readme, /device code|relay job|\bcompanion\b|vinext-starter|MCP server|pairing code|Setup\.exe/i);

  // Exactly one markdown file ships with the project.
  for (const path of ["../AI.md", "../launcher", "../bridge", "../build/pack-bridge.mjs", "../companion/README.md"])
    assert.ok(await gone(path), `${path} should have been deleted`);
});

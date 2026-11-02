import assert from "node:assert/strict";
import test from "node:test";

import { countItems, createHostClient, jobKeyFor, mapJobError } from "../lib/ai/host.ts";
import { AiError } from "../lib/ai/types.ts";

const SCHEMA = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
  additionalProperties: false,
};

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * A pretend host. Each job carries `steps`: every GET of that job applies the
 * next one, so a test scripts what a run looks like poll by poll.
 */
function fakeHost({ jobs = [], steps = () => [], failGets = 0 } = {}) {
  const calls = [];
  let nextId = 1;
  let failures = failGets;
  const all = jobs.map((job) => ({ steps: [], ...job }));
  const visible = (job, partial) => {
    const out = { ...job };
    const { partialText, text } = job;
    delete out.steps;
    delete out.partialText;
    delete out.text;
    if (job.status === "done") out.text = text;
    if (partial && job.status !== "done" && partialText !== undefined) out.partialText = partialText;
    return out;
  };
  async function fetch(url, init = {}) {
    const method = init.method || "GET";
    calls.push({ method, url, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers });
    if (url.startsWith("/api/ai/healthz"))
      return json(200, { name: "study-hub-host", version: "1", clis: { claude: { present: true, version: "2" }, codex: { present: false, version: null } } });
    if (url === "/api/ai/v1/jobs" && method === "GET")
      return json(200, { jobs: all.map((job) => { const out = visible(job, false); delete out.text; return out; }) });
    if (url === "/api/ai/v1/jobs" && method === "POST") {
      const body = JSON.parse(init.body);
      const job = {
        id: `job-${String(nextId++).padStart(8, "0")}`, kind: "claude", lane: body.background ? "background" : "foreground",
        label: body.label ?? "", meta: body.meta ?? null, status: "queued", createdAt: 1_000, startedAt: null, endedAt: null,
        lastActivityAt: null, chars: 0, steps: steps(body, all.length),
      };
      all.push(job);
      return json(202, { job: visible(job, false) });
    }
    const match = url.match(/^\/api\/ai\/v1\/jobs\/([^?]+)(\?partial=1)?$/);
    const job = match && all.find((j) => j.id === decodeURIComponent(match[1]));
    if (!job) return json(404, { code: "not_found", message: "No such job." });
    if (method === "DELETE") {
      if (job.status === "queued" || job.status === "running") Object.assign(job, { status: "cancelled", endedAt: 9_000 });
      return json(200, { job: visible(job, false) });
    }
    if (failures > 0) {
      failures--;
      throw new TypeError("fetch failed");
    }
    if (job.steps.length) Object.assign(job, job.steps.shift());
    return json(200, { job: visible(job, Boolean(match[2])) });
  }
  return { fetch, calls, jobs: all };
}

function client(host, extra = {}) {
  return createHostClient("anthropic", "", {
    fetch: host.fetch,
    hosted: () => true,
    now: () => 5_000,
    sleep: async (_ms, signal) => {
      if (signal?.aborted) throw new AiError("aborted", "Cancelled.");
    },
    pollMs: 0,
    ...extra,
  });
}

const request = (over = {}) => ({
  system: "Answer.",
  messages: [{ role: "user", content: "Question?" }],
  schema: SCHEMA,
  schemaName: "answer",
  ...over,
});

const RUN_THEN_DONE = () => [
  { status: "running", startedAt: 2_000, chars: 5, partialText: '{"ans' },
  { status: "done", endedAt: 6_000, text: '{"answer":"hi"}', chars: 15 },
];

test("generate starts a job with its key and label, polls it and reports the text so far", async () => {
  const host = fakeHost({ steps: RUN_THEN_DONE });
  const progress = [];
  const result = await client(host, { background: true }).generate(
    request({ jobKey: "task-1:b2", label: "Week 3 (part 2 of 3)", onProgress: (p) => progress.push(p) }),
  );
  assert.deepEqual(result.data, { answer: "hi" });
  assert.equal(result.transport, "subscription");

  const post = host.calls.find((c) => c.method === "POST");
  assert.equal(post.url, "/api/ai/v1/jobs");
  assert.deepEqual(post.body.meta, { key: "task-1:b2#0" });
  assert.equal(post.body.label, "Week 3 (part 2 of 3)");
  assert.equal(post.body.provider, "anthropic");
  assert.equal(post.body.background, true);
  assert.match(post.body.prompt, /Question\?/);
  assert.equal(post.headers["x-study-hub-host"], "1");
  assert.ok(host.calls.some((c) => c.url === "/api/ai/v1/jobs" && c.method === "GET"), "looks for a job to reattach to first");
  assert.ok(host.calls.some((c) => /\/v1\/jobs\/job-00000001\?partial=1$/.test(c.url)), "polls with partial text");
  assert.ok(!host.calls.some((c) => c.url.includes("/v1/generate")), "the single long POST is no longer used");

  assert.deepEqual(progress[0], { phase: "connecting" });
  assert.deepEqual(progress[1], { phase: "connecting", elapsedMs: 4_000 }, "queued: time since it was created");
  assert.deepEqual(progress[2], { phase: "streaming", chars: 5, text: '{"ans', elapsedMs: 3_000 }, "running: time since it started");
  assert.deepEqual(progress.at(-2), { phase: "streaming", chars: 15, text: '{"answer":"hi"}' });
  assert.deepEqual(progress.at(-1), { phase: "validating" });
});

test("without a jobKey nothing is looked up and the job has no meta", async () => {
  const host = fakeHost({ steps: RUN_THEN_DONE });
  await client(host).generate(request());
  assert.ok(!host.calls.some((c) => c.url === "/api/ai/v1/jobs" && c.method === "GET"));
  assert.equal(host.calls.find((c) => c.method === "POST").body.meta, undefined);
});

test("a keyed call reattaches to the newest running job with that key instead of starting one", async () => {
  const host = fakeHost({
    jobs: [
      { id: "job-old-failed", meta: { key: "k:b1#0" }, status: "failed", createdAt: 3_000, startedAt: 3_000, chars: 0, error: { code: "timeout" } },
      { id: "job-running-1", meta: { key: "k:b1#0" }, status: "running", createdAt: 2_000, startedAt: 2_500, chars: 3, partialText: '{"a',
        steps: [{ status: "done", text: '{"answer":"again"}' }] },
      { id: "job-other-key", meta: { key: "k:b2#0" }, status: "running", createdAt: 4_000, startedAt: 4_000, chars: 0 },
    ],
  });
  const progress = [];
  const result = await client(host).generate(request({ jobKey: "k:b1", onProgress: (p) => progress.push(p) }));
  assert.deepEqual(result.data, { answer: "again" });
  assert.ok(!host.calls.some((c) => c.method === "POST"), "no new job");
  assert.ok(host.calls.every((c) => !c.url.includes("job-other-key") && !c.url.includes("job-old-failed")));
  assert.deepEqual(progress[1], { phase: "streaming", chars: 3, text: "", elapsedMs: 2_500 }, "a reattached running job reports its progress straight away");
});

test("a keyed call whose job already finished uses its text without waiting", async () => {
  const host = fakeHost({
    jobs: [{ id: "job-finished", meta: { key: "k:b1#0" }, status: "done", createdAt: 1_000, chars: 18, text: '{"answer":"done"}' }],
  });
  let slept = 0;
  const result = await client(host, { sleep: async () => { slept++; } }).generate(request({ jobKey: "k:b1" }));
  assert.deepEqual(result.data, { answer: "done" });
  assert.equal(slept, 0);
  assert.ok(!host.calls.some((c) => c.method === "POST"));
  assert.ok(host.calls.some((c) => c.method === "GET" && c.url === "/api/ai/v1/jobs/job-finished"), "fetches the text, which the list leaves out");
});

test("a repair round runs as its own job, keyed #1", async () => {
  const host = fakeHost({
    steps: (_body, n) => [{ status: "done", text: n === 0 ? '{"wrong":1}' : '{"answer":"fixed"}' }],
  });
  const result = await client(host).generate(request({ jobKey: "k:b1" }));
  assert.deepEqual(result.data, { answer: "fixed" });
  assert.equal(result.repaired, true);
  assert.deepEqual(host.calls.filter((c) => c.method === "POST").map((c) => c.body.meta.key), ["k:b1#0", "k:b1#1"]);
});

test("aborting cancels the host job, then reports aborted", async () => {
  const host = fakeHost({ steps: () => [{ status: "running", startedAt: 2_000, chars: 1, partialText: "{" }, { status: "running" }, { status: "running" }] });
  const controller = new AbortController();
  let sleeps = 0;
  const sleep = async (_ms, signal) => {
    if (++sleeps === 2) controller.abort();
    if (signal?.aborted) throw new AiError("aborted", "Cancelled.");
  };
  await assert.rejects(client(host, { sleep }).generate(request({ signal: controller.signal })), (e) => e instanceof AiError && e.code === "aborted");
  const del = host.calls.find((c) => c.method === "DELETE");
  assert.equal(del?.url, "/api/ai/v1/jobs/job-00000001");
  assert.equal(host.jobs[0].status, "cancelled");
});

test("failed, interrupted and cancelled jobs map to the app's errors", async () => {
  const failing = (status, error) => fakeHost({ steps: () => [{ status, ...(error ? { error } : {}) }] });
  await assert.rejects(
    client(failing("failed", { code: "timeout", message: "No output for 90 seconds.", hint: "Retry." })).generate(request()),
    (e) => e.code === "timeout" && e.message === "No output for 90 seconds." && e.hint === "Retry.",
  );
  await assert.rejects(client(failing("failed", { code: "rate_limited", message: "Slow down" })).generate(request()), (e) => e.code === "rate_limited");
  await assert.rejects(client(failing("failed", { code: "cli_not_authenticated", message: "Log in" })).generate(request()), (e) => e.code === "cli_not_authenticated");
  await assert.rejects(client(failing("failed", { code: "weird", message: "?" })).generate(request()), (e) => e.code === "unknown");
  await assert.rejects(
    client(failing("interrupted", { code: "interrupted", message: "Study Hub closed before this finished." })).generate(request()),
    (e) => e.code === "unknown" && e.message === "Study Hub was closed while your assistant was working.",
  );
  await assert.rejects(client(failing("cancelled")).generate(request()), (e) => e.code === "aborted");

  assert.equal(mapJobError({ status: "cancelled" }).code, "aborted");
  assert.equal(mapJobError({ status: "failed", error: { code: "cli_not_found", message: "x", detail: "Searched: a" } }).detail, "Searched: a");
  assert.equal(mapJobError({ status: "failed", error: null }).code, "unknown");
});

test("a poll that cannot reach the host is retried, and gives up as host_unavailable", async () => {
  const flaky = fakeHost({ steps: RUN_THEN_DONE, failGets: 2 });
  assert.deepEqual((await client(flaky).generate(request())).data, { answer: "hi" });

  const gone = fakeHost({ steps: RUN_THEN_DONE, failGets: 100 });
  await assert.rejects(client(gone, { pollRetries: 3 }).generate(request()), (e) => e.code === "host_unavailable");
});

test("outside the desktop app generate refuses before starting anything", async () => {
  const host = fakeHost({ steps: RUN_THEN_DONE });
  await assert.rejects(client(host, { hosted: () => false }).generate(request()), (e) => e.code === "host_unavailable");
  assert.equal(host.calls.length, 0);
});

test("jobKeyFor and countItems", () => {
  assert.equal(jobKeyFor("t1:b3", 0), "t1:b3#0");
  assert.equal(countItems('{"title":"x","exercises":[{"number":"1","parts":[]},{"number" : "2"', "number"), 2);
  assert.equal(countItems('{"questions":[{"prompt":"a"},{"prom', "prompt"), 1);
  assert.equal(countItems("", "prompt"), 0);
  assert.equal(countItems(undefined, "prompt"), 0);
  assert.equal(countItems('{"a.b":1,"axb":2}', "a.b"), 1, "the field is matched literally");
});

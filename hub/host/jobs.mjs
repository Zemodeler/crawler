/**
 * AI jobs: CLI runs that outlive the HTTP request that started them.
 *
 * A tutorial-sheet conversion or a quiz can take many minutes, so the page
 * starts a job, polls it (with the text so far, if it wants), and can cancel
 * it. One job runs per lane (foreground: what the student asked for;
 * background: automatic study packs); more wait their turn in order.
 *
 * Each job is saved as <dir>/<id>.json whenever its status changes, so the
 * page can still find a finished answer after a reload. The prompt is never
 * written to disk. A job that was queued or running when Study Hub closed
 * comes back as "interrupted".
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { startCli } from "./cli.mjs";

export const MAX_META_BYTES = 4096;
export const KEEP_FINISHED_MS = 24 * 60 * 60 * 1000;
export const MAX_JOBS = 50;

const KINDS = new Set(["claude", "codex", "gemini"]);
const LANES = new Set(["foreground", "background"]);
const FINISHED = new Set(["done", "failed", "cancelled", "interrupted"]);
const ID_PATTERN = /^[a-z0-9-]{8,64}$/i;

export const isJobId = (id) => typeof id === "string" && ID_PATTERN.test(id);

/** The CLI run itself: `{ promise, cancel }` (see startCli). Tests replace it. */
const defaultStart = (spec, hooks) => startCli(spec.cli, spec.kind, spec.prompt, spec.model, spec.webAccess, hooks);

function failure(error) {
  const source = error && typeof error === "object" && error.code ? error : { code: "cli_incompatible", message: String(error?.message ?? error) };
  const out = { code: String(source.code), message: String(source.message ?? "") };
  if (source.hint) out.hint = String(source.hint);
  if (source.detail) out.detail = String(source.detail);
  return out;
}

/**
 * `start(spec, { onText, onActivity })` runs one job's CLI; `spec` is what was
 * passed to manager.start (prompt included). `dir` undefined keeps jobs in memory only.
 */
export function createJobManager({ dir, start = defaultStart, now = Date.now } = {}) {
  /** id -> { job, prompt-bearing spec, partial text, handle } */
  const entries = new Map();
  const queues = { foreground: [], background: [] };
  const active = { foreground: null, background: null };
  const waiters = new Map();

  const save = (job) => {
    if (!dir) return;
    try {
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${job.id}.json`);
      const temp = `${file}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify(job));
      renameSync(temp, file);
    } catch (error) {
      console.error(`Could not save AI job ${job.id}: ${error.message}`);
    }
  };
  const forget = (id) => {
    entries.delete(id);
    if (dir) rmSync(join(dir, `${id}.json`), { force: true });
  };

  /** Drops finished jobs past a day old, then the oldest finished ones past MAX_JOBS. */
  const prune = () => {
    const cutoff = now() - KEEP_FINISHED_MS;
    for (const [id, { job }] of entries)
      if (FINISHED.has(job.status) && (job.endedAt ?? job.createdAt) < cutoff) forget(id);
    if (entries.size <= MAX_JOBS) return;
    const finished = [...entries.values()]
      .map((entry) => entry.job)
      .filter((job) => FINISHED.has(job.status))
      .sort((a, b) => (a.endedAt ?? a.createdAt) - (b.endedAt ?? b.createdAt));
    for (const job of finished) {
      if (entries.size <= MAX_JOBS) break;
      forget(job.id);
    }
  };

  const publicJob = (job, partialText) => {
    const { text, ...rest } = job;
    const out = { ...rest, meta: job.meta === undefined ? null : JSON.parse(JSON.stringify(job.meta)) };
    if (text !== undefined) out.text = text;
    if (partialText !== undefined) out.partialText = partialText;
    return out;
  };

  const finish = (entry, status, fields = {}) => {
    const { job } = entry;
    if (FINISHED.has(job.status)) return;
    Object.assign(job, { status, endedAt: now(), ...fields });
    entry.spec = null;
    entry.handle = null;
    if (status !== "done") entry.partial = "";
    save(job);
    for (const resolve of waiters.get(job.id) ?? []) resolve(publicJob(job));
    waiters.delete(job.id);
  };

  const pump = (lane) => {
    if (active[lane]) return;
    const id = queues[lane].shift();
    if (!id) return;
    const entry = entries.get(id);
    if (!entry || entry.job.status !== "queued") return pump(lane);
    active[lane] = id;
    const { job } = entry;
    Object.assign(job, { status: "running", startedAt: now(), lastActivityAt: now() });
    save(job);
    const done = () => {
      if (active[lane] === id) active[lane] = null;
      prune();
      pump(lane);
    };
    let handle;
    try {
      handle = start(entry.spec, {
        onText: (text) => {
          if (job.status !== "running") return;
          entry.partial = String(text);
          job.chars = entry.partial.length;
          job.lastActivityAt = now();
        },
        onActivity: () => {
          if (job.status === "running") job.lastActivityAt = now();
        },
      });
    } catch (error) {
      finish(entry, "failed", { error: failure(error) });
      return done();
    }
    entry.handle = handle;
    Promise.resolve(handle?.promise).then(
      (text) => {
        const final = String(text ?? "");
        finish(entry, "done", { text: final, chars: final.length });
        done();
      },
      (error) => {
        if (error?.code === "aborted" || job.status === "cancelled") finish(entry, "cancelled");
        else finish(entry, "failed", { error: failure(error) });
        done();
      },
    );
  };

  // Jobs left from the last session: finished ones are kept, unfinished ones
  // can never complete now.
  if (dir) {
    let names = [];
    try {
      names = readdirSync(dir);
    } catch {
      /* no jobs yet */
    }
    for (const name of names) {
      if (!name.endsWith(".json") || !isJobId(name.slice(0, -5))) continue;
      let job;
      try {
        job = JSON.parse(readFileSync(join(dir, name), "utf8"));
      } catch {
        continue;
      }
      if (!job || typeof job !== "object" || job.id !== name.slice(0, -5)) continue;
      const entry = { job, spec: null, partial: "", handle: null };
      entries.set(job.id, entry);
      if (job.status === "queued" || job.status === "running") {
        Object.assign(job, {
          status: "interrupted",
          endedAt: now(),
          error: { code: "interrupted", message: "Study Hub closed before this finished." },
        });
        save(job);
      }
    }
    prune();
  }

  return {
    /** Queues a run; it starts as soon as its lane is free. Throws `{ code: "bad_request" }` on a bad spec. */
    start(spec) {
      const kind = spec?.kind;
      if (!KINDS.has(kind)) throw { code: "bad_request", message: "Unknown provider." };
      if (typeof spec.prompt !== "string" || !spec.prompt.trim()) throw { code: "bad_request", message: "No prompt supplied." };
      const lane = LANES.has(spec.lane) ? spec.lane : "foreground";
      const meta = spec.meta === undefined ? null : spec.meta;
      let metaJson;
      try {
        metaJson = JSON.stringify(meta);
      } catch {
        throw { code: "bad_request", message: "meta must be plain JSON." };
      }
      if (Buffer.byteLength(metaJson ?? "null", "utf8") > MAX_META_BYTES)
        throw { code: "bad_request", message: `meta is larger than ${MAX_META_BYTES} bytes.` };
      const job = {
        id: randomUUID(),
        kind,
        lane,
        label: typeof spec.label === "string" ? spec.label.slice(0, 200) : "",
        meta: JSON.parse(metaJson ?? "null"),
        status: "queued",
        createdAt: now(),
        startedAt: null,
        endedAt: null,
        lastActivityAt: null,
        chars: 0,
      };
      entries.set(job.id, { job, spec: { ...spec, lane }, partial: "", handle: null });
      save(job);
      queues[lane].push(job.id);
      pump(lane);
      prune();
      return publicJob(job);
    },

    /** One job, or null. `partial` adds `partialText`, the answer so far. */
    get(id, { partial = false } = {}) {
      const entry = entries.get(id);
      if (!entry) return null;
      return publicJob(entry.job, partial && !FINISHED.has(entry.job.status) ? entry.partial : undefined);
    },

    /** Every job, newest first, without any text. */
    list() {
      return [...entries.values()]
        .map(({ job }) => {
          const out = publicJob(job);
          delete out.text;
          return out;
        })
        .sort((a, b) => b.createdAt - a.createdAt);
    },

    /** Stops a queued or running job. Returns the job (unchanged if already finished), or null. */
    cancel(id) {
      const entry = entries.get(id);
      if (!entry) return null;
      const { job } = entry;
      if (job.status === "queued") {
        queues[job.lane] = queues[job.lane].filter((queued) => queued !== id);
        finish(entry, "cancelled");
      } else if (job.status === "running") {
        const handle = entry.handle;
        finish(entry, "cancelled");
        try {
          handle?.cancel?.();
        } catch {
          /* already ended */
        }
      }
      return publicJob(job);
    },

    /** Resolves with the job once it has finished. */
    wait(id) {
      const entry = entries.get(id);
      if (!entry) return Promise.resolve(null);
      if (FINISHED.has(entry.job.status)) return Promise.resolve(publicJob(entry.job));
      return new Promise((resolve) => {
        if (!waiters.has(id)) waiters.set(id, []);
        waiters.get(id).push(resolve);
      });
    },
  };
}

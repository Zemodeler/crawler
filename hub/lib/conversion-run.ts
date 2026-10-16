/**
 * The conversion run: inventory → plan → generate → stage → diff → write.
 *
 * Two decisions shape this file.
 *
 * **Nothing touches disk until the user approves a file list.** Every generated
 * file is staged in IndexedDB, so a full preview costs no write permission, a
 * crashed tab loses nothing, and cancelling halfway leaves the folder
 * byte-identical. Writing to a `.study-hub-preview/` directory on disk — the
 * obvious alternative — would need write access before the user has agreed to
 * anything.
 *
 * **A run never dies of one bad topic.** A topic that fails twice is marked
 * degraded, gets a "needs review" note in its pack, and the run carries on. A
 * student with thirteen good packs and one flagged is far better off than one
 * with an error message.
 */

import {
  SPEC,
  canonicalTopicKey,
  csvHeaderIsValid,
  fnv1a,
  guidePath,
  packPath,
  deckPath,
  parseCSV,
  topicFolderName,
  validateCourse,
  type FormatReport,
  type InventoryFile,
  type TopicIdent,
} from "./course-format.ts";
import {
  buildCaseCoverageIndex,
  buildGuide,
  buildHub,
  buildMasterChecklist,
  buildMaterialsIndex,
  buildPackEssentialsFallback,
  enumeratePackItems,
  foundationRows,
  mergeDeck,
  packEssentialsRows,
  renderDeck,
  renderPack,
  scenarioRows,
  type FoundationCard,
  type PackEssentialCard,
  type ScenarioCard,
} from "./course-render.ts";
import {
  generateFoundations,
  generateGuide,
  generatePack,
  generatePackEssentials,
  generateScenarios,
  planCourse,
  type PackDraft,
  type PlanResult,
  type PlanTopic,
} from "./ai-conversion.ts";
import {
  ensureReadWrite,
  idbDelete,
  idbGet,
  idbPut,
  readManifest,
  writeCourseFile,
  type DirectoryHandle,
  type LocalFile,
  type Manifest,
  type WriteResult,
} from "./course-fs.ts";
import { applyMoves, planCardMoves, planCheckMoves, type CardMove, type CheckMove } from "./id-remap.ts";
import { extractAll, type Extract } from "./source-extract.ts";
import { AiError, type AiClient } from "./ai/types.ts";
import { PROFILES, getProfile, type SubjectId, type SubjectProfile } from "./subject-profiles.ts";

export type StageId =
  | "inventory"
  | "extract"
  | "plan"
  | "packs"
  | "decks"
  | "guides"
  | "assemble"
  | "review"
  | "write"
  | "done";

export const STAGE_LABELS: Record<StageId, string> = {
  inventory: "Reading the folder",
  extract: "Reading your lectures and transcripts",
  plan: "Working out the topic list",
  packs: "Writing the topic packs",
  decks: "Writing the flashcards",
  guides: "Writing the revision guides",
  assemble: "Building the files",
  review: "Waiting for your approval",
  write: "Writing to your folder",
  done: "Finished",
};

export type TopicState = {
  key: string;
  label: string;
  number: number;
  status: "queued" | "running" | "done" | "degraded" | "failed";
  detail?: string;
};

export type LogLine = { kind: "info" | "bad" | "fix"; text: string };

export type StagedFile = {
  path: string;
  content: string;
  generator: "code" | "ai";
  topicKey?: string;
  degraded?: boolean;
};

export type RunSnapshot = {
  runId: string;
  courseName: string;
  mode: ConversionMode;
  /** The subject profile whose vocabulary and layout this run uses. */
  profile: SubjectId;
  stage: StageId;
  startedAt: number;
  updatedAt: number;
  plan?: PlanResult;
  topics: TopicState[];
  log: LogLine[];
  staged: StagedFile[];
  provider?: string;
  model?: string;
  costUsd: number;
  cancelled?: boolean;
  error?: string;
};

export type ConversionMode = "restructure" | "generate" | "scaffold";

export type RunEvents = {
  onChange: (snapshot: RunSnapshot) => void;
};

/** Options for starting a run. */
export type RunOptions = {
  /** Subject profile id; anything unknown falls back to law. */
  profile?: SubjectId;
};

const RUN_KEY = (course: string) => `run:${course}`;

/* ------------------------------------------------------------ persistence */

export async function loadRun(course: string): Promise<RunSnapshot | null> {
  return (await idbGet<RunSnapshot>("runs", RUN_KEY(course)).catch(() => undefined)) || null;
}
export async function discardRun(course: string): Promise<void> {
  await idbDelete("runs", RUN_KEY(course)).catch(() => {});
}

/* ------------------------------------------------------------------- run */

export class ConversionRun {
  private snapshot: RunSnapshot;
  private readonly events: RunEvents;
  private controller = new AbortController();

  constructor(snapshot: RunSnapshot, events: RunEvents) {
    this.snapshot = snapshot;
    this.events = events;
  }

  static create(
    courseName: string,
    mode: ConversionMode,
    events: RunEvents,
    options: RunOptions = {},
  ): ConversionRun {
    const profile: SubjectId =
      options.profile && Object.hasOwn(PROFILES, options.profile) ? options.profile : "law";
    return new ConversionRun(
      {
        runId: fnv1a(`${courseName}:${mode}:${performance.now()}`),
        courseName,
        mode,
        profile,
        stage: "inventory",
        startedAt: Date.now(),
        updatedAt: Date.now(),
        topics: [],
        log: [],
        staged: [],
        costUsd: 0,
      },
      events,
    );
  }

  static resume(snapshot: RunSnapshot, events: RunEvents): ConversionRun {
    // A run saved before profiles existed was a law run.
    return new ConversionRun(
      { ...snapshot, profile: snapshot.profile ?? "law", cancelled: false, error: undefined },
      events,
    );
  }

  private get profile(): SubjectProfile {
    return getProfile(this.snapshot.profile);
  }

  get state(): RunSnapshot {
    return this.snapshot;
  }

  cancel(): void {
    this.controller.abort();
    this.patch({ cancelled: true });
  }

  private patch(patch: Partial<RunSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch, updatedAt: Date.now() };
    this.events.onChange(this.snapshot);
    // Persisted after every stage so a reload resumes rather than restarts.
    void idbPut("runs", RUN_KEY(this.snapshot.courseName), this.snapshot).catch(() => {});
  }

  private log(kind: LogLine["kind"], text: string): void {
    this.patch({ log: [...this.snapshot.log, { kind, text }].slice(-400) });
  }

  private setTopic(key: string, patch: Partial<TopicState>): void {
    this.patch({
      topics: this.snapshot.topics.map((topic) => (topic.key === key ? { ...topic, ...patch } : topic)),
    });
  }

  private throwIfCancelled(): void {
    if (this.controller.signal.aborted) throw new AiError("aborted", "Conversion cancelled.");
  }

  /* ------------------------------------------------------------- planning */

  /**
   * Everything up to the point where the user reviews the topic list. Returns
   * the plan so the UI can let them edit it before any content is generated.
   */
  async plan(options: {
    client: AiClient | null;
    files: LocalFile[];
    report: FormatReport;
    pastedSyllabus?: string;
  }): Promise<{ plan: PlanResult; extracts: Map<string, Extract> } | null> {
    const { client, files } = options;
    this.patch({ stage: "extract" });

    const sources = files.filter((file) =>
      ["Source materials", "Seminars", "Past papers", "Course materials"].includes(file.category),
    );
    const extracts = await extractAll(sources, (done, total, path) => {
      if (path) this.log("info", `Reading ${path.split("/").pop()} (${done + 1} of ${total})`);
    });
    const unreadable = [...extracts.values()].filter((extract) => extract.reason && extract.reason !== "empty");
    for (const extract of unreadable)
      this.log("bad", `Could not read ${extract.path.split("/").pop()}: ${extract.detail || extract.reason}`);
    const readable = [...extracts.values()].filter((extract) => extract.text.trim()).length;
    this.log("info", `Read ${readable} of ${sources.length} source files.`);
    this.throwIfCancelled();

    if (this.snapshot.mode !== "generate" || !client) return null;

    this.patch({ stage: "plan" });
    this.log("info", "Asking the assistant to propose a topic list…");
    const plan = await planCourse(client, {
      courseName: this.snapshot.courseName,
      files,
      extracts,
      pastedSyllabus: options.pastedSyllabus,
      profile: this.profile,
      signal: this.controller.signal,
    });
    this.patch({
      plan,
      topics: plan.topics.map((topic) => ({
        key: canonicalTopicKey(topic.name),
        label: `${String(topic.number).padStart(2, "0")} - ${topic.name}`,
        number: topic.number,
        status: "queued" as const,
      })),
    });
    this.log("info", `Proposed ${plan.topics.length} topics for ${plan.subject}.`);
    return { plan, extracts };
  }

  /* ----------------------------------------------------------- generation */

  /**
   * Generate every artifact and stage it. The plan passed here is the *edited*
   * one from the review step, not necessarily what the model proposed.
   */
  async generate(options: {
    client: AiClient;
    plan: PlanResult;
    files: LocalFile[];
    extracts: Map<string, Extract>;
    existing: Map<string, string>;
  }): Promise<StagedFile[]> {
    const { client, plan, files, extracts } = options;
    const profile = this.profile;
    const allText = [...extracts.values()].map((extract) => extract.text).join("\n\n");
    const staged: StagedFile[] = [];
    const packsForGuides: { topic: PlanTopic; pack: PackDraft }[] = [];
    const coverage: {
      topic: TopicIdent;
      authorities: { name: string; citation?: string }[];
      foundationsQuestions: string[];
      scenarioAuthorities: string[];
    }[] = [];
    const checklists: { topic: TopicIdent; checklist: string[] }[] = [];

    this.patch({
      stage: "packs",
      topics: plan.topics.map((topic) => ({
        key: canonicalTopicKey(topic.name),
        label: topicFolderName({ number: topic.number, name: topic.name }),
        number: topic.number,
        status: "queued" as const,
      })),
    });

    for (const topic of plan.topics) {
      this.throwIfCancelled();
      const key = canonicalTopicKey(topic.name);
      const ident: TopicIdent = { number: topic.number, name: topic.name };
      this.setTopic(key, { status: "running", detail: "topic pack" });

      let pack: PackDraft;
      try {
        pack = await generatePack(client, {
          topic,
          allTopics: plan.topics,
          plan,
          files,
          extracts,
          allText,
          profile,
          signal: this.controller.signal,
        });
      } catch (error) {
        if (this.controller.signal.aborted) throw error;
        this.setTopic(key, { status: "failed", detail: (error as Error).message });
        this.log("bad", `${topic.name}: pack failed — ${(error as Error).message}`);
        continue;
      }
      for (const rejection of pack.rejected) this.log("bad", `${topic.name}: dropped ${rejection}`);
      if (pack.flagged.length)
        this.log("fix", `${topic.name}: ${pack.flagged.length} ${profile.terms.authorities} flagged for you to check.`);

      staged.push({
        path: packPath(ident),
        content: renderPack(ident, pack, profile),
        generator: "ai",
        topicKey: key,
        degraded: Boolean(pack.degradedNote),
      });
      packsForGuides.push({ topic, pack });
      checklists.push({ topic: ident, checklist: pack.checklist });

      // Decks are seeded by the pack, so they follow it immediately rather than
      // waiting for every pack to finish.
      this.setTopic(key, { detail: "flashcards" });
      let foundations: FoundationCard[] = [];
      let scenarios: ScenarioCard[] = [];
      try {
        const deck = await generateFoundations(client, {
          topic,
          pack,
          files,
          extracts,
          allText,
          profile,
          signal: this.controller.signal,
        });
        foundations = deck.cards;
        for (const rejection of deck.rejected) this.log("bad", `${topic.name}: dropped ${rejection}`);
      } catch (error) {
        if (this.controller.signal.aborted) throw error;
        this.log("bad", `${topic.name}: foundations deck failed — ${(error as Error).message}`);
      }
      try {
        const deck = await generateScenarios(client, {
          topic,
          pack,
          foundations,
          profile,
          signal: this.controller.signal,
        });
        scenarios = deck.cards;
        for (const rejection of deck.rejected) this.log("bad", `${topic.name}: dropped ${rejection}`);
      } catch (error) {
        if (this.controller.signal.aborted) throw error;
        this.log("bad", `${topic.name}: scenario deck failed — ${(error as Error).message}`);
      }

      // Deterministically enumerated, so this deck always covers every rule,
      // checklist item, move and trap — even if the call below fails outright.
      this.setTopic(key, { detail: "pack essentials" });
      let essentials: PackEssentialCard[] = [];
      try {
        const deck = await generatePackEssentials(client, {
          topic,
          pack,
          files,
          extracts,
          allText,
          profile,
          signal: this.controller.signal,
        });
        essentials = deck.cards;
        if (deck.brokenSlots.length)
          this.log(
            "bad",
            `${topic.name}: Pack Essentials could not match ${deck.brokenSlots.length} slot(s) ` +
              `(${deck.brokenSlots.join(", ")}) — used the pack's own wording for them.`,
          );
      } catch (error) {
        if (this.controller.signal.aborted) throw error;
        essentials = buildPackEssentialsFallback(enumeratePackItems(pack));
        this.log(
          "fix",
          `${topic.name}: Pack Essentials deck built from the pack's own text only — ${(error as Error).message}`,
        );
      }
      const enrichedCount = essentials.filter((card) => card.hasEnrichment).length;
      if (essentials.length && enrichedCount < essentials.length)
        this.log(
          "fix",
          `${topic.name}: ${essentials.length - enrichedCount} of ${essentials.length} Pack Essentials ` +
            `cards use the pack's own wording only — nothing is missing, but you may want to add detail by hand.`,
        );

      const foundationsPath = deckPath(ident, "foundations", profile);
      const scenarioPath = deckPath(ident, "scenario", profile);
      const essentialsPath = deckPath(ident, "pack-essentials", profile);
      if (foundations.length) {
        const rows = mergeDeck(options.existing.get(foundationsPath) || null, foundationRows(foundations, profile));
        staged.push({ path: foundationsPath, content: renderDeck(rows), generator: "ai", topicKey: key });
      }
      if (scenarios.length) {
        const rows = mergeDeck(options.existing.get(scenarioPath) || null, scenarioRows(scenarios, profile));
        staged.push({ path: scenarioPath, content: renderDeck(rows), generator: "ai", topicKey: key });
      }
      if (essentials.length) {
        const rows = mergeDeck(options.existing.get(essentialsPath) || null, packEssentialsRows(essentials));
        staged.push({
          path: essentialsPath,
          content: renderDeck(rows),
          generator: enrichedCount ? "ai" : "code",
          topicKey: key,
        });
      }

      coverage.push({
        topic: ident,
        authorities: pack.authorities.map((authority) => ({
          name: authority.name,
          citation: authority.citation,
        })),
        foundationsQuestions: foundations.map((card) =>
          profile.namedFoundationKinds.includes(card.kind) && card.authority ? card.authority : card.prompt,
        ),
        scenarioAuthorities: scenarios.map((card) => card.bestAuthority),
      });

      const degraded =
        Boolean(pack.degradedNote) || !foundations.length || !scenarios.length || !essentials.length;
      this.setTopic(key, {
        status: degraded ? "degraded" : "done",
        detail: `${foundations.length + scenarios.length + essentials.length} cards`,
      });
      this.patch({ staged });
    }

    /* The two derived guides need no AI at all. */
    this.patch({ stage: "guides" });
    for (const guide of profile.guides) {
      this.throwIfCancelled();
      const path = guidePath(guide.n, guide.title, profile);
      if (guide.source === "derived") {
        const content =
          guide.n === 5 ? buildCaseCoverageIndex(coverage, profile) : buildMasterChecklist(checklists, profile);
        staged.push({ path, content, generator: "code" });
        this.log("info", `Built ${guide.title} from the packs — no AI needed.`);
        continue;
      }
      try {
        this.log("info", `Writing ${guide.title}…`);
        const written = await generateGuide(client, {
          n: guide.n,
          title: guide.title,
          plan,
          packs: packsForGuides,
          profile,
          signal: this.controller.signal,
        });
        staged.push({
          path,
          content: buildGuide(guide.n, guide.title, written.blocks, written.intro, profile),
          generator: "ai",
        });
      } catch (error) {
        if (this.controller.signal.aborted) throw error;
        this.log("bad", `${guide.title} failed — ${(error as Error).message}`);
      }
      this.patch({ staged });
    }

    /* The hub is assembled last so it can only ever link files that exist. */
    this.patch({ stage: "assemble" });
    staged.push(...this.buildScaffold(plan, files, staged));
    this.patch({ staged, stage: "review" });
    return staged;
  }

  /**
   * The deterministic files: the hub and the materials index. Also the whole of
   * "restructure only" mode, which is why it takes the staged list and works
   * from whatever is actually present.
   */
  buildScaffold(plan: PlanResult, files: InventoryFile[], staged: StagedFile[]): StagedFile[] {
    const out: StagedFile[] = [];
    const hasMaterialsIndex = files.some((file) => /course materials index/i.test(file.path));
    const sources = files.filter((file) =>
      ["Source materials", "Seminars", "Past papers", "Course materials"].includes(
        file.category || "",
      ),
    );
    if (sources.length && !hasMaterialsIndex)
      out.push({ path: SPEC.materialsIndex, content: buildMaterialsIndex(files), generator: "code" });

    // Only link topics whose pack was actually produced.
    const written = new Set(staged.map((file) => file.path));
    const topics = plan.topics.filter((topic) =>
      written.has(packPath({ number: topic.number, name: topic.name })),
    );
    if (topics.length)
      out.push({
        path: SPEC.hub,
        content: buildHub(
          { ...plan, topics },
          { hasMaterialsIndex: hasMaterialsIndex || sources.length > 0 },
          this.profile,
        ),
        generator: "code",
      });
    return out;
  }

  /* ---------------------------------------------------------------- write */

  /**
   * Commit the staged tree.
   *
   * Order matters: the hub goes last, so an interrupted write can never leave a
   * hub full of links to packs that were not written.
   */
  async commit(options: {
    handle: DirectoryHandle;
    files: LocalFile[];
    manifest: Manifest | null;
    allowUpdate: boolean;
  }): Promise<{ results: WriteResult[]; remap: string }> {
    const granted = await ensureReadWrite(options.handle);
    if (!granted)
      throw new AiError("unknown", "Study Hub needs permission to add files to this folder.", {
        hint: "Choose Allow when Chrome asks for edit access.",
      });

    this.patch({ stage: "write" });
    const known = new Map((options.manifest?.files || []).map((file) => [file.path, file.sha]));
    const existing = new Map(options.files.map((file) => [file.path, file.text || ""]));

    const ordered = [...this.snapshot.staged].sort((a, b) => {
      if (a.path === SPEC.hub) return 1;
      if (b.path === SPEC.hub) return -1;
      return a.path.localeCompare(b.path);
    });

    const cardMoves: CardMove[] = [];
    const checkMoves: CheckMove[] = [];
    const results: WriteResult[] = [];
    const manifestFiles: Manifest["files"] = [];

    for (const file of ordered) {
      this.throwIfCancelled();
      const before = existing.get(file.path);
      // Work out what moved BEFORE the bytes change under us.
      if (before !== undefined && before !== file.content) {
        if (file.path.endsWith(".csv") && csvHeaderIsValid(parseCSV(before)[0]))
          cardMoves.push(...planCardMoves(file.path, parseCSV(before), parseCSV(file.content)));
        else if (file.path.endsWith(".md"))
          checkMoves.push(...planCheckMoves(file.path, before, file.content));
      }

      const result = await writeCourseFile(options.handle, file.path, file.content, {
        allowUpdate: options.allowUpdate,
        expectedSha: known.get(file.path),
        shaOf: fnv1a,
      });
      results.push(result);
      if (result.action === "create" || result.action === "update")
        manifestFiles.push({
          path: file.path,
          sha: fnv1a(file.content),
          bytes: result.bytes,
          generator: file.generator,
          topicKey: file.topicKey,
          degraded: file.degraded,
        });
      if (result.action === "pinned")
        this.log("fix", `Left ${file.path} alone — ${result.reason}.`);
      if (result.action === "rejected") this.log("bad", `Refused to write ${file.path}: ${result.reason}`);
    }

    const remap = applyMoves(this.snapshot.courseName, cardMoves, checkMoves);
    const manifest: Manifest = {
      specVersion: SPEC.version,
      runId: this.snapshot.runId,
      completedAt: Date.now(),
      provider: this.snapshot.provider,
      model: this.snapshot.model,
      plan: this.snapshot.plan,
      profile: this.snapshot.profile,
      // Carry forward anything we did not rewrite this run.
      files: [
        ...(options.manifest?.files || []).filter(
          (file) => !manifestFiles.some((entry) => entry.path === file.path),
        ),
        ...manifestFiles,
      ],
      sourceFingerprints: options.files.map((file) => ({ path: file.path, size: file.file.size })),
    };
    await writeManifest(options.handle, manifest);

    const created = results.filter((result) => result.action === "create").length;
    this.log("info", `Wrote ${created} new files.`);
    this.patch({ stage: "done" });
    await discardRun(this.snapshot.courseName);

    return {
      results,
      remap:
        remap.cardsMoved || remap.checksMoved
          ? `${remap.cardsMoved} card reviews and ${remap.checksMoved} ticked items were carried over.`
          : "",
    };
  }
}

/** The manifest lives in a dot-directory, so `collectDirectory` never sees it. */
async function writeManifest(handle: DirectoryHandle, manifest: Manifest): Promise<void> {
  try {
    const dir = await handle.getDirectoryHandle(SPEC.internalDir, { create: true });
    const file = await dir.getFileHandle("manifest.json", { create: true });
    if (!file.createWritable) return;
    const writable = await file.createWritable();
    await writable.write(JSON.stringify(manifest, null, 2));
    await writable.close();
  } catch {
    // A missing manifest costs incremental re-runs, not correctness.
  }
}

/* ------------------------------------------------------------- diff view */

export type DiffRow = {
  path: string;
  action: "create" | "update" | "skip" | "pinned";
  bytes: number;
  content: string;
  reason?: string;
};

/** What `commit` would do, computed without touching the disk. */
export function planDiff(
  staged: StagedFile[],
  files: LocalFile[],
  manifest: Manifest | null,
  allowUpdate: boolean,
): DiffRow[] {
  const existing = new Map(files.map((file) => [file.path, file.text ?? null]));
  const known = new Map((manifest?.files || []).map((file) => [file.path, file.sha]));
  return staged.map((file) => {
    const bytes = new TextEncoder().encode(file.content).length;
    const before = existing.get(file.path);
    if (before === undefined) return { path: file.path, action: "create" as const, bytes, content: file.content };
    if (before === file.content)
      return { path: file.path, action: "skip" as const, bytes, content: file.content, reason: "already identical" };
    const managed = before !== null && known.get(file.path) === fnv1a(before);
    if (allowUpdate && managed)
      return { path: file.path, action: "update" as const, bytes, content: file.content };
    return {
      path: file.path,
      action: "pinned" as const,
      bytes,
      content: file.content,
      reason: managed ? "updates not requested" : "you edited this file",
    };
  });
}

/** Re-runs the validator over the staged tree merged on top of the real one. */
export function validateStaged(
  files: LocalFile[],
  staged: StagedFile[],
  courseName: string,
  profile: SubjectProfile = PROFILES.law,
): FormatReport {
  const merged = new Map<string, InventoryFile>();
  for (const file of files)
    merged.set(file.path, {
      path: file.path,
      name: file.name,
      ext: file.ext,
      size: file.file.size,
      text: file.text,
      category: file.category,
    });
  for (const file of staged)
    merged.set(file.path, {
      path: file.path,
      name: file.path.split("/").pop(),
      ext: file.path.split(".").pop()?.toLowerCase(),
      size: file.content.length,
      text: file.content,
    });
  return validateCourse([...merged.values()], { courseName }, profile);
}

export { readManifest };

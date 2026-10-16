/**
 * Deterministic context scoping for the chat assistant.
 *
 * There is no vector store or search index anywhere in this app, and this
 * module does not add one — "about this specific content" is a lookup, not a
 * search, built entirely from data the conversion pipeline already produces.
 */

import { canonicalTopicKey } from "../../lib/course-format.ts";
import { topicExcerpts, type PlanTopic } from "../../lib/ai-conversion.ts";
import { extractFile, type Extract } from "../../lib/source-extract.ts";
import type { LocalFile, Manifest } from "../../lib/course-fs.ts";

const CHAT_EXCERPT_BUDGET = 45_000;

export type ChatScope = {
  /** Named in the system prompt, e.g. "the topic pack for Economic Duress". */
  scopeLabel: string;
  contextLabel: string;
  contextBlock: string;
  /** Every file whose text was actually included, for the cost/token estimate. */
  linkedFiles: string[];
  /** The extracts + concatenated text actually in scope — checkChatGrounding
   *  verifies a citation against exactly this, never the whole course, so a
   *  citation can never "verify" against material the model was never given. */
  extracts: Map<string, Extract>;
  allText: string;
};

/**
 * `Manifest.plan` is stored as `unknown` — it is a plain JSON file a user
 * could hand-edit, or one written by an older schema version — so it is
 * validated defensively here rather than trusted.
 */
function planTopics(manifest: Manifest | null): PlanTopic[] {
  const plan = manifest?.plan as { topics?: unknown } | undefined;
  if (!plan || !Array.isArray(plan.topics)) return [];
  return plan.topics.filter(
    (t): t is PlanTopic =>
      Boolean(t) &&
      typeof (t as PlanTopic).name === "string" &&
      Array.isArray((t as PlanTopic).sourceFiles),
  );
}

/** Extracts (with on-disk caching, via `extractFile`) only the files a topic
 *  actually names, mirroring `topicExcerpts()`'s own filename matching. */
async function extractsForTopic(topic: PlanTopic, files: LocalFile[]): Promise<Map<string, Extract>> {
  const matched = topic.sourceFiles
    .map((name) => files.find((file) => file.path.toLowerCase().endsWith(name.toLowerCase())))
    .filter((file): file is LocalFile => Boolean(file));
  const map = new Map<string, Extract>();
  await Promise.all(
    matched.map(async (file) => {
      map.set(file.path, await extractFile(file));
    }),
  );
  return map;
}

/**
 * Builds the scoped context for whatever the user currently has open.
 *
 * A topic pack or one of its flashcard decks resolves to its topic (via the
 * same `canonicalTopicKey` join the rest of the app uses) and pulls in that
 * topic's linked source files through `topicExcerpts()` — the exact function
 * the generator itself uses. Anything else — a guide, a lecture opened
 * directly, or a folder that was never converted at all — is scoped to just
 * that one file's own text. This is deliberately the narrower option: the
 * product decision was "about this specific content," not "about the course."
 */
export async function buildChatScope(
  selectedPath: string,
  files: LocalFile[],
  manifest: Manifest | null,
): Promise<ChatScope> {
  const file = files.find((f) => f.path === selectedPath);
  if (!file)
    return { scopeLabel: "nothing open", contextLabel: "(none)", contextBlock: "", linkedFiles: [], extracts: new Map(), allText: "" };

  const name = file.name.replace(/\.(md|csv|txt)$/i, "");
  const isPackOrDeck = file.category === "Study packs" || file.ext === "csv";
  const topic = isPackOrDeck
    ? planTopics(manifest).find((t) => canonicalTopicKey(t.name) === canonicalTopicKey(file.path))
    : undefined;

  if (topic) {
    const extracts = await extractsForTopic(topic, files);
    const excerpts = topicExcerpts(topic, files, extracts, CHAT_EXCERPT_BUDGET);
    const ownText = file.text || "";
    const allText = [ownText, ...[...extracts.values()].map((e) => e.text)].filter(Boolean).join("\n\n");
    return {
      scopeLabel: `the topic pack for "${topic.name}", and its linked source files`,
      contextLabel: name,
      contextBlock: [ownText, excerpts.text].filter(Boolean).join("\n\n"),
      linkedFiles: [file.path, ...excerpts.used],
      extracts,
      allText,
    };
  }

  const extract = await extractFile(file);
  return {
    scopeLabel: `the file "${name}"`,
    contextLabel: file.name,
    contextBlock: extract.text,
    linkedFiles: [file.path],
    extracts: new Map([[file.path, extract]]),
    allText: extract.text,
  };
}

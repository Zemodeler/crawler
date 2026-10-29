/** Echo360 and Panopto captions to local transcripts; existing manifest entries are final. */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createEcho360Client, Echo360Error } from "./adapters/echo360.ts";
import { createPanoptoClient, folderMatchesCode, panoptoRefs, PanoptoError, srtToText } from "./adapters/panopto.ts";
import type { PanoptoSession } from "./adapters/panopto.ts";
import { sanitizeSegment } from "./naming.ts";
import type { Course, Credentials, ManifestEntry, ModulePlacement, UniversityAdapter, VleItem } from "./types.ts";

/** Ported from the verified spike: strip WebVTT metadata and consecutive repeats. */
export function vttToText(vtt: string): string {
  const out: string[] = [];
  for (const block of vtt.replace(/\r\n?/g, "\n").split(/\n{2,}/)) {
    const lines = block.split("\n").filter(Boolean);
    if (!lines.length || /^(WEBVTT|NOTE|STYLE|REGION)\b/.test(lines[0]!)) continue;
    const at = lines.findIndex((line) => line.includes("-->"));
    if (at < 0) continue;
    for (const line of lines.slice(at + 1)) {
      const text = line.replace(/<[^>]+>/g, "").trim();
      if (text && out[out.length - 1] !== text) out.push(text);
    }
  }
  return out.join("\n");
}

/** Folders found by module code that are read per course. */
const MAX_SEARCHED_FOLDERS = 3;

export type TranscriptOptions = {
  adapter: UniversityAdapter; credentials: Credentials; course: Course; placement: ModulePlacement;
  items: VleItem[]; root: string; manifest: Map<string, ManifestEntry>; now: Date;
  fetch?: typeof fetch; pauseMs?: number; maxNew?: number;
  /** Panopto site whose links in `items` are read; `cookies` is that site's own session, if any. */
  panopto?: { site: string; cookies?: string };
};

type TranscriptResult = { added: string[]; skippedNoCaptions: number; failed: number; error?: string };

export async function syncTranscripts(options: TranscriptOptions): Promise<TranscriptResult> {
  const { adapter, credentials, course, placement, root, manifest, now } = options;
  const result: TranscriptResult = { added: [], skippedNoCaptions: 0, failed: 0 };
  const maxNew = Math.max(0, options.maxNew ?? 40);
  let attempted = 0;
  const failure = (error: unknown, stage: string) => {
    result.failed++;
    result.error = error instanceof Echo360Error || error instanceof PanoptoError ? error.message : `${stage}: 0`;
  };
  /** Writes one transcript file and its manifest entry. */
  const save = async (vleId: string, source: string, sourceUrl: string, index: number, title: string, startUtc: string | null, text: string) => {
    let tmp: string | undefined;
    try {
      const date = startUtc ? new Date(startUtc).toISOString().slice(0, 10) : "Undated";
      const prefix = String(index + 1).padStart(2, "0");
      const filename = sanitizeSegment(`${prefix} - ${title} (${date}).txt`);
      const folder = [sanitizeSegment(placement.year), sanitizeSegment(placement.folder), "Course Materials", "Transcripts"].join("/");
      let localPath = `${folder}/${filename}`;
      // Preserve any untracked file, including a second media with the same title.
      for (let n = 2; ; n++) {
        try { await stat(join(root, localPath)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") break; throw error; }
        localPath = `${folder}/${sanitizeSegment(`${filename.slice(0, -4)} (${n}).txt`)}`;
      }
      const content = `${title}\n${date}\nFrom the ${source} captions of this recording\n${sourceUrl}\n\n${text}\n`;
      await mkdir(join(root, ".crawler", "tmp"), { recursive: true });
      tmp = join(root, ".crawler", "tmp", randomBytes(12).toString("hex"));
      await writeFile(tmp, content, "utf8");
      await mkdir(dirname(join(root, localPath)), { recursive: true });
      await rename(tmp, join(root, localPath));
      manifest.set(vleId, {
        vleId, module: course.shortname, sourceUrl, localPath, category: "Transcripts",
        categoryReason: `${source.toLowerCase()} captions`, vleModified: null,
        sha256: createHash("sha256").update(content).digest("hex"), writtenAt: now.toISOString(),
      });
      result.added.push(localPath);
    } finally { if (tmp) await rm(tmp, { force: true }).catch(() => {}); }
  };

  if (adapter.ltiLaunch) {
    const client = createEcho360Client({ fetch: options.fetch, pauseMs: options.pauseMs });
    for (const item of options.items) {
      if (attempted >= maxNew) break;
      if (item.kind !== "external-tool" || !item.instance || !/echo|q-review|lecture recording/i.test(`${item.toolName} ${item.activity}`)) continue;
      let lessons;
      let sourceUrl: string;
      try {
        const activity = new URL(item.activityUrl);
        // Activity URLs need only the Moodle module id; discard every other field.
        const id = activity.searchParams.get("id");
        activity.search = ""; activity.hash = ""; activity.username = ""; activity.password = "";
        if (id) activity.searchParams.set("id", id);
        sourceUrl = activity.href;
        const launch = await adapter.ltiLaunch(credentials, item.instance);
        const { sectionId } = await client.launch(launch.endpoint, launch.fields);
        lessons = await client.syllabus(sectionId);
      } catch (error) { failure(error, "launch"); continue; }
      for (const [index, lesson] of lessons.entries()) {
        for (const media of lesson.medias) {
          const vleId = `echo360:${media.id}`;
          if (attempted >= maxNew) break;
          if (!media.isAvailable || media.hidden || manifest.has(vleId)) continue;
          attempted++;
          try {
            const vtt = await client.captionsVtt(lesson.lessonId, media.id);
            const text = vtt ? vttToText(vtt) : "";
            if (!text) { result.skippedNoCaptions++; continue; }
            await save(vleId, "Echo360", sourceUrl, index, lesson.title, lesson.startUtc, text);
          } catch (error) { failure(error, "transcript"); }
        }
      }
    }
  }

  if (options.panopto) {
    const { site } = options.panopto;
    const client = createPanoptoClient({ site, cookies: options.panopto.cookies, fetch: options.fetch, pauseMs: options.pauseMs });
    // Lecturers link Panopto folders and recordings from content links, pages and announcements.
    const folders = new Set<string>();
    const deliveries = new Set<string>();
    for (const item of options.items) {
      const text = item.kind === "link" ? item.target : item.kind === "page" ? item.html : item.kind === "announcement" ? item.bodyHtml : "";
      if (!text) continue;
      const refs = panoptoRefs(text, site);
      refs.folders.forEach((id) => folders.add(id));
      refs.deliveries.forEach((id) => deliveries.add(id));
    }
    // Recordings reached only through the module's Panopto nav-bar link: its folder is named by module code.
    if (options.panopto.cookies && placement.code) {
      try {
        const found = (await client.searchFolders(placement.code)).filter((f) => folderMatchesCode(f.name, placement.code!));
        found.slice(0, MAX_SEARCHED_FOLDERS).forEach((f) => folders.add(f.id));
      } catch (error) { failure(error, "folders"); }
    }
    const recordings: (Partial<PanoptoSession> & { deliveryId: string })[] = [];
    for (const folder of folders) {
      if (attempted >= maxNew) break;
      try { recordings.push(...(await client.sessions(folder)).filter((s) => !recordings.some((r) => r.deliveryId === s.deliveryId))); }
      catch (error) { failure(error, "sessions"); }
    }
    for (const deliveryId of deliveries) if (!recordings.some((r) => r.deliveryId === deliveryId)) recordings.push({ deliveryId });
    for (const [index, recording] of recordings.entries()) {
      const vleId = `panopto:${recording.deliveryId}`;
      if (attempted >= maxNew) break;
      if (recording.hasCaptions === false || manifest.has(vleId)) continue;
      attempted++;
      try {
        const delivery = await client.delivery(recording.deliveryId);
        let text = "";
        for (const language of delivery?.languages ?? []) {
          const srt = await client.captionsSrt(recording.deliveryId, language);
          text = srt ? srtToText(srt) : "";
          if (text) break;
        }
        if (!delivery || !text) { result.skippedNoCaptions++; continue; }
        const sourceUrl = new URL(`/Panopto/Pages/Viewer.aspx?id=${encodeURIComponent(recording.deliveryId)}`, site).href;
        await save(vleId, "Panopto", sourceUrl, index, recording.title ?? delivery.title, recording.startUtc ?? delivery.startUtc, text);
      } catch (error) { failure(error, "transcript"); }
    }
  }
  return result;
}

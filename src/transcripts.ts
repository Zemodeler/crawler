/** Echo360 captions to local transcripts; existing manifest entries are final. */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createEcho360Client, Echo360Error } from "./adapters/echo360.ts";
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

export type TranscriptOptions = {
  adapter: UniversityAdapter; credentials: Credentials; course: Course; placement: ModulePlacement;
  items: VleItem[]; root: string; manifest: Map<string, ManifestEntry>; now: Date;
  fetch?: typeof fetch; pauseMs?: number; maxNew?: number;
};

export async function syncTranscripts(options: TranscriptOptions): Promise<{
  added: string[]; skippedNoCaptions: number; failed: number; error?: string;
}> {
  const { adapter, credentials, course, placement, root, manifest, now } = options;
  const result: { added: string[]; skippedNoCaptions: number; failed: number; error?: string } = {
    added: [], skippedNoCaptions: 0, failed: 0,
  };
  if (!adapter.ltiLaunch) return result;
  const client = createEcho360Client({ fetch: options.fetch, pauseMs: options.pauseMs });
  const maxNew = Math.max(0, options.maxNew ?? 40);
  let attempted = 0;
  const failure = (error: unknown, stage: string) => {
    result.failed++;
    result.error = error instanceof Echo360Error ? error.message : `${stage}: 0`;
  };
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
        let tmp: string | undefined;
        try {
          const vtt = await client.captionsVtt(lesson.lessonId, media.id);
          const text = vtt ? vttToText(vtt) : "";
          if (!text) { result.skippedNoCaptions++; continue; }
          const date = lesson.startUtc ? new Date(lesson.startUtc).toISOString().slice(0, 10) : "Undated";
          const prefix = String(index + 1).padStart(2, "0");
          const filename = sanitizeSegment(`${prefix} - ${lesson.title} (${date}).txt`);
          const folder = [sanitizeSegment(placement.year), sanitizeSegment(placement.folder), "Course Materials", "Transcripts"].join("/");
          let localPath = `${folder}/${filename}`;
          // Preserve any untracked file, including a second media with the same title.
          for (let n = 2; ; n++) {
            try { await stat(join(root, localPath)); }
            catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") break; throw error; }
            localPath = `${folder}/${sanitizeSegment(`${filename.slice(0, -4)} (${n}).txt`)}`;
          }
          const content = `${lesson.title}\n${date}\nFrom the Echo360 captions of this recording\n${sourceUrl}\n\n${text}\n`;
          await mkdir(join(root, ".crawler", "tmp"), { recursive: true });
          tmp = join(root, ".crawler", "tmp", randomBytes(12).toString("hex"));
          await writeFile(tmp, content, "utf8");
          await mkdir(dirname(join(root, localPath)), { recursive: true });
          await rename(tmp, join(root, localPath));
          manifest.set(vleId, {
            vleId, module: course.shortname, sourceUrl, localPath, category: "Transcripts",
            categoryReason: "echo360 captions", vleModified: null,
            sha256: createHash("sha256").update(content).digest("hex"), writtenAt: now.toISOString(),
          });
          result.added.push(localPath);
        } catch (error) { failure(error, "transcript"); }
        finally { if (tmp) await rm(tmp, { force: true }).catch(() => {}); }
      }
    }
  }
  return result;
}

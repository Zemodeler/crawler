/**
 * Pure helpers for the Echo360 spike, kept apart from Electron so they can be
 * unit-tested on synthetic fixtures: `node --test spikes/echo360`.
 */

/** mod_lti_get_tool_launch_data → { endpoint, fields } for an HTML form post. */
export function launchForm(data) {
  if (!data || typeof data.endpoint !== "string" || !Array.isArray(data.parameters)) {
    throw new Error("launch data has no endpoint/parameters");
  }
  const fields = new URLSearchParams();
  for (const { name, value } of data.parameters) fields.append(name, value ?? "");
  return { endpoint: data.endpoint, fields };
}

/** Names of the launch parameters only (values can hold the user's identity and the OAuth signature). */
export function launchParameterNames(data) {
  return (data?.parameters || []).map((p) => p.name).sort();
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** Echo360 Cloud lands on `<host>/section/<uuid>/home`; anything else is reported as unknown. */
export function sectionFromUrl(url) {
  const u = new URL(url);
  const match = u.pathname.match(new RegExp(`/section/(${UUID})(?:/|$)`, "i"));
  return { host: u.origin, sectionId: match ? match[1] : null };
}

/**
 * Lessons from `<host>/section/<uuid>/syllabus`. The shape is taken from
 * open-source downloaders (`data[].lesson.lesson.id`, `data[].lesson.medias[]`,
 * `lesson.video.published.courseName`) and is NOT verified on QM's tenant,
 * so every field is read defensively and unknown shapes return [].
 */
export function lessonsFromSyllabus(json) {
  const rows = Array.isArray(json?.data) ? json.data : [];
  const lessons = [];
  for (const row of rows) {
    // Grouped rows (a folder of lessons) nest them under `lessons`.
    const entries = Array.isArray(row?.lessons) ? row.lessons : [row];
    for (const entry of entries) {
      const lesson = entry?.lesson;
      const id = lesson?.lesson?.id;
      if (!id) continue;
      const medias = (Array.isArray(lesson.medias) ? lesson.medias : [])
        .map((m) => ({ id: m?.id, type: m?.mediaType ?? null, hasTranscript: m?.hasTranscript ?? null }))
        .filter((m) => m.id);
      lessons.push({
        id,
        name: lesson.lesson.displayName ?? lesson.lesson.name ?? null,
        start: lesson.startTimeUTC ?? lesson.lesson?.timing?.start ?? null,
        hasVideo: Boolean(lesson.hasVideo ?? lesson.hasAvailableVideo),
        medias,
      });
    }
  }
  return lessons;
}

/** WebVTT → plain text: drops the header, cue ids, timings, NOTE blocks and tags; joins repeated lines. */
export function vttToText(vtt) {
  const out = [];
  const blocks = vtt.replace(/\r\n?/g, "\n").split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n").filter(Boolean);
    if (!lines.length || /^(WEBVTT|NOTE|STYLE|REGION)\b/.test(lines[0])) continue;
    const at = lines.findIndex((l) => l.includes("-->"));
    if (at < 0) continue;
    for (const line of lines.slice(at + 1)) {
      const text = line.replace(/<[^>]+>/g, "").trim();
      if (text && out[out.length - 1] !== text) out.push(text);
    }
  }
  return out.join("\n");
}

/**
 * Route shapes the spike may report. A path is shown only when it matches one
 * of these, with every `:id` segment replaced; anything else becomes `/<path>`.
 */
const ROUTES = [
  "/section/:id/home",
  "/section/:id/syllabus",
  "/lti/:id",
  "/api/ui/echoplayer/lessons/:id/medias/:id/transcript",
  "/api/ui/echoplayer/lessons/:id/medias/:id/transcript-file",
  "/media/:id/transcript",
  "/media/:id/vtt",
  "/login",
  "/",
];

/** A URL safe to report: origin plus an allowlisted route shape; no query, fragment or dynamic segment. */
export function redactUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return "<invalid-url>";
  }
  const parts = u.pathname.split("/").filter(Boolean);
  const route = ROUTES.find((r) => {
    const want = r.split("/").filter(Boolean);
    return want.length === parts.length && want.every((w, i) => w === ":id" || w === parts[i]);
  });
  return `${u.origin}${route ?? "/<path>"}`;
}

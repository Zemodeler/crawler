/** Read-only Echo360 captions client. Cookies live only in this client. */
export class Echo360Error extends Error {
  readonly stage: string;
  readonly status: number;
  constructor(stage: string, status: number) {
    super(`${stage}: ${status}`);
    this.name = "Echo360Error";
    this.stage = stage;
    this.status = status;
  }
}

export type EchoLesson = {
  lessonId: string;
  title: string;
  startUtc: string | null;
  medias: { id: string; title: string; isAvailable: boolean; hidden: boolean }[];
};
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** A request that gets no answer in this long fails, so one stalled server cannot hold the whole sync. */
const REQUEST_TIMEOUT_MS = 20_000;

export function createEcho360Client({ fetch: doFetch = globalThis.fetch, pauseMs = 500 }: {
  fetch?: typeof fetch; pauseMs?: number;
} = {}) {
  let host = "";
  const cookies = new Map<string, string>();
  let tail: Promise<unknown> = Promise.resolve();
  let requested = false;
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const result = tail.then(work);
    tail = result.catch(() => {});
    return result;
  };
  async function request(stage: string, url: string, init: RequestInit = {}) {
    let status = 0;
    try {
      if (new URL(url).origin !== host) throw new Echo360Error(stage, 0);
      if (requested) await new Promise((resolve) => setTimeout(resolve, Math.max(0, pauseMs)));
      requested = true;
      const headers = new Headers(init.headers);
      if (cookies.size) headers.set("cookie", [...cookies].map(([k, v]) => `${k}=${v}`).join("; "));
      const response = await doFetch(url, { ...init, headers, redirect: "manual", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      status = response.status;
      for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(";", 1)[0] ?? "";
        const at = pair.indexOf("=");
        if (at <= 0) continue;
        const name = pair.slice(0, at);
        if (/;\s*max-age=0(?:;|$)/i.test(cookie)) cookies.delete(name);
        else cookies.set(name, pair.slice(at + 1));
      }
      const text = await response.text();
      return { status, text, headers: response.headers };
    } catch {
      throw new Echo360Error(stage, status);
    }
  }
  return {
    launch(endpoint: string, fields: URLSearchParams) {
      return serial(async () => {
        try { host = new URL(endpoint).origin; } catch { throw new Echo360Error("launch", 0); }
        cookies.clear();
        let url = endpoint;
        let init: RequestInit = { method: "POST", body: fields };
        for (let hop = 0; ; hop++) {
          const response = await request("launch", url, init);
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            try {
              const location = response.headers.get("location");
              if (!location || hop >= 5) throw new Error();
              const next = new URL(location, url);
              if (next.origin !== host) throw new Error();
              url = next.href;
            } catch { throw new Echo360Error("launch", response.status); }
            if (![307, 308].includes(response.status)) init = { method: "GET" };
            continue;
          }
          if (response.status < 200 || response.status >= 300) throw new Echo360Error("launch", response.status);
          const sectionId = new URL(url).pathname.match(new RegExp(`/section/(${UUID})(?:/|$)`, "i"))?.[1]
            ?? response.text.match(new RegExp(`section[s]?[\\/"':= ]+(${UUID})`, "i"))?.[1];
          if (!sectionId) throw new Echo360Error("launch", response.status);
          return { host, sectionId };
        }
      });
    },
    syllabus(sectionId: string): Promise<EchoLesson[]> {
      return serial(async () => {
        const response = await request("syllabus", `${host}/section/${encodeURIComponent(sectionId)}/syllabus`);
        try {
          if (response.status !== 200) throw new Error();
          const json = JSON.parse(response.text);
          if (!Array.isArray(json.data)) throw new Error();
          const lessons: EchoLesson[] = [];
          for (const row of json.data) {
            for (const entry of Array.isArray(row?.lessons) ? row.lessons : [row]) {
              const lesson = entry?.lesson;
              if (typeof lesson?.lesson?.id !== "string") continue;
              lessons.push({
                lessonId: lesson.lesson.id,
                title: lesson.lesson.displayName ?? lesson.lesson.name ?? "Untitled",
                startUtc: lesson.startTimeUTC ?? lesson.lesson.timing?.start ?? null,
                medias: (Array.isArray(lesson.medias) ? lesson.medias : [])
                  .filter((m: { id?: unknown }) => typeof m?.id === "string")
                  .map((m: { id: string; title?: string; isAvailable?: boolean; isHiddenDueToCaptions?: boolean; hidden?: boolean }) => ({
                    id: m.id, title: m.title ?? "", isAvailable: m.isAvailable !== false,
                    hidden: Boolean(m.isHiddenDueToCaptions || m.hidden),
                  })),
              });
            }
          }
          return lessons;
        } catch { throw new Echo360Error("syllabus", response.status); }
      });
    },
    captionsVtt(lessonId: string, mediaId: string) {
      return serial(async () => {
        const response = await request("captions", `${host}/api/ui/echoplayer/lessons/${encodeURIComponent(lessonId)}/medias/${encodeURIComponent(mediaId)}/transcript-file?format=vtt`);
        if (response.status === 403 || response.status === 404) return null;
        if (response.status < 200 || response.status >= 300) throw new Echo360Error("captions", response.status);
        if (!/^text\/vtt(?:;|$)/i.test(response.headers.get("content-type") ?? "")) return null;
        return response.text.trim() ? response.text : null;
      });
    },
  };
}

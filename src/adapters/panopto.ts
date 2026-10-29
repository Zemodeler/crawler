/** Read-only Panopto captions client. Cookies are sent only to the Panopto site. */
export class PanoptoError extends Error {
  readonly stage: string;
  readonly status: number;
  constructor(stage: string, status: number) {
    super(`${stage}: ${status}`);
    this.name = "PanoptoError";
    this.stage = stage;
    this.status = status;
  }
}

/** Panopto sites by university id; their lecture links in the VLE are read for captions. */
export const PANOPTO_SITES: Readonly<Record<string, string>> = {
  surrey: "https://surrey.cloud.panopto.eu",
};

export type PanoptoSession = { deliveryId: string; title: string; startUtc: string | null; hasCaptions: boolean };
export type PanoptoDelivery = { title: string; startUtc: string | null; languages: number[] };

const GUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PAGE_SIZE = 100;
const MAX_PAGES = 10;
// DeliveryInfo's SessionStartTime counts seconds from 1601-01-01 (site local time).
const SECONDS_1601_TO_1970 = 11_644_473_600;

/** Folder and delivery ids in Panopto links to `site` found in `text` (URLs, HTML or embeds). */
export function panoptoRefs(text: string, site: string): { folders: string[]; deliveries: string[] } {
  const folders = new Set<string>();
  const deliveries = new Set<string>();
  let host: string;
  try { host = new URL(site).host; } catch { return { folders: [], deliveries: [] }; }
  const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // A quote ends a link unless it wraps a folder id, as in List.aspx#folderID="<guid>".
  const links = text.replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
    .match(new RegExp(`https?://${escaped}/Panopto/(?:[^\\s"'<>]|["'](?=${GUID}))*`, "gi")) ?? [];
  for (const link of links) {
    let decoded = link;
    try { decoded = decodeURIComponent(link); } catch { /* keep it encoded */ }
    const folder = decoded.match(new RegExp(`[?#&]folderID=["']?(${GUID})`, "i"))?.[1];
    if (folder) folders.add(folder.toLowerCase());
    // Viewer and Embed take a delivery id as id=; pid= (public id) is not followed.
    const delivery = decoded.match(new RegExp(`/Pages/(?:Viewer|Embed)\\.aspx\\?(?:[^#]*&)?id=(${GUID})`, "i"))?.[1];
    if (delivery) deliveries.add(delivery.toLowerCase());
  }
  return { folders: [...folders], deliveries: [...deliveries] };
}

/** "/Date(1790157842965)/" -> ISO; null when absent. */
function msDate(value: unknown): string | null {
  const ms = typeof value === "string" ? Number(/\/Date\((-?\d+)/.exec(value)?.[1]) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function createPanoptoClient({ site, cookies = "", fetch: doFetch = globalThis.fetch, pauseMs = 500 }: {
  site: string; cookies?: string; fetch?: typeof fetch; pauseMs?: number;
}) {
  let host = "";
  try { host = new URL(site).origin; } catch { /* every request fails below */ }
  let tail: Promise<unknown> = Promise.resolve();
  let requested = false;
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const result = tail.then(work);
    tail = result.catch(() => {});
    return result;
  };
  async function request(stage: string, path: string, init: RequestInit = {}) {
    let status = 0;
    try {
      if (!host) throw new PanoptoError(stage, 0);
      const url = new URL(path, host);
      if (url.origin !== host) throw new PanoptoError(stage, 0);
      if (requested) await new Promise((resolve) => setTimeout(resolve, Math.max(0, pauseMs)));
      requested = true;
      const headers = new Headers(init.headers);
      if (cookies) headers.set("cookie", cookies);
      // An ended session redirects to the sign-in page; that must not look like an answer.
      const response = await doFetch(url.href, { ...init, headers, redirect: "manual" });
      status = response.status;
      const text = await response.text();
      return { status, text, headers: response.headers };
    } catch {
      throw new PanoptoError(stage, status);
    }
  }
  return {
    /** Sessions in one folder, oldest first. */
    sessions(folderId: string): Promise<PanoptoSession[]> {
      return serial(async () => {
        const sessions: PanoptoSession[] = [];
        for (let page = 0; page < MAX_PAGES; page++) {
          const response = await request("sessions", "/Panopto/Services/Data.svc/GetSessions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ queryParameters: {
              query: null, sortColumn: 1, sortAscending: true, maxResults: PAGE_SIZE, page, startDate: null, endDate: null,
              folderID: folderId, bookmarked: false, getFolderData: false, isSharedWithMe: false, includePlaylists: false,
            } }),
          });
          let rows: unknown[];
          try {
            if (response.status !== 200) throw new Error();
            rows = JSON.parse(response.text)?.d?.Results;
            if (!Array.isArray(rows)) throw new Error();
          } catch { throw new PanoptoError("sessions", response.status); }
          for (const row of rows as { DeliveryID?: unknown; SessionName?: unknown; StartTime?: unknown; HasCaptions?: unknown }[]) {
            if (typeof row?.DeliveryID !== "string" || !new RegExp(`^${GUID}$`, "i").test(row.DeliveryID)) continue;
            sessions.push({
              deliveryId: row.DeliveryID.toLowerCase(),
              title: typeof row.SessionName === "string" && row.SessionName ? row.SessionName : "Untitled",
              startUtc: msDate(row.StartTime),
              hasCaptions: row.HasCaptions !== false,
            });
          }
          if (rows.length < PAGE_SIZE) break;
        }
        // Undated sessions go last.
        return sessions.sort((a, b) => (a.startUtc ?? "~").localeCompare(b.startUtc ?? "~"));
      });
    },
    /** Title, date and caption languages of one recording; null when it is not viewable. */
    delivery(deliveryId: string): Promise<PanoptoDelivery | null> {
      return serial(async () => {
        const response = await request("delivery", "/Panopto/Pages/Viewer/DeliveryInfo.aspx", {
          method: "POST",
          body: new URLSearchParams({ deliveryId, responseType: "json" }),
        });
        if (response.status === 403 || response.status === 404) return null;
        try {
          if (response.status !== 200) throw new Error();
          const json = JSON.parse(response.text);
          // Missing, private or deleted recordings answer 200 with an ErrorCode.
          if (json?.ErrorCode !== undefined && json?.ErrorCode !== null) return null;
          const delivery = json?.Delivery;
          if (!delivery || typeof delivery !== "object") throw new Error();
          const start = Number(delivery.SessionStartTime);
          const languages = [
            ...(Array.isArray(delivery.AvailableCaptions) ? delivery.AvailableCaptions.map((c: { Language?: unknown }) => c?.Language) : []),
            ...(Array.isArray(delivery.AvailableLanguages) ? delivery.AvailableLanguages : []),
          ].filter((n): n is number => Number.isInteger(n));
          return {
            title: typeof delivery.SessionName === "string" && delivery.SessionName ? delivery.SessionName : "Untitled",
            startUtc: Number.isFinite(start) && start > SECONDS_1601_TO_1970
              ? new Date((start - SECONDS_1601_TO_1970) * 1000).toISOString() : null,
            languages: delivery.HasCaptions === false ? [] : [...new Set(languages)],
          };
        } catch { throw new PanoptoError("delivery", response.status); }
      });
    },
    /** SRT captions in `language` (a Panopto language number), or null when there are none. */
    captionsSrt(deliveryId: string, language: number) {
      return serial(async () => {
        const query = new URLSearchParams({ id: deliveryId, language: String(language) });
        const response = await request("captions", `/Panopto/Pages/Transcription/GenerateSRT.ashx?${query}`);
        if (response.status === 403 || response.status === 404) return null;
        if (response.status < 200 || response.status >= 300) throw new PanoptoError("captions", response.status);
        if (/^text\/html(?:;|$)/i.test(response.headers.get("content-type") ?? "")) return null;
        return response.text.trim() ? response.text : null;
      });
    },
  };
}

/** SRT to plain text: drops cue numbers, timings, tags, Panopto's auto-caption notice and consecutive repeats. */
export function srtToText(srt: string): string {
  const out: string[] = [];
  for (const block of srt.replace(/^\s+/, "").replace(/\r\n?/g, "\n").split(/\n{2,}/)) {
    const lines = block.split("\n").filter(Boolean);
    const at = lines.findIndex((line) => line.includes("-->"));
    if (at < 0) continue;
    for (const line of lines.slice(at + 1)) {
      const text = line.replace(/<[^>]+>/g, "").trim();
      if (!text || /^\[Auto-generated transcript\b[^\]]*\]$/i.test(text)) continue;
      if (out[out.length - 1] !== text) out.push(text);
    }
  }
  return out.join("\n");
}

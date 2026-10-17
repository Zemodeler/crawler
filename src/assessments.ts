import { decodeEntities } from "./extract/xml.ts";

export type AssessmentComponent = {
  module: string;
  year: string;
  seq: string | null;
  type: string | null;
  description: string;
  weight: number | null;
  submission: string | null;
  resit: boolean;
  source: { url: string; localPath?: string; title: string };
};

type OverviewRow = Omit<AssessmentComponent, "module" | "year" | "source">;

const HTML_ENTITIES: Record<string, string> = {
  ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", hellip: "…", pound: "£", nbsp: "\u00a0",
};

const text = (html: string) => decodeEntities(html.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]*>/g, " ")
  .replace(/&([a-z]+);/gi, (match, name: string) => HTML_ENTITIES[name.toLowerCase()] ?? match)).replace(/\s+/g, " ").trim();

/** Read assessment components from tables identified by their first row. */
export function parseAssessmentOverview(html: string): OverviewRow[] {
  const components: OverviewRow[] = [];
  for (const table of html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table\s*>/gi)) {
    const rows = [...table[1]!.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)].map((row) =>
      [...row[1]!.matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]\s*>/gi)].map((cell) => text(cell[1]!)),
    );
    const headers = rows.shift() ?? [];
    const descriptionIndex = headers.findIndex((header) => /description/i.test(header));
    const weightIndex = headers.findIndex((header) => /weight/i.test(header));
    if (descriptionIndex < 0 || weightIndex < 0) continue;
    const seqIndex = headers.findIndex((header) => /^seq\b/i.test(header));
    const typeIndex = headers.findIndex((header) => /^type$/i.test(header));
    const submissionIndex = headers.findIndex((header) => /submission\s+deadline/i.test(header));
    for (const row of rows) {
      if (!row.some(Boolean)) continue;
      const seq = row[seqIndex] || null;
      const description = row[descriptionIndex] ?? "";
      const rawWeight = row[weightIndex] ?? "";
      const weight = /^\d+(?:\.\d+)?\s*%?$/.test(rawWeight) ? Number(rawWeight.replace(/\s*%$/, "")) : null;
      components.push({ seq, type: row[typeIndex] || null, description, weight, submission: row[submissionIndex] || null, resit: seq === "999" || /resit/i.test(description) });
    }
  }
  return components;
}

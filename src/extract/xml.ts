/**
 * Just enough XML for Office text: find elements by local name, read
 * attributes and text, decode entities. Office XML is machine-written and
 * regular, so regular expressions are enough and no parser is needed.
 */

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Decodes XML (and the common HTML) character references. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED[ref.toLowerCase()] ?? match;
  });
}

/**
 * Every <name> element (any namespace prefix), in order, with its attribute
 * string and body. Elements of the same name nested inside one another are
 * not supported; Office text never nests them.
 */
export function elements(xml: string, name: string): { attrs: string; body: string }[] {
  const pattern = new RegExp(`<(?:\\w+:)?${name}(\\s[^>]*?)?(?:/>|>([\\s\\S]*?)</(?:\\w+:)?${name}>)`, "g");
  const out: { attrs: string; body: string }[] = [];
  for (const match of xml.matchAll(pattern)) out.push({ attrs: match[1] ?? "", body: match[2] ?? "" });
  return out;
}

/** One attribute's value from an element's attribute string, ignoring the namespace prefix. */
export function attr(attrs: string, name: string): string | null {
  const match = new RegExp(`(?:^|\\s)(?:\\w+:)?${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attrs);
  return match ? decodeEntities(match[1] ?? match[2] ?? "") : null;
}

/**
 * The text of an Office run container: the contents of every <t> element,
 * with tabs and line breaks where the XML has them.
 */
export function runText(xml: string): string {
  let out = "";
  const token = /<(?:\w+:)?(t|tab|br|cr)(\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?\1>)/g;
  for (const match of xml.matchAll(token)) {
    if (match[1] === "t") out += decodeEntities(match[3] ?? "");
    else if (match[1] === "tab") out += "\t";
    else out += "\n";
  }
  return out;
}

/** Collapses runs of spaces, trims each line and drops runs of blank lines. */
export function tidy(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

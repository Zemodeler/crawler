// Scores a library's Deadlines.json against a hand-labelled gold set:
//   node tools/eval/score.mjs [dir] [root]
// dir defaults to out/replay (holding gold.json), root to <dir>/root. gold.json lists
// [{ module, name, match: title regex, due?: "YYYY-MM-DD", expect: status, optional?: true }].
// Each deadline counts for the gold entry due that day, else the first whose regex fits its title.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const base = resolve(process.argv[2] ?? join(repo, "out", "replay"));
const root = resolve(process.argv[3] ?? join(base, "root"));
const gold = JSON.parse(readFileSync(join(base, "gold.json"), "utf8"));
const raw = JSON.parse(readFileSync(join(root, "Deadlines.json"), "utf8"));
const out = (Array.isArray(raw) ? raw : raw.deadlines).filter((d) => d.status !== "cancelled");
const day = (iso) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date(iso));
const hits = new Map(gold.map((g) => [g, []]));
const extras = [];
for (const d of out) {
  const mine = gold.filter((g) => g.module === d.module);
  const g = (d.due && mine.find((g) => g.due && day(d.due.iso) === g.due)) ?? mine.find((g) => new RegExp(g.match, "i").test(d.title));
  if (g) hits.get(g).push(d); else extras.push(d);
}
let ok = 0, wrong = 0, missing = 0, dup = 0, required = 0;
for (const [g, ds] of hits) {
  if (!g.optional) required++;
  let verdict;
  if (ds.length === 0) { verdict = g.optional ? "skip" : "MISSING"; if (!g.optional) missing++; }
  else {
    const best = ds.find((d) => (g.due ? d.due && day(d.due.iso) === g.due : true) && d.status === g.expect) ;
    if (best) { verdict = "ok"; if (!g.optional) ok++; } else { verdict = "WRONG"; wrong++; }
    dup += ds.length - 1;
  }
  console.log(`${verdict.padEnd(7)} ${g.module} ${g.name}  <- ${ds.map((d) => `[${d.status} ${d.due ? day(d.due.iso) : "-"} "${d.title}"]`).join(" ")}`);
}
for (const d of extras) console.log(`EXTRA   ${d.module} [${d.status} ${d.due ? day(d.due.iso) : "-"} "${d.title}"]`);
console.log(`\nrequired ${required}: ok ${ok}, wrong ${wrong}, missing ${missing}; duplicates ${dup}, extras ${extras.length}; total ${out.length}`);

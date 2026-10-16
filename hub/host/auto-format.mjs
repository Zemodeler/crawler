/** Keep Crawler's downloaded materials browsable in Study Hub after each sync.
 * Only the derived materials index is written. An index edited by the student,
 * or one produced by the Converter, is left alone.
 */

import { createHash } from "node:crypto";
import { readFile, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { SPEC, SUPPORTED_EXTS, inferCategory } from "../lib/course-format.ts";
import { buildMaterialsIndex } from "../lib/course-render.ts";
import { listLibrary } from "./library.mjs";

const STATE_FILE = ".study-hub/auto-format.json";
const digest = (text) => createHash("sha256").update(text).digest("hex");

async function readText(path) {
  try { return await readFile(path, "utf8"); } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/** Optional moduleKeys are the synced `<year>/<module>` folders. */
export async function formatLibrary(root, moduleKeys) {
  const tree = await listLibrary(root);
  const selected = moduleKeys ? new Set(moduleKeys) : null;
  const results = [];
  for (const { year, modules } of tree.years) for (const folder of modules) {
    const key = `${year}/${folder}`;
    if (selected && !selected.has(key)) continue;
    const dir = join(root, year, folder);
    const prefix = `${key}/`;
    const files = tree.files
      .filter((entry) => entry.path.startsWith(prefix))
      .map((entry) => {
        const path = entry.path.slice(prefix.length);
        const name = path.split("/").at(-1);
        const ext = name.split(".").at(-1)?.toLowerCase() || "";
        return { path, name, ext, category: inferCategory(path, ext) };
      })
      .filter((file) => SUPPORTED_EXTS.has(file.ext) && file.path.startsWith(`${SPEC.materialsDir}/`) && file.path !== SPEC.materialsIndex);
    if (!files.length) continue;

    const indexPath = join(dir, ...SPEC.materialsIndex.split("/"));
    const statePath = join(dir, ...STATE_FILE.split("/"));
    const current = await readText(indexPath);
    let state = null;
    try { state = JSON.parse(await readFile(statePath, "utf8")); } catch { /* No owned index yet. */ }
    if (current !== null && (!state?.sha256 || digest(current) !== state.sha256)) {
      results.push({ module: key, action: "preserved" });
      continue;
    }

    const hasHub = (await readText(join(dir, SPEC.hub))) !== null;
    const content = buildMaterialsIndex(files, { hasHub });
    if (content === current) {
      results.push({ module: key, action: "unchanged" });
      continue;
    }
    await mkdir(join(dir, SPEC.materialsDir), { recursive: true });
    await mkdir(join(dir, ".study-hub"), { recursive: true });
    if (current === null) {
      try { await writeFile(indexPath, content, { encoding: "utf8", flag: "wx" }); }
      catch (error) {
        if (error.code !== "EEXIST") throw error;
        results.push({ module: key, action: "preserved" });
        continue;
      }
    } else {
      const temp = `${indexPath}.${process.pid}.tmp`;
      await writeFile(temp, content, "utf8");
      await rename(temp, indexPath);
    }
    await writeFile(statePath, `${JSON.stringify({ sha256: digest(content) })}\n`, "utf8");
    results.push({ module: key, action: current === null ? "created" : "updated" });
  }
  return results;
}

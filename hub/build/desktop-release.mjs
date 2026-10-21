/** Isolated, inspectable unsigned release builds. Never cleans an existing path. */
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import ts from "typescript";
import builderConfig from "../electron-builder.config.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);
export const BUILDER = "electron-builder@26.15.3";

export async function copyCode(source, destination) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Refusing source symlink: ${from}`);
    if (entry.isDirectory()) await copyCode(from, join(destination, entry.name));
    else if (/\.(mjs|ts)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      let code = await readFile(from, "utf8");
      if (entry.name.endsWith(".ts")) {
        code = ts.transpileModule(code, {
          compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, verbatimModuleSyntax: true },
          fileName: from,
        }).outputText;
      }
      // Rewrite only module specifiers, including dynamic import and re-exports.
      code = code.replace(/((?:from\s*|import\s*\(\s*|import\s*)["'][^"']+)\.ts(["'])/g, "$1.js$2");
      await writeFile(join(destination, entry.name.replace(/\.ts$/, ".js")), code);
    }
  }
}

export async function stageRuntime({ root = ROOT, destination, dist, pdfPackage }) {
  // mkdir without recursive is deliberate: never overwrite previous staging.
  await mkdir(destination);
  const crawler = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const hub = JSON.parse(await readFile(join(root, "hub/package.json"), "utf8"));
  await readFile(join(dist, "server/BUILD_ID"), "utf8");
  await readFile(join(dist, "server/index.js"), "utf8");
  for (const folder of ["src", "bin", "hub/host", "hub/shell", "hub/lib"])
    await copyCode(join(root, folder), join(destination, folder));
  await cp(dist, join(destination, "hub/dist"), { recursive: true, dereference: true });
  await cp(join(root, "hub/public"), join(destination, "hub/public"), { recursive: true });
  // No nested hub package.json: crawler self-reference resolves to this root.
  // This also retains host/library's ../../src relative imports.
  await writeFile(join(destination, "package.json"), JSON.stringify({
    name: "crawler", productName: "Study Hub", version: hub.version,
    description: crawler.description, private: true, type: "module",
    main: "hub/shell/main.mjs", packageManager: "npm@10.9.2",
    exports: Object.fromEntries(Object.entries(crawler.exports).map(([key, value]) => [key, value.replace(/\.ts$/, ".js")])),
    dependencies: { "pdfjs-dist": "6.2.108" },
  }, null, 2) + "\n");
  const pdf = pdfPackage ?? dirname(require.resolve("pdfjs-dist/package.json"));
  await copyRuntimePackage(pdf, join(destination, "node_modules"));
}

async function copyRuntimePackage(source, modules, copied = new Map()) {
  const metadata = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
  if (copied.has(metadata.name)) {
    if (copied.get(metadata.name) !== metadata.version) throw new Error(`Conflicting runtime versions: ${metadata.name}`);
    return;
  }
  copied.set(metadata.name, metadata.version);
  await cp(source, join(modules, metadata.name), {
    recursive: true, dereference: true,
    filter: (path) => !path.slice(source.length).split(/[\\/]/).includes("node_modules"),
  });
  const localRequire = createRequire(join(source, "package.json"));
  for (const name of Object.keys({ ...metadata.dependencies, ...metadata.optionalDependencies })) {
    let manifest;
    try { manifest = localRequire.resolve(`${name}/package.json`); }
    catch (error) {
      if (error.code === "MODULE_NOT_FOUND" && metadata.optionalDependencies?.[name]) continue;
      throw error;
    }
    await copyRuntimePackage(dirname(manifest), modules, copied);
  }
  // PDF.js needs the canvas DOMMatrix polyfill even for text extraction in Node.
  if (metadata.name === "pdfjs-dist" && !copied.has("@napi-rs/canvas"))
    throw new Error("PDF.js requires the target OS @napi-rs/canvas optional dependency; install optional dependencies before staging");
}

function run(command, args, cwd, env = {}) {
  return new Promise((accept, reject) => {
    // Bypass the Windows cmd shim so paths with spaces/metacharacters stay argv.
    const corepack = join(dirname(process.execPath), "node_modules/corepack/dist/corepack.js");
    if (process.platform === "win32") {
      if (!existsSync(corepack)) return reject(new Error("Corepack must be installed beside Node on Windows"));
      args = [corepack, ...args];
      command = process.execPath;
    }
    const child = spawn(command, args, { cwd, stdio: "inherit", shell: false, env: { ...process.env, ...env } });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? accept() : reject(new Error(`${command} exited ${code}`)));
  });
}

export async function release(args = process.argv.slice(2)) {
  const platform = args.includes("--mac") ? "mac" : "win";
  if (args.some((arg) => !["--mac", "--win", "--dir", "--stage-only", "--build"].includes(arg) && !arg.startsWith("--dist=")))
    throw new Error("Use --win or --mac, optionally --dir, --stage-only, --build or --dist=path");
  const distArg = args.find((arg) => arg.startsWith("--dist="));
  if (distArg && args.includes("--build")) throw new Error("Choose --build or --dist, not both");
  if (args.includes("--mac") && args.includes("--win")) throw new Error("Choose one platform");
  if (!args.includes("--stage-only") && ((platform === "mac" && process.platform !== "darwin") || (platform === "win" && process.platform !== "win32")))
    throw new Error("Package on the target OS; cross-platform verification is not supported");
  const outputs = join(ROOT, "hub/outputs");
  await mkdir(outputs, { recursive: true });
  const work = await mkdtemp(join(outputs, "desktop-release-"));
  console.log(`Release workspace: ${work}`);
  let dist = distArg ? resolve(distArg.slice(7)) : join(ROOT, "hub/dist");
  if (args.includes("--build")) {
    const source = join(work, "source");
    await mkdir(join(source, "hub"), { recursive: true });
    for (const name of ["package.json", "src", "bin"])
      await cp(join(ROOT, name), join(source, name), { recursive: true });
    for (const name of ["package.json", "app", "lib", "public", "worker", "build", "vite.config.ts", "postcss.config.mjs", "tsconfig.json", "next.config.ts", "next-env.d.ts"])
      await cp(join(ROOT, "hub", name), join(source, "hub", name), { recursive: true });
    // Installation happens only in this newly created source copy, never the linked checkout.
    await run("corepack", ["pnpm", "install", "--ignore-scripts"], join(source, "hub"));
    await run("corepack", ["pnpm", "build"], join(source, "hub"));
    dist = join(source, "hub/dist");
  }
  const stage = join(work, "app");
  await stageRuntime({ destination: stage, dist });
  const config = { ...builderConfig, electronVersion: "44.7.2", directories: { app: stage, output: join(work, "artifacts") } };
  const configPath = join(work, "builder.json");
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
  await writeFile(join(work, "release.json"), JSON.stringify({ platform, arch: process.arch, stage, dist, unsigned: true, automaticUpdates: false, builder: BUILDER }, null, 2) + "\n");
  console.log(`Staged runtime: ${stage}`);
  if (!args.includes("--stage-only"))
    await run("corepack", ["pnpm", "dlx", BUILDER, "--projectDir", stage, "--config", configPath, `--${platform}`, ...(args.includes("--dir") ? ["--dir"] : []), "--publish", "never"], ROOT, { CSC_IDENTITY_AUTO_DISCOVERY: "false" });
  return work;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  release().catch((error) => { console.error(error.message); process.exitCode = 1; });

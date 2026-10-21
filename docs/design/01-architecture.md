# 01 — Architecture

How Crawler and Study Hub ship as one app with no bridge, no pairing and no
manual linking.

## Historical starting point (Study Hub alone)

```
Browser tab (Study Hub page, localhost:3000)
   │  File System Access API  ──▶ course folder (user picks it)
   │  fetch + pairing token   ──▶ bridge (separate Node window, :8787–8797)
   │                                 └─ spawns claude / codex
Launcher .exe (C#, Windows only) ── installs CLI, starts local server, opens browser
```

Pain points: the user starts a second program, copies a pairing code, accepts
Chrome's local-network prompt, and picks a folder. The CLI-finding logic exists
twice (`bridge/index.mjs` `findCli()` and `launcher/CliLocator.cs`), synced by
hand.

## Target: one local host in a cross-platform shell

```
Desktop shell (Electron, Windows + macOS)
  ├─ tray / menu-bar icon, notifications, start at login, manual updates
  ├─ app window ── same origin ──▶ host
  ├─ login window (sandboxed session) ── only during VLE sign-in
  └─ runs ──▶ Study Hub Host  (Node, one process, 127.0.0.1)
                           ├─ serves the Study Hub UI          GET  /
                           ├─ AI runner (claude/codex CLI)     POST /api/ai/*
                           ├─ Library API (folder on disk)     GET  /api/library/*
                           ├─ Crawler engine (library)         POST /api/crawl/*
                           │    ├─ university adapters
                           │    ├─ sorter, extractor, differ
                           │    └─ scheduler (re-sync)
                           └─ Calendar sync (Google, .ics)
```

The host is also reachable from a normal browser tab at the same address, for
anyone who prefers that over the app window.

### Why this removes the bridge

The pairing code existed because a page on one origin was calling a program on
another, and *any* website can try to reach localhost. When the host **serves
the page itself**, the page and the API share one origin:

- At start-up the host generates a 128-bit session secret.
- It sets it on the page it serves as an `HttpOnly; SameSite=Strict` cookie.
- Every `/api/*` route requires that cookie **and** a custom header, and checks
  `Host` and `Origin` against `127.0.0.1:<port>` / `localhost:<port>`.

A foreign site can neither read the cookie nor send it (SameSite=Strict), and
the custom header forces a CORS preflight the host never approves for foreign
origins. The protection the pairing code gave is kept; the user step is gone.
The bridge's other guards carry over unchanged: CLI spawned with `shell:false`,
argv array, empty temp cwd, scrubbed environment, `ANTHROPIC_API_KEY` /
`OPENAI_API_KEY` stripped, filesystem and shell tools disallowed for the CLI.

### Why this removes the folder picker

The host knows where `My Studies/` lives (it created it). The UI reads files
through `/api/library/*` instead of File System Access. Side effects:

- No "choose a folder" step; no permission prompt.
- Firefox and Safari work, since File System Access is no longer required.
- The existing File System Access path stays as a second backend for people
  who open a hand-built folder from the hosted site.

`lib/course-fs.ts` already centralises folder access, so the change is a
backend swap behind one interface, not a rewrite of the reader.

## Repository layout

The original split below describes component ownership. This checkout now contains
the engine at `src/`, desktop adapters at `bin/`, and Study Hub at `hub/`.
The development dependency `crawler: link:..` is not a distributable package.

| Repo | Contains | Runs standalone? |
| --- | --- | --- |
| `crawler` (this repo) | Engine as a TypeScript library: adapters, sorter, extractor, differ, calendar sync, scheduler. A small CLI (`crawler sync`, `crawler login`) for headless use and development. | Yes — the CLI writes `My Studies/` with no UI. |
| `universal-study-hub` | UI, the host server, the desktop shell and installers. Depends on `crawler` as a package. | Yes — opens any course folder. |

The AI runner lives in the host (`universal-study-hub`) and is passed into the
crawler as an interface, so the crawler never spawns processes on its own and
can be tested with a fake.

```ts
interface AiRunner {
  available(): Promise<{ cli: "claude" | "codex" | null }>;
  structured<T>(req: { system: string; prompt: string; schema: JsonSchema }): Promise<T>;
}
```

## Process model

- **Desktop shell** (Electron): one codebase for Windows and macOS. It
  replaces the C# launcher (`launcher/*.cs`), which is Windows-only. It provides:
  - tray icon (Windows) / menu-bar icon (macOS) with "Sync now",
    "Open Study Hub", "Quit"; keeps running so scheduled re-sync can happen
  - native notifications (Windows toasts, macOS Notification Center)
  - optional start at login (`app.setLoginItemSettings`)
  - single-instance lock; manual update instructions (no trusted release feed configured)
  - first-run setup: finds `claude`/`codex`, walks the student through
    signing in to one if neither is ready, then signs in to the VLE
- **Host** (Node): runs in the shell's main process. Bundled Node, so
  there's no separate "install Node" step any more.
- **Login window**: an Electron window with its own isolated session, open only
  during VLE sign-in. It intercepts the `moodlemobile://` redirect directly
  (see 02), so there's no `playwright-core` and no dependency on which browser
  the student has installed. The university's Microsoft (SAML) sign-in works in
  an embedded window. Google sign-in does **not** (Google blocks embedded
  browsers), which is why Google Calendar consent goes through the system
  browser instead (see 05).

**Decided (2026-10-15).** Why Electron rather than keeping the C# launcher and
adding a Swift one:
two native launchers would duplicate CLI detection, tray, notifications and
updates, and the CLI-finder duplication already exists today. Electron's cost is
size: a ~100 MB install. That's acceptable for a desktop app students install
once. Tauri would be smaller, but it adds Rust to a TypeScript project.

## Local state

| What | Windows | macOS | Notes |
| --- | --- | --- | --- |
| Course files, deadlines, `.ics` | `Documents\My Studies` | `~/Documents/My Studies` | The folder contract — see 03. Changeable. |
| Crawl manifest | `My Studies/.crawler/` | same | Hidden; Study Hub already skips dotfolders. |
| VLE tokens, Google refresh token | encrypted with Electron `safeStorage` (DPAPI) | `safeStorage` (Keychain) | Never in the folder, never in logs. On Windows the key lives in `Local State` inside the app-data folder, so a token only decrypts there: **never change the app name or the data folder** without migrating both files. |
| Settings, logs | `%APPDATA%\Study Hub` | `~/Library/Application Support/Study Hub` | Electron `app.setName("Study Hub")`; preserve this identity during upgrades. |
| Study progress | app window storage (IndexedDB) | same | Study Hub's existing model. |

## Cross-platform specifics

- **Finding the CLI on macOS.** Apps opened from Finder don't inherit the
  shell's `PATH`, so `claude` installed via npm, Homebrew or its native
  installer is invisible to a naive lookup. The host resolves it through the
  user's login shell (`$SHELL -lc 'command -v claude'`), then checks known
  locations (`/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`,
  `~/.npm-global/bin`, `~/.claude/local`), and reports what it searched, the
  same way the bridge does on Windows today.
- **Filenames.** Sanitise for the stricter of both: Windows reserved names and
  characters, plus `:` and leading dots on macOS.
- **Opening a cited page.** `shell.openPath` for the file; PDFs cited by page
  open in the app's built-in viewer at `#page=N`, which behaves the same on both.
- **Signing.**
  - macOS: local builds are unsigned and unnotarized, and Gatekeeper may block
    them. Developer ID signing/notarization and real Mac validation remain
    external release requirements; upgrades currently replace the app manually.
  - Windows: unsigned installers may trigger SmartScreen. Signing remains an
    external requirement for a public release.
- **Local packaging** builds an unsigned Windows NSIS `.exe` or a native-architecture
  macOS `.dmg` on the corresponding OS. There is no release CI, universal macOS
  verification, publishing configuration, or trusted update feed in this work.
- **Linux** works from source (`pnpm start`) but isn't a supported target.

## Desktop release delivery (local unsigned path)

`hub/build/desktop-release.mjs` creates a new workspace under `hub/outputs/`
for each invocation. `--build` copies only source/build inputs and installs
dependencies there with lifecycle scripts disabled; vinext never rebuilds the
live `hub/dist`. The default without `--build` stages an already completed
`hub/dist`. Failed and previous workspaces remain available for inspection.

The staged application root is a `crawler` package with `main` pointing at
`hub/shell/main.mjs`. There is deliberately no nested `hub/package.json`:
shell imports of `crawler` and `crawler/electron` resolve by package
self-reference. Host imports such as `../../src/deadline-store.ts` retain
their relative topology. Runtime `.ts` files are transpiled to `.js`, with
module specifiers and package exports rewritten; Electron does not need a
TypeScript loader. PDF.js is copied as an external runtime package with its
installed canvas dependency and target OS native binary; missing canvas fails
staging. The vinext UI is already bundled.

`hub/electron-builder.config.mjs` packages that root without ASAR so the
existing host's build snapshot copy/import works on ordinary files. Generated
`builder.json` and `release.json` record the inputs and configuration. Packaging
uses electron-builder 26.15.3, Electron 44.7.2, publishing disabled and signing
disabled. Windows produces a per-user NSIS installer; macOS produces a DMG
for the machine's native architecture. Both require local target-OS checks.
The staged package uses npm's read-only dependency listing for the flat copied
runtime, avoiding pnpm workspace/linked dependency discovery during packaging;
source dependencies are still installed only with pnpm in the isolated copy.

There is no configured Git remote or trusted update authority. The Updates
menu only shows local manual replacement/recovery instructions; it does not
check, download, or install. A future updater requires an explicitly trusted
HTTPS authority and artifact integrity policy, confirmation before download
and installation, and interruption/rollback handling. None is inferred from
the app name. Users must quit from the tray, retain the previous installer,
and preserve `My Studies` and the `Study Hub` application data directory.

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for commands, unsigned installation
limitations, manual recovery, and external release prerequisites. Signing,
notarization, OAuth credentials, distribution licensing and a complete frozen
dependency graph remain maintainer work. No public release or macOS validation
is implied by a Windows packaging smoke check.

## Failure behaviour

- VLE unreachable or token expired → sync marked "needs sign-in", existing
  folder untouched, tray and UI show one clear action.
- A module fails → others continue; failure listed per module.
- CLI missing → structured deadlines still work; document extraction is
  skipped and the UI says why (never silently).

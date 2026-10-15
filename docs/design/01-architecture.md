# 01 — Architecture

How Crawler and Study Hub ship as one app with no bridge, no pairing and no
manual linking.

## Today (Study Hub alone)

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
  ├─ tray / menu-bar icon, notifications, start at login, auto-update
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

## Repositories

Two repos, one install.

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
  - single-instance lock and auto-update from GitHub Releases
  - first-run setup: finds `claude`/`codex`, walks the student through
    signing in to one if neither is ready, then signs in to the VLE
- **Host** (Node): runs inside the shell as a utility process. Bundled Node, so
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
| VLE tokens, Google refresh token | encrypted with Electron `safeStorage` (DPAPI) | `safeStorage` (Keychain) | Never in the folder, never in logs. |
| Settings, logs | `%APPDATA%\StudyHub` | `~/Library/Application Support/StudyHub` | Re-sync interval, calendar choice, enabled modules. |
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
  - macOS: Gatekeeper blocks unsigned apps unless they're signed with an Apple
    Developer ID and notarized ($99/year). **Deferred to M6.** Until then, builds
    are unsigned, and the README tells Mac users to right-click → Open the first
    time. Auto-update on macOS needs a signed app, so Mac friends update by
    downloading the new `.dmg` until then.
  - Windows: an unsigned installer triggers a SmartScreen warning. That's
    survivable for friends, but worth fixing before a public release.
- **CI** builds both: a Windows `.exe` installer and a macOS universal `.dmg`
  (Apple Silicon + Intel), attached to each GitHub Release.
- **Linux** works from source (`pnpm start`) but isn't a supported target.

## Failure behaviour

- VLE unreachable or token expired → sync marked "needs sign-in", existing
  folder untouched, tray and UI show one clear action.
- A module fails → others continue; failure listed per module.
- CLI missing → structured deadlines still work; document extraction is
  skipped and the UI says why (never silently).

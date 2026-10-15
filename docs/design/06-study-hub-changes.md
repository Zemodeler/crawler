# 06 — Study Hub changes

Work in `Zemodeler/universal-study-hub` (cloned at
`C:\Users\andrei\Documents\universal-study-hub`) needed for the combined app.

## 1. Remove the bridge (user-visible linking)

**Problem:** subscription mode needs a separate bridge window, a pairing code
(`SHUB-XXXX-XXXX-XXXX`), and Chrome's local-network permission.

**Change:**
- New `host/` package: one Node server that serves the built site and exposes
  `/api/ai/generate`, `/api/ai/chat`, `/api/ai/health` on the same origin.
  Ports the CLI runner and guards from `bridge/index.mjs` verbatim (spawn
  options, env scrubbing, disallowed tools, timeouts, output caps).
- Auth: per-launch secret in an `HttpOnly; SameSite=Strict` cookie + custom
  header + `Host`/`Origin` check (details in 01). No pairing.
- `lib/ai/bridge.ts` becomes `lib/ai/host.ts`: no port scan, no token in
  `localStorage`; it calls relative URLs.
- AI settings page: "My subscription" just shows which CLI was found and a
  **Test** button. No download, no code to paste.
- Launcher: the C# launcher (`launcher/*.cs`), `bridge/` and the bridge zip
  are replaced by the Electron desktop shell (see Crawler's
  `docs/design/01-architecture.md`). Its useful parts are ported, not lost:
  `InstallSteps.cs` / `CliLogin.cs` (first-run CLI sign-in) and
  `ChooseAssistantForm.cs` (pick Claude or ChatGPT) become first-run screens
  in the shell. CLI detection lives only in the host (one copy, Windows and
  macOS rules).
- Keep a fixed port with a fallback range; the shell reads the chosen port
  from the host at start-up, so nothing else needs to know it.

**Acceptance (both platforms):** fresh Windows profile *and* fresh macOS user,
`claude` signed in → open the app → Study Hub appears → "Test connection"
passes, with zero dialogs other than the first-run setup. On macOS this must
work when the app is opened from Finder, not just from a terminal (the `PATH`
pitfall).

### Spike findings (2026-10-15, branch `spike/host`)

Built and checked on Windows; not yet on macOS.

- **The built site runs in plain Node.** `dist/server/index.js` (the
  Cloudflare-worker build) only imports `node:async_hooks`, so the host imports
  it and calls its `fetch()` directly. No `vinext start`, no Wrangler, no
  second process. Static files are served from `dist/client`.
- **Files:** `host/cli.mjs` (CLI lookup and runner, ported from the bridge),
  `host/index.mjs` (server, cookie auth, `/api/ai/*`), `shell/main.mjs`
  (Electron window + `--selftest`). The client changes are small:
  `isHosted()` in `lib/ai/settings.ts`, a same-origin path in
  `lib/ai/bridge.ts`, and a "Built in" panel instead of the pairing steps in
  `app/connect/page.tsx`.
- **Checked:** curl confirmed that requests without the cookie, without the
  guard header, from a foreign `Origin`, or with a rebinding `Host` are all
  refused. A real `claude` prompt round-trips through the host. Electron
  `--selftest` picks "My subscription" and clicks "Test connection", and gets
  "Connected" for both Claude and Codex. No pairing UI is shown, and the session
  cookie can't be read from script. Typecheck, lint and the 49 existing tests
  pass.
- **CLI discovery was a real gap.** On the dev machine neither CLI is on
  `PATH`. They exist only inside the desktop apps
  (`%APPDATA%\Claude\claude-code\<ver>\<hash>\claude.exe`,
  `%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe`), which the bridge
  never searched. The host searches them, newest first. Both run signed in
  without the desktop app being open.
- **`claude` needs `PowerShell` in `--disallowed-tools` too.** On Windows,
  denying `Bash` doesn't deny the PowerShell tool by itself.
- **CLI re-detection (done):** "Check again" makes the host search afresh
  (`/api/ai/healthz?refresh=1`). A CLI that is missing, or whose saved path no
  longer exists (the desktop apps update into new version folders), is searched
  for again automatically when asked about, at most every 5 s. Search follows
  symlinks and junctions. Checked on Windows: started with no CLIs, then
  installed `claude` (found without a click), installed `codex` (found on
  Check again), moved `claude` to a new version folder (the next run still
  worked), and uninstalled `codex` (reported missing). The Electron self-test
  clicks Check again for both CLIs.
- **Open:** a run that fails because the executable vanished mid-flight
  searches again and retries once. That path is written but not yet exercised
  by a test, because the stale-path check catches the normal update case first.
  Detection uses blocking `--version` calls, so the host pauses for a few
  seconds during a refresh. One self-test run failed partway (an
  `executeJavaScript` error) and later reruns passed; harden the self-test
  before it goes into CI.
- **Wording (done):** in hosted mode, every user-facing message names "Study
  Hub" or "this computer", never a bridge, helper or pairing code. The
  self-test fails if any of those words appear on the AI settings page. Bridge
  wording remains only on the old hosted-website path, which goes away with the
  bridge in M2.

## 2. Library backend (no folder picker)

- Introduce a `CourseSource` interface over today's `lib/course-fs.ts`:
  `list()`, `read(path)`, `write(path, data)`.
- Two implementations: **FileSystemAccessSource** (today's behaviour) and
  **HostSource** (`/api/library/*`, served from `My Studies/`).
- When running under the host, Study Hub opens `My Studies/` automatically.
  The host enforces the same write allowlist and path checks Study Hub has now.

## 3. Multi-module root

- Detect a root that contains course folders, **two levels deep**: academic
  year, then module (`My Studies/2026-27/ECS505U - Software Engineering/`).
  A root is recognised by `Deadlines.json` at the top, or by any grandchild
  that passes the existing format check.
- Year switcher (current year by default) plus module switcher.
- Module switcher in the top bar; the overview shows every module's progress
  side by side; search spans all modules.
- Progress keys gain the module folder as a prefix so two modules with a
  "01 - Introduction" pack don't collide (with a one-time migration for
  existing single-course data).

## 4. Calendar view

- New `/calendar` route reading `Deadlines.json`: month and list views,
  filter by module and kind.
- Each item opens a side panel: status, weight, every source with its quote,
  and **Open source** — which opens the local file at the cited page (PDF
  viewer `#page=N`) or the VLE link.
- Conflicts: both sources side by side, "Use this date" per source, or "Enter
  date". Writes `status: "user-verified"` back through the host.
- TBC list under the calendar. Overview tile: "Next 7 days".

## 5. Subject-neutral

Today's guides and generation prompts assume law (cases, issue-spotting,
problem questions).

- Make the subject a property of a course: `law`, `stem`, `humanities`,
  `general`, inferred from materials and editable.
- Each subject has its own guide set and prompt slots; law keeps today's.
  Example for STEM: "Worked-Problem Technique", "Formula & Definition Index",
  "Past-Paper Question Map".
- Flashcard deck names become per subject ("Foundations and Cases" stays for
  law; STEM gets "Definitions and Theorems", "Problem to Method").
- Accept `Labs and Seminars` as well as `Seminars` in the format check.
- The quote-verification rule applies unchanged to every subject.

## 6. Repo polish (shared with Crawler)

Both repos must "look like a good GitHub project": README with a screenshot and
one-click install, `LICENSE`, `CONTRIBUTING.md`, CI running tests and lint on
every PR on Windows and macOS runners, tagged releases with the Windows `.exe`
and macOS `.dmg` attached, and no real student data anywhere in fixtures.

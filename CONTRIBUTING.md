# Contributing

Crawler and the Study Hub desktop shell live in this repository. Use Node
22.18 or newer (the checked runtime is Node 22.23.3) and Corepack with the
package's pinned pnpm 12.11.2. Do not replace pnpm with npm.

## Development

Install dependencies with `corepack pnpm install` at the root and
`corepack pnpm --dir hub install` for the UI. In managed worktrees where
`node_modules` is linked, leave that installation alone. Run the UI with
`corepack pnpm --dir hub dev`; build it with `corepack pnpm --dir hub build`,
then start the desktop with `corepack pnpm --dir hub app`.

The normal project validation is `corepack pnpm check`. For changes limited to
release delivery, use `corepack pnpm --dir hub desktop:test` instead. There is
no database setup for this application. Desktop selftest uses a real assistant
subscription and is not a packaging test.

## Local unsigned desktop releases

Run on the target OS, from the repository root:

```powershell
# Windows: fresh isolated UI build, then unsigned per-user NSIS installer
corepack pnpm --dir hub desktop:win
# Windows: unpacked executable only, for a packaging smoke check
node hub/build/desktop-release.mjs --win --build --dir
# Optional headless smoke using the produced bundled Electron runtime
$env:STUDYHUB_PACKAGED_EXE = 'C:\path\to\artifacts\win-unpacked\Study Hub.exe'
corepack pnpm --dir hub desktop:test
Remove-Item Env:STUDYHUB_PACKAGED_EXE
```

```sh
# macOS: native architecture DMG; run separately on Intel and Apple Silicon
corepack pnpm --dir hub desktop:mac
```

The tool logs a unique `hub/outputs/desktop-release-*/` workspace. It installs
build dependencies with lifecycle scripts disabled into `source/hub`, builds
there, writes the inspectable runtime into `app`, and writes installers or the
unpacked app into `artifacts`. `builder.json` records the exact packaging
configuration and `release.json` records the target and build input. Failed
workspaces are retained for diagnosis. No cleanup command is provided: neither
the live `hub/dist`, existing outputs, linked dependencies, nor user libraries
are removed. Avoid copying credentials or real libraries into release inputs.

If you already have a completed `hub/dist`, `corepack pnpm --dir hub
desktop:stage` copies it without rebuilding or packaging. Without `--build`,
the low-level release command also uses that existing build. `--dist=path`
selects another completed build (mutually exclusive with `--build`). Do not rebuild
that input concurrently with staging. Staging preserves the engine's relative
directory layout, compiles runtime TypeScript to JavaScript, and retains
`crawler` package self-reference. Electron is pinned to 44.7.2 and the on-demand
builder to 26.15.3. First use requires registry access and Electron/builder
downloads. The build installation currently resolves dependency ranges anew;
this is a local release path, not a reproducible or certified release pipeline.
The checked-in pnpm lockfiles currently contain package-manager bootstrap data,
not a complete frozen application dependency graph.

The unpacked layout is intentional: the host snapshots its built server and
client chunks into a writable temporary directory. Do not enable ASAR without
testing that copy/import path. Only PDF.js is required as an external runtime
package with its installed optional canvas dependency and target OS native binary.
Missing canvas fails staging because PDF.js needs its DOM polyfills. Validate PDF text
extraction on real documents before distributing a build. No license has been
selected by this change; maintainers must resolve distribution licensing and
third-party notices before a public release.

## Install, upgrade, and recover

Windows users run the unsigned NSIS installer (or launch `Study Hub.exe` from
the unpacked folder). macOS users mount the DMG and copy Study Hub.app into
Applications. Unsigned Windows builds can trigger SmartScreen; unsigned,
unnotarized macOS builds can be blocked by Gatekeeper. Do not disable OS security
globally. These are local test builds, not a signed public distribution. macOS
packaging and launch must be verified on a Mac; a Windows build proves neither.

There is no configured Git remote or trusted release feed. The application's
Updates menu explains manual upgrades and never makes update network requests.
Obtain a replacement directly from a trusted maintainer, check its checksum
against one received through a trusted channel, quit from the tray/menu bar,
and install/replace the application. Back up `Documents/My Studies` and the
existing `Study Hub` application data first. Preserve the app name and data
directory so OS-encrypted tokens remain usable. Keep the previous installer or
app bundle: if startup fails, quit and reinstall that version, retaining data.
Backups are needed if future versions introduce incompatible data migrations.

Automatic updates are blocked until maintainers explicitly configure a trusted
HTTPS release authority, platform/architecture artifacts, version policy,
integrity/signature verification and signing credentials where required. Any
future implementation must ask before downloading and again before installing,
reject untrusted redirects/artifacts, and recover from interrupted downloads or
failed installation without replacing a working app. Do not infer a feed from
repository names or accept one supplied by web content.

Google Calendar OAuth credentials and signing/notarization credentials are
external maintainer configuration; none are included or invented here. Never
commit tokens, personal course materials, generated installers, or secrets.

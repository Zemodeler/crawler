"use client";

import { useEffect, useState } from "react";
import ExtractionWarnings from "./extraction-warnings.tsx";
import LegacyLibraryDialog from "./legacy-library-dialog.tsx";

import { LEGACY_LIBRARY, setupStatus, signIn, startSync, watchSync, type SetupStatus, type SyncRun } from "../lib/setup.ts";

/** Sidebar control: sync My Studies again, and say when it last finished. */
export default function SyncButton({ onSynced }: { onSynced: () => void }) {
  const [run, setRun] = useState<SyncRun | null>(null);
  const [signedIn, setSignedIn] = useState(true);
  const [signingIn, setSigningIn] = useState(false);
  const [freshness, setFreshness] = useState("");
  const [error, setError] = useState("");
  const [library, setLibrary] = useState<{ status: SetupStatus; open: boolean } | null>(null);

  /**
   * Follows a running sync, whoever started it (this button, setup, the tray).
   * Each module whose files land shows up straight away, so the student can
   * study it while the slow reading for deadlines carries on.
   */
  const follow = (refreshFirst: boolean) => {
    let ready = refreshFirst ? 0 : -1;
    return watchSync((next) => {
      setRun(next);
      const nowReady = next.filesReady ?? 0;
      if (next.state === "running" && nowReady !== ready) {
        if (ready >= 0 && nowReady > ready) onSynced();
        ready = nowReady;
      }
      if (next.state === "done") {
        setFreshness("last synced just now");
        onSynced();
      }
      // An expired sign-in is cleared by the sync; show the way back in.
      if (next.state === "failed") setupStatus().then((s) => setSignedIn(s.signedIn)).catch(() => {});
    });
  };

  useEffect(() => {
    let stop: (() => void) | undefined;
    let alive = true;
    setupStatus()
      .then((s) => {
        if (!alive) return;
        setRun(s.sync);
        if (s.library?.legacy) setLibrary({ status: s, open: false });
        setSignedIn(s.signedIn);
        setFreshness(s.freshness);
        if (s.sync.state === "running") stop = follow(false);
      })
      .catch(() => {});
    return () => {
      alive = false;
      stop?.();
    };
    // follow only reads setters and onSynced; one watcher per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const begin = async () => {
    setError("");
    try {
      await startSync();
      follow(true);
    } catch (e) {
      if ((e as { code?: string }).code === LEGACY_LIBRARY) {
        setError("");
        const status = await setupStatus().catch(() => null);
        if (status) setLibrary({ status, open: true });
        else setError((e as Error).message);
      } else {
        setError((e as Error).message);
        setupStatus().then((s) => setSignedIn(s.signedIn)).catch(() => {});
      }
    }
  };

  /** Opens the university's sign-in window, then syncs; no trip back through setup. */
  const signInAndSync = async () => {
    setError("");
    setSigningIn(true);
    try {
      await signIn();
      setSignedIn(true);
      setRun(null);
      await begin();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSigningIn(false);
    }
  };

  const libraryChosen = (message: string) => {
    setLibrary(null);
    setFreshness(message);
    onSynced();
    void begin();
  };

  const message = error || (run?.state === "failed" ? run.error : "");
  if (!signedIn || /sign in again/i.test(message ?? ""))
    return (
      <div className="sync-status" aria-live="polite">
        <button className="switch sync-button" onClick={signInAndSync} disabled={signingIn}>
          {signingIn ? "Waiting for you to sign in…" : "Sign in to sync"}
        </button>
        {error && !/sign in again/i.test(error) && <small>{error}</small>}
      </div>
    );

  const time = run?.finishedAt ? new Date(run.finishedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "";
  const found = run?.summary;
  const findings = found
    ? [
        `${run.newFiles} new files`,
        found.conflicts ? `${found.conflicts} conflicting dates` : "",
        found.needsCheck ? `${found.needsCheck} dates to check` : "",
      ].filter(Boolean).join(", ")
    : `${run?.newFiles ?? 0} new files`;
  if (library)
    return (
      <div className="sync-status" aria-live="polite">
        <button className="switch sync-button" onClick={() => setLibrary({ ...library, open: true })}>
          Choose how to sync
        </button>
        <small>This library was synced before account records. Choose how to continue.</small>
        {library.open && (
          <LegacyLibraryDialog
            root={library.status.library.root}
            university={library.status.university.name}
            onDone={libraryChosen}
            onClose={() => setLibrary({ ...library, open: false })}
          />
        )}
      </div>
    );

  return (
    <div className="sync-status" aria-live="polite">
      <button className="switch sync-button" onClick={begin} disabled={run?.state === "running"}>
        {run?.state === "running" ? (run.phase === "reading" ? "Reading for deadlines…" : `Syncing… ${run.newFiles} new`) : "Sync now"}
      </button>
      <small>
        {error ||
          (run?.state === "failed"
            ? run.error
            : run?.state === "done"
              ? `Synced at ${time}, ${findings}`
              : run?.phase === "reading"
                ? "Your files are in. You can study while this runs."
                : freshness)}
      </small>
      {run?.state === "done" && run.notice && <small className="sync-notice">{run.notice}</small>}
      {run?.state === "done" && <ExtractionWarnings summary={run.summary} />}
    </div>
  );
}

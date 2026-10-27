"use client";

import { useEffect, useState } from "react";
import ExtractionWarnings from "./extraction-warnings.tsx";
import LegacyLibraryDialog from "./legacy-library-dialog.tsx";

import { LEGACY_LIBRARY, setupStatus, startSync, watchSync, type SetupStatus, type SyncRun } from "../lib/setup.ts";

/** Sidebar control: sync My Studies again, and say when it last finished. */
export default function SyncButton({ onSynced }: { onSynced: () => void }) {
  const [run, setRun] = useState<SyncRun | null>(null);
  const [signedIn, setSignedIn] = useState(true);
  const [freshness, setFreshness] = useState("");
  const [error, setError] = useState("");
  const [library, setLibrary] = useState<{ status: SetupStatus; open: boolean } | null>(null);

  useEffect(() => {
    setupStatus()
      .then((s) => {
        setRun(s.sync);
        if (s.library?.legacy) setLibrary({ status: s, open: false });
        setSignedIn(s.signedIn);
        setFreshness(s.freshness);
        if (s.sync.state === "running") watchSync(setRun);
      })
      .catch(() => {});
  }, []);

  const begin = async () => {
    setError("");
    try {
      await startSync();
      watchSync((next) => {
        setRun(next);
        if (next.state === "done") {
          setFreshness("last synced just now");
          onSynced();
        }
      });
    } catch (e) {
      if ((e as { code?: string }).code === LEGACY_LIBRARY) {
        setError("");
        const status = await setupStatus().catch(() => null);
        if (status) setLibrary({ status, open: true });
        else setError((e as Error).message);
      } else setError((e as Error).message);
    }
  };

  const libraryChosen = (message: string) => {
    setLibrary(null);
    setFreshness(message);
    onSynced();
    void begin();
  };

  if (!signedIn)
    return (
      <a className="switch sync-button" href="/welcome">
        Sign in to sync
      </a>
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
        {run?.state === "running" ? `Syncing… ${run.newFiles} new` : "Sync now"}
      </button>
      <small>
        {error ||
          (run?.state === "failed" ? run.error : run?.state === "done" ? `Synced at ${time}, ${findings}` : freshness)}
      </small>
      {run?.state === "done" && <ExtractionWarnings summary={run.summary} />}
    </div>
  );
}

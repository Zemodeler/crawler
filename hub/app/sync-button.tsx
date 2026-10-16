"use client";

import { useEffect, useState } from "react";

import { setupStatus, startSync, watchSync, type SyncRun } from "../lib/setup.ts";

/** Sidebar control: sync My Studies again, and say when it last finished. */
export default function SyncButton({ onSynced }: { onSynced: () => void }) {
  const [run, setRun] = useState<SyncRun | null>(null);
  const [signedIn, setSignedIn] = useState(true);
  const [freshness, setFreshness] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    setupStatus()
      .then((s) => {
        setRun(s.sync);
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
      setError((e as Error).message);
    }
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
  return (
    <div className="sync-status" aria-live="polite">
      <button className="switch sync-button" onClick={begin} disabled={run?.state === "running"}>
        {run?.state === "running" ? `Syncing… ${run.newFiles} new` : "Sync now"}
      </button>
      <small>
        {error ||
          (run?.state === "failed" ? run.error : run?.state === "done" ? `Synced at ${time}, ${findings}` : freshness)}
      </small>
    </div>
  );
}

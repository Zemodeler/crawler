"use client";

import { useState } from "react";

import { claimLibrary, freshLibrary } from "../lib/setup.ts";

/**
 * A library synced before Study Hub recorded which account owns it cannot sync
 * until the student says what to do with it: claim it for the account they
 * are signed in with, or set it aside and start an empty one.
 */
export default function LegacyLibraryDialog({
  root,
  university,
  onDone,
  onClose,
}: {
  root: string;
  university: string;
  /** Called after either choice worked; the caller starts a sync. */
  onDone: (message: string) => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState<"" | "claim" | "fresh">("");
  const [error, setError] = useState("");

  const choose = async (choice: "claim" | "fresh") => {
    setBusy(choice);
    setError("");
    try {
      if (choice === "claim") {
        await claimLibrary();
        onDone("Library claimed for your account.");
      } else {
        const { backup } = await freshLibrary();
        onDone(`Old library kept at ${backup}.`);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="fmt-backdrop" role="dialog" aria-modal="true" aria-labelledby="legacy-title">
      <div className="fmt-dialog">
        <h2 id="legacy-title">Your library needs an owner before it can sync</h2>
        <p className="fmt-summary">
          <code>{root}</code> was synced before Study Hub recorded which account a library belongs to. To keep two
          accounts&apos; materials from mixing, syncing waits until you choose.
        </p>

        <div className="callout">
          <b>Keep using this library</b>
          Study Hub asks {university} who is signed in and records this library as that account&apos;s. Your files,
          notes, study packs and deadlines stay as they are. Choose this if you have only ever synced it with the
          account you are signed in with now.
        </div>
        <div className="callout">
          <b>Start a new, empty library</b>
          The current folder is renamed to &ldquo;My Studies (backup {new Date().toISOString().slice(0, 10)})&rdquo;
          beside it, untouched, and a new library is synced from scratch. Study packs are built again, and deadlines
          you checked or added by hand stay in the backup.
        </div>

        {error && (
          <div className="callout callout-warn">
            <b>That did not work</b>
            {error}
          </div>
        )}

        <div className="btn-row">
          <button className="btn btn-primary" disabled={Boolean(busy)} onClick={() => choose("claim")}>
            {busy === "claim" ? "Checking your account…" : "Keep using this library"}
          </button>
          <button className="btn btn-ghost" disabled={Boolean(busy)} onClick={() => choose("fresh")}>
            {busy === "fresh" ? "Moving it aside…" : "Start a new library"}
          </button>
          <button className="btn btn-ghost" disabled={Boolean(busy)} onClick={onClose}>
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}

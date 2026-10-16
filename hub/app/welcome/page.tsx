"use client";

import { useEffect, useState } from "react";

import { discover, type HostHealth } from "../../lib/ai/host.ts";
import { isHosted, loadSettings, saveSettings } from "../../lib/ai/settings.ts";
import type { ProviderId } from "../../lib/ai/types.ts";
import { markSetupDone, setupStatus, signIn, startSync, watchSync, type SetupStatus, type SyncRun } from "../../lib/setup.ts";

type Step = "sign-in" | "assistant" | "sync";
const STEPS: { id: Step; label: string }[] = [
  { id: "sign-in", label: "Sign in" },
  { id: "assistant", label: "Assistant" },
  { id: "sync", label: "Your modules" },
];

const ASSISTANTS: { provider: ProviderId; cli: "claude" | "codex"; name: string; app: string }[] = [
  { provider: "anthropic", cli: "claude", name: "Claude", app: "Claude" },
  { provider: "openai", cli: "codex", name: "ChatGPT", app: "Codex" },
];

export default function Welcome() {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [step, setStep] = useState<Step>("sign-in");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [health, setHealth] = useState<HostHealth | null>(null);
  const [checking, setChecking] = useState(false);
  const [provider, setProvider] = useState<ProviderId | null>(null);
  const [run, setRun] = useState<SyncRun | null>(null);
  const [unhosted, setUnhosted] = useState(false);

  useEffect(() => {
    if (!isHosted()) {
      queueMicrotask(() => setUnhosted(true));
      return;
    }
    setupStatus()
      .then((s) => {
        setStatus(s);
        if (s.sync.state === "running") {
          setStep("sync");
          watchSync(setRun);
        } else if (s.signedIn) setStep("assistant");
      })
      .catch((e) => setError((e as Error).message));
  }, []);

  // Look for the assistants when that step opens.
  useEffect(() => {
    if (step !== "assistant" || health) return;
    discover()
      .then((found) => {
        setHealth(found);
        const saved = loadSettings();
        const preferred = ASSISTANTS.find((a) => saved.transport === "subscription" && a.provider === saved.provider && found.clis[a.cli].present);
        setProvider((preferred || ASSISTANTS.find((a) => found.clis[a.cli].present))?.provider ?? null);
      })
      .catch(() => setHealth({ name: "", version: "", clis: { claude: { present: false, version: null }, codex: { present: false, version: null } } }));
  }, [step, health]);

  const doSignIn = async () => {
    setBusy(true);
    setError("");
    try {
      await signIn();
      setStatus(await setupStatus());
      setStep("assistant");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const checkAgain = async () => {
    setChecking(true);
    try {
      setHealth(await discover(undefined, { refresh: true }));
    } catch {
      /* keep what we had */
    } finally {
      setChecking(false);
    }
  };

  const beginSync = async () => {
    setError("");
    setStep("sync");
    try {
      await startSync();
      watchSync(setRun);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const chooseAssistant = (skip: boolean) => {
    if (!skip && provider) saveSettings({ ...loadSettings(), provider, transport: "subscription" });
    beginSync();
  };

  const finish = () => {
    markSetupDone();
    window.location.assign("/");
  };

  const index = STEPS.findIndex((s) => s.id === step);
  const universityName = status?.university.name || "your university";

  return (
    <main className="welcome">
      <section className="welcome-card setup-card" aria-live="polite">
        <div className="mark">SH</div>
        {unhosted ? (
          <>
            <h1>Setup runs in the desktop app.</h1>
            <p className="lede">Open Study Hub from the desktop app to sign in to your university and fetch your modules.</p>
          </>
        ) : (
          <>
            <ol className="setup-steps" aria-label="Setup steps">
              {STEPS.map((s, i) => (
                <li key={s.id} className={i < index ? "done" : i === index ? "current" : ""} aria-current={i === index ? "step" : undefined}>
                  <span>{i + 1}</span>
                  {s.label}
                </li>
              ))}
            </ol>

            {step === "sign-in" && (
              <>
                <p className="eyebrow">Step 1 of 3</p>
                <h1>Sign in to {universityName}.</h1>
                <p className="lede">
                  Your university&apos;s own sign-in page opens in a separate window. Study Hub never sees your password. It keeps
                  only a sign-in token, encrypted on this computer.
                </p>
                <div className="welcome-actions">
                  <button className="primary large" onClick={doSignIn} disabled={busy || !status}>
                    {busy ? "Waiting for you to sign in…" : "Sign in"}
                  </button>
                </div>
              </>
            )}

            {step === "assistant" && (
              <>
                <p className="eyebrow">Step 2 of 3</p>
                <h1>Choose your assistant.</h1>
                <p className="lede">Study Hub uses the AI app already signed in on this computer to build study packs and answer questions. You can change this later in AI settings.</p>
                <div className="assistant-choices" role="radiogroup" aria-label="Assistant">
                  {ASSISTANTS.map((a) => {
                    const cli = health?.clis[a.cli];
                    return (
                      <button
                        key={a.provider}
                        role="radio"
                        aria-checked={provider === a.provider}
                        className={`assistant${provider === a.provider ? " chosen" : ""}`}
                        disabled={!cli?.present}
                        onClick={() => setProvider(a.provider)}
                      >
                        <b>{a.name}</b>
                        <small>
                          {!health ? "Looking on this computer…" : cli?.present ? `Found on this computer${cli.version ? ` (version ${cli.version.split(" ")[0]})` : ""}` : `Not found. Install the ${a.app} app and sign in.`}
                        </small>
                      </button>
                    );
                  })}
                </div>
                <div className="welcome-actions">
                  <button className="primary large" disabled={!provider} onClick={() => chooseAssistant(false)}>
                    Continue
                  </button>
                  <button className="secondary large" onClick={checkAgain} disabled={checking}>
                    {checking ? "Checking…" : "Check again"}
                  </button>
                  <button className="text-link" onClick={() => chooseAssistant(true)}>
                    Skip for now
                  </button>
                </div>
              </>
            )}

            {step === "sync" && (
              <>
                <p className="eyebrow">Step 3 of 3</p>
                <h1>{run?.state === "done" ? "Your modules are ready." : run?.state === "failed" ? "The sync stopped." : "Fetching your modules…"}</h1>
                {(!run || run.state === "running" || run.state === "idle") && (
                  <>
                    <p className="lede">
                      The first sync downloads every file for this year&apos;s modules, which can take a few minutes. You can leave this window open.
                    </p>
                    <div className="sync-progress" role="progressbar" aria-label="Sync progress" aria-valuetext={`${run?.files || 0} files`}>
                      <span />
                    </div>
                    <p className="sync-line">
                      {run?.course ? <>Now: <b>{run.course}</b> · </> : null}
                      {run?.coursesDone || 0} module{run?.coursesDone === 1 ? "" : "s"} done · {run?.newFiles || 0} new files
                    </p>
                  </>
                )}
                {run?.state === "done" && (
                  <>
                    <p className="lede">
                      {run.newFiles} new files from {run.coursesDone} module{run.coursesDone === 1 ? "" : "s"}.
                      {run.failedCourses.length ? ` ${run.failedCourses.join(", ")} could not be synced; Study Hub tries again on the next sync.` : ""}
                    </p>
                    <div className="welcome-actions">
                      <button className="primary large" onClick={finish}>Open Study Hub</button>
                    </div>
                  </>
                )}
                {run?.state === "failed" && (
                  <>
                    <p className="lede">{run.error}</p>
                    <div className="welcome-actions">
                      {status?.signedIn === false || /sign in again/i.test(run.error || "") ? (
                        <button className="primary large" onClick={() => { setStep("sign-in"); setRun(null); }}>Sign in again</button>
                      ) : (
                        <button className="primary large" onClick={beginSync}>Try again</button>
                      )}
                    </div>
                  </>
                )}
              </>
            )}
            {error && <p className="form-error" role="alert">{error}</p>}
          </>
        )}
      </section>
    </main>
  );
}

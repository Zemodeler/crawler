"use client";

/**
 * The automatic study-pack run, opened by the desktop app in a hidden window
 * after a sync: /auto?module=<year/module>&assistant=claude|codex|gemini[&model=][&force=1].
 * The shell reads `window.__studyHubAuto` for progress and the result.
 */

import { useEffect, useState } from "react";

import { autoGenerate, type AutoResult } from "../../lib/auto-generate.ts";

type AutoState = { log: string[]; result: AutoResult | null };

declare global {
  interface Window {
    __studyHubAuto?: AutoState;
  }
}

export default function Auto() {
  const [lines, setLines] = useState<string[]>([]);
  const [result, setResult] = useState<AutoResult | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const moduleKey = params.get("module") || "";
    const requested = params.get("assistant");
    const assistant = requested === "codex" || requested === "gemini" ? requested : "claude";
    const state: AutoState = { log: [], result: null };
    window.__studyHubAuto = state;
    const push = (line: string) => {
      state.log.push(line);
      setLines((previous) => [...previous.slice(-200), line]);
    };
    if (!moduleKey) {
      state.result = { status: "failed", module: "", reason: "No module given." };
      queueMicrotask(() => setResult(state.result));
      return;
    }
    void autoGenerate({
      moduleKey,
      assistant,
      ...(params.get("model") ? { model: params.get("model")! } : {}),
      force: params.get("force") === "1",
      onLog: push,
    }).then((done) => {
      state.result = done;
      setResult(done);
    });
  }, []);

  return (
    <main className="hub-page">
      <div className="hub-card">
        <h1>Building study packs</h1>
        <p className="hub-lede">{result ? `${result.status}: ${result.reason}` : "Working…"}</p>
        <pre style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>{lines.slice(-30).join("\n")}</pre>
      </div>
    </main>
  );
}

"use client";

/**
 * AI settings: pick a provider, pick how you pay for it, test the connection.
 *
 * This is the app's only login. There is no Study Hub account — your notes and
 * progress never leave the browser, so there is nothing to log in to.
 */

import { useCallback, useEffect, useState } from "react";

import { getModuleProfile, savedActiveModule, fetchTree, pickModule, loadModule } from "../../lib/library.ts";
import { getProfile } from "../../lib/subject-profiles.ts";
import { loadHandles, collectDirectory } from "../../lib/course-fs.ts";

import { CliDiagnostics } from "../settings/cli-diagnostics.tsx";
import { CLI_FOR, discover, type HostHealth } from "../../lib/ai/host.ts";
import { ANTHROPIC_MODELS } from "../../lib/ai/models.ts";
import { createAiClient } from "../../lib/ai/provider.ts";
import {
  DEFAULT_SETTINGS,
  forgetKey,
  isHosted,
  loadKey,
  loadSettings,
  redactKey,
  saveKey,
  saveSettings,
  type AiSettings,
} from "../../lib/ai/settings.ts";
import { API_KEY_PROVIDERS, PROVIDER_LABELS, type AiError, type ModelOption, type ProviderId, type TransportId } from "../../lib/ai/types.ts";

type TestState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "ok"; detail: string }
  | { kind: "fail"; message: string; hint?: string };

const KEY_HELP: Partial<Record<ProviderId, { where: string; url: string; prefix: string }>> = {
  anthropic: {
    where: "Anthropic Console → API keys",
    url: "https://console.anthropic.com/settings/keys",
    prefix: "sk-ant-",
  },
  openai: {
    where: "OpenAI platform → API keys",
    url: "https://platform.openai.com/api-keys",
    prefix: "sk-",
  },
};


export default function Connect() {
  const [settings, setSettings] = useState<AiSettings>(DEFAULT_SETTINGS);
  const [keyInput, setKeyInput] = useState("");
  const [savedKey, setSavedKey] = useState("");
  const [models, setModels] = useState<ModelOption[]>(ANTHROPIC_MODELS);
  const [test, setTest] = useState<TestState>({ kind: "idle" });
  const [host, setHost] = useState<HostHealth | null>(null);
  const [hostChecking, setHostChecking] = useState(false);
  const [hostError, setHostError] = useState<{ message: string; hint?: string } | null>(null);
  const [hosted, setHosted] = useState(false);
  const [notice, setNotice] = useState("");
  const [subjectMaterial, setSubjectMaterial] = useState("course material");
  useEffect(() => {
    let active = true;
    (async () => {
      let choice;
      if (isHosted()) {
        const tree = await fetchTree();
        const picked = pickModule(tree, savedActiveModule());
        if (!picked) return;
        choice = await getModuleProfile(`${picked.year}/${picked.module}`, await loadModule(tree, picked.year, picked.module));
      } else {
        const { active: name, handles } = await loadHandles();
        const handle = handles.find((h) => h.name === name) ?? handles[0];
        if (!handle) return;
        choice = await getModuleProfile(handle, await collectDirectory(handle));
      }
      const profile = getProfile(choice.profile);
      if (active) setSubjectMaterial(profile.id === "law" ? "legal material" : `${profile.terms.authorities} in your course material`);
    })().catch(() => {});
    return () => { active = false; };
  }, []);

  // Reading localStorage/sessionStorage on mount is the "initialise from an
  // external store" case. A lazy useState initialiser cannot be used because
  // this page is server-rendered first and would hydrate against a mismatch,
  // and useSyncExternalStore is heavy for a value that changes only on save.
  useEffect(() => {
    const loaded = loadSettings();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHosted(isHosted());
    setSettings(loaded);
    loadKey(loaded.provider).then(setSavedKey).catch(() => setSavedKey(""));
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setModels(settings.provider === "anthropic" ? ANTHROPIC_MODELS : []);
    setTest({ kind: "idle" });
    loadKey(settings.provider).then(setSavedKey).catch(() => setSavedKey(""));
    setKeyInput("");
  }, [settings.provider]);

  const update = (patch: Partial<AiSettings>) => {
    const next = { ...settings, ...patch };
    // Model ids do not transfer between providers.
    if (patch.provider && patch.provider !== settings.provider) next.model = "";
    // Gemini has no API-key path here, only the gemini CLI.
    if (!API_KEY_PROVIDERS.includes(next.provider)) next.transport = "subscription";
    setSettings(next);
    saveSettings(next);
  };

  const checkHost = useCallback(async (refresh = false) => {
    setHostChecking(true);
    setHostError(null);
    try {
      setHost(await discover(undefined, { refresh }));
    } catch (error) {
      const aiError = error as AiError;
      setHost(null);
      setHostError({ message: aiError.detail || aiError.message, hint: aiError.hint });
    } finally {
      setHostChecking(false);
    }
  }, []);

  useEffect(() => {
    // Asking the host which CLIs it found IS synchronising with an external
    // system; the lint rule cannot see through the async boundary.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (settings.transport === "subscription" && hosted) checkHost();
  }, [settings.transport, hosted, checkHost]);

  const persistKey = async () => {
    const trimmed = keyInput.trim();
    if (!trimmed) return;
    await saveKey(settings.provider, trimmed, settings.remember);
    setSavedKey(trimmed);
    setKeyInput("");
    setNotice(
      settings.remember
        ? "Key saved on this device. It is not encrypted — anything running in this browser profile could read it."
        : "Key saved for this tab only. It disappears when you close it.",
    );
    setTest({ kind: "idle" });
    if (settings.provider === "openai") await refreshModels(trimmed);
  };

  const refreshModels = async (key: string) => {
    try {
      const client = createAiClient({ ...settings, transport: "apikey" }, key);
      const list = await client.listModels();
      setModels(list);
      if (list.length && !settings.model) update({ model: list[0].id });
    } catch (error) {
      setNotice(`Could not load the model list: ${(error as Error).message}`);
    }
  };

  const runTest = async () => {
    setTest({ kind: "running" });
    try {
      const key = settings.transport === "apikey" ? await loadKey(settings.provider) : "";
      const client = createAiClient(settings, key);
      const result = await client.probe();
      if (result.ok) setTest({ kind: "ok", detail: result.detail });
      else {
        setTest({ kind: "fail", message: result.message, hint: result.hint });
        // A rejected key should not linger where it can fail again silently.
        if (result.code === "invalid_key") {
          await forgetKey(settings.provider);
          setSavedKey("");
        }
      }
    } catch (error) {
      const aiError = error as AiError;
      setTest({ kind: "fail", message: aiError.message, hint: aiError.hint });
    }
  };

  const cli = CLI_FOR[settings.provider];
  const cliStatus = host?.clis?.[cli];
  const ready =
    settings.transport === "apikey"
      ? Boolean(savedKey) && (settings.provider === "anthropic" || Boolean(settings.model))
      : hosted && Boolean(cliStatus?.present);

  return (
    <main className="hub-page">
      <div className="hub-card">
        {/* A full page load is wanted here: returning to the workspace re-reads
            the folder handle and its permission state from scratch. */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a className="hub-back" href="/">
          ← Back to Study Hub
        </a>
        <h1>AI settings</h1>
        <p className="hub-lede">
          Study Hub can build topic packs and flashcards from your own course materials. To do that it
          needs a connection to Claude, ChatGPT or Gemini. This is the only sign-in the app has — your notes,
          flashcards and progress live in this browser and never touch a Study Hub server.
        </p>

        <h3>1. Which assistant</h3>
        <div className="choice-grid">
          {(["anthropic", "openai", "google"] as ProviderId[]).map((provider) => (
            <button
              key={provider}
              className="choice"
              aria-pressed={settings.provider === provider}
              onClick={() => update({ provider })}
            >
              <b>{PROVIDER_LABELS[provider]}</b>
              <small>
                {provider === "anthropic"
                  ? "Anthropic. Claude Pro/Max subscription, or an API key."
                  : provider === "openai"
                    ? "OpenAI. ChatGPT subscription, or an API key."
                    : "Google. Your Google sign-in in the Gemini CLI."}
              </small>
            </button>
          ))}
        </div>

        <h3>2. How it is paid for</h3>
        <div className="choice-grid">
          {(["apikey", "subscription"] as TransportId[]).filter((transport) => transport === "subscription" || API_KEY_PROVIDERS.includes(settings.provider)).map((transport) => (
            <button
              key={transport}
              className="choice"
              aria-pressed={settings.transport === transport}
              onClick={() => update({ transport })}
            >
              <b>{transport === "apikey" ? "API key" : "My subscription"}</b>
              <small>
                {transport === "apikey"
                  ? "Paste a key and pay per use. Nothing to install."
                  : hosted
                    ? `Use the ${cli} command-line tool you are already signed in to. Study Hub runs it on this computer.`
                    : `Use the ${cli} command-line tool you are already signed in to. Needs the Study Hub desktop app.`}
              </small>
            </button>
          ))}
        </div>

        {settings.transport === "apikey" ? (
          <ApiKeySection
            subjectMaterial={subjectMaterial}
            provider={settings.provider}
            keyInput={keyInput}
            setKeyInput={setKeyInput}
            savedKey={savedKey}
            remember={settings.remember}
            setRemember={(remember) => update({ remember })}
            onSave={persistKey}
            onForget={async () => {
              await forgetKey(settings.provider);
              setSavedKey("");
              setTest({ kind: "idle" });
              setNotice("Key forgotten.");
            }}
            models={models}
            model={settings.model}
            setModel={(model) => update({ model })}
            onRefreshModels={() => refreshModels(savedKey)}
          />
        ) : (
          <SubscriptionSection
            cli={cli}
            hosted={hosted}
            host={host}
            checking={hostChecking}
            error={hostError}
            onRecheck={() => checkHost(true)}
          />
        )}

        <h3>3. Check it works</h3>
        <div className="btn-row">
          <button className="btn btn-primary" onClick={runTest} disabled={test.kind === "running" || !ready}>
            {test.kind === "running" ? "Testing…" : "Test connection"}
          </button>
          {ready && <span className="badge badge-idle">Ready to test</span>}
          {!ready && (
            <span className="badge badge-warn">
              {settings.transport === "apikey"
                ? "Add a key first"
                : hosted
                  ? `${cli} not found yet`
                  : "Open the desktop app first"}
            </span>
          )}
        </div>

        {test.kind === "ok" && (
          <div className="callout">
            <b>Connected</b>
            {test.detail}. Open a course folder and Study Hub will offer to build your packs and flashcards.
          </div>
        )}
        {test.kind === "fail" && (
          <div className="callout callout-warn">
            <b>Not connected</b>
            {test.message}
            {test.hint ? ` ${test.hint}` : ""}
          </div>
        )}
        {notice && (
          <div className="callout">
            <b>Note</b>
            {notice}
          </div>
        )}
      </div>

      <div className="hub-card">
        <h2>What gets sent, and where</h2>
        <p className="hub-lede">
          Study Hub is honest about this because the answer changed when AI was added.
        </p>
        <div className="fmt-check ok">
          <i>✓</i>
          <span>
            Reading, flashcards and progress are entirely local. Nothing is uploaded, and no account
            exists.
          </span>
        </div>
        <div className="fmt-check warn">
          <i>!</i>
          <span>
            When you ask Study Hub to <b>generate</b> packs or flashcards, the text of the course files
            it needs is sent to {PROVIDER_LABELS[settings.provider]}. You see the exact file list, and
            can exclude any of it, before the first request.
          </span>
        </div>
        <div className="fmt-check ok">
          <i>✓</i>
          <span>
            {settings.transport === "apikey"
              ? "Your API key goes only to the provider — never to a Study Hub server. It is not stored on any server."
              : `Study Hub runs ${cli} with its file and shell tools turned off, so it can answer prompts but cannot read or write your course files.`}
          </span>
        </div>
        <div className="fmt-check ok">
          <i>✓</i>
          <span>Generated files are only ever created, never overwritten, and you approve the full list first.</span>
        </div>
        <div className="callout callout-warn">
          <b>Chrome or Edge required</b>
          Study Hub reads your folder with the File System Access API, which Firefox and Safari do not
          support.
        </div>
      </div>
    </main>
  );
}

function ApiKeySection({
  subjectMaterial,
  provider,
  keyInput,
  setKeyInput,
  savedKey,
  remember,
  setRemember,
  onSave,
  onForget,
  models,
  model,
  setModel,
  onRefreshModels,
}: {
  subjectMaterial: string;
  provider: ProviderId;
  keyInput: string;
  setKeyInput: (value: string) => void;
  savedKey: string;
  remember: boolean;
  setRemember: (value: boolean) => void;
  onSave: () => void;
  onForget: () => void;
  models: ModelOption[];
  model: string;
  setModel: (value: string) => void;
  onRefreshModels: () => void;
}) {
  const help = KEY_HELP[provider]!;
  return (
    <>
      <div className="field">
        <label htmlFor="ai-key">{PROVIDER_LABELS[provider]} API key</label>
        <div className="inline-row">
          <input
            id="ai-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={savedKey ? redactKey(savedKey) : `${help.prefix}…`}
            value={keyInput}
            onChange={(event) => setKeyInput(event.target.value)}
          />
          <button className="btn btn-ghost" onClick={onSave} disabled={!keyInput.trim()}>
            Save
          </button>
          {savedKey && (
            <button className="btn btn-danger" onClick={onForget}>
              Forget
            </button>
          )}
        </div>
        <small>
          Create one at <span className="mono">{help.where}</span>. Study Hub sends it only to the
          provider.
        </small>
      </div>

      <label className="check-row">
        <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
        <span>
          Remember this key on this device. It is stored in this browser <b>unencrypted</b> and deleted
          automatically after 30 days unused. Leave it off and the key is kept for this tab only.
        </span>
      </label>

      <div className="field">
        <label htmlFor="ai-model">Model</label>
        <div className="inline-row">
          <select id="ai-model" value={model} onChange={(event) => setModel(event.target.value)}>
            {provider === "anthropic" && <option value="">Default (best quality)</option>}
            {provider === "openai" && !models.length && <option value="">Save a key to load the list</option>}
            {models.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
                {option.note ? ` — ${option.note}` : ""}
              </option>
            ))}
          </select>
          {provider === "openai" && (
            <button className="btn btn-ghost" onClick={onRefreshModels} disabled={!savedKey}>
              Reload
            </button>
          )}
        </div>
        <small>
          {provider === "openai"
            ? "This list comes from your own account, so it is always current."
            : `Cheaper models work, but the strongest one makes the fewest mistakes on ${subjectMaterial}.`}
        </small>
      </div>
    </>
  );
}

function SubscriptionSection({
  cli,
  hosted,
  host,
  checking,
  error,
  onRecheck,
}: {
  cli: "claude" | "codex" | "gemini";
  hosted: boolean;
  host: HostHealth | null;
  checking: boolean;
  error: { message: string; hint?: string } | null;
  onRecheck: () => void;
}) {
  if (!hosted)
    return (
      <div className="callout callout-warn">
        <b>Only in the desktop app</b>
        No public interface lets a website spend a Claude, ChatGPT or Gemini subscription. The Study
        Hub desktop app runs the <span className="mono">{cli}</span> command-line tool you are already
        signed in to, on your own computer. Open Study Hub from the desktop app to use your
        subscription, or use an API key here.
      </div>
    );
  return (
    <>
      <div className="callout">
        <b>Built in</b>
        Study Hub runs <span className="mono">{cli}</span> for you on this computer. There is
        nothing to start or pair. It can only answer prompts: it cannot read or write your files.
      </div>
      <CliDiagnostics host={host} checking={checking} error={error} onRecheck={onRecheck} />
    </>
  );
}

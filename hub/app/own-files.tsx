"use client";

import { useState, type DragEvent } from "react";

import { OWN_FILES_DIR } from "../lib/course-format.ts";
import { libraryUrl, type LibraryEntry } from "../lib/library.ts";
import { removeOwnFile, saveOwnNote, uploadOwnFile } from "../lib/own-files.ts";

const ACCEPT = ".pdf,.docx,.pptx,.xlsx,.md,.txt,.csv,.png,.jpg,.jpeg,.gif";

/** Files and notes the student adds to a module; `module` is "year/module". */
export function OwnFiles({
  module,
  entries,
  onChanged,
  onClose,
}: {
  module: string;
  entries: LibraryEntry[];
  onChanged: () => Promise<void> | void;
  onClose: () => void;
}) {
  const prefix = `${module}/${OWN_FILES_DIR}/`;
  const own = entries.filter((e) => e.path.startsWith(prefix));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [dragging, setDragging] = useState(false);
  const [note, setNote] = useState<{ title: string; text: string } | null>(null);

  const run = async (work: () => Promise<string>) => {
    setBusy(true);
    setMessage("");
    try {
      setMessage(await work());
      await onChanged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const upload = (list: FileList | null) => {
    const picked = [...(list ?? [])];
    if (!picked.length) return;
    void run(async () => {
      const failed: string[] = [];
      for (const file of picked) {
        await uploadOwnFile(module, file).catch((error: Error) => failed.push(`${file.name}: ${error.message}`));
      }
      const added = picked.length - failed.length;
      return [added ? `Added ${added} file${added === 1 ? "" : "s"}.` : "", ...failed].filter(Boolean).join(" ");
    });
  };

  const drop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    upload(event.dataTransfer.files);
  };

  const save = () => {
    if (!note) return;
    void run(async () => {
      await saveOwnNote(module, note);
      setNote(null);
      return "Note saved.";
    });
  };

  const remove = (path: string, name: string) => {
    if (!window.confirm(`Remove "${name}" from your library? This cannot be undone.`)) return;
    void run(async () => {
      await removeOwnFile(module, path);
      return `Removed ${name}.`;
    });
  };

  return (
    <section className="own-files panel">
      <div className="section-title">
        <div>
          <p className="eyebrow">Your own files</p>
          <h3>Add files and notes</h3>
        </div>
        <button className="btn btn-ghost" onClick={onClose}>Close</button>
      </div>
      <p className="own-files-copy">Your files stay in your library and are used the next time study packs are rebuilt.</p>
      <label
        className={`own-files-drop${dragging ? " dragging" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={drop}
      >
        <input type="file" multiple accept={ACCEPT} disabled={busy} onChange={(e) => { upload(e.target.files); e.target.value = ""; }} />
        <span>Drop files here or <b>choose files</b></span>
        <small>PDF, Word, PowerPoint, Excel, Markdown, text, CSV and images, up to 50 MB each.</small>
      </label>
      {note ? (
        <div className="own-files-note">
          <input
            type="text"
            placeholder="Note title"
            value={note.title}
            onChange={(e) => setNote({ ...note, title: e.target.value })}
          />
          <textarea
            rows={10}
            placeholder="Write in Markdown…"
            value={note.text}
            onChange={(e) => setNote({ ...note, text: e.target.value })}
          />
          <div className="btn-row">
            <button className="btn btn-primary" disabled={busy || !note.title.trim()} onClick={save}>Save</button>
            <button className="btn btn-ghost" disabled={busy} onClick={() => setNote(null)}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="btn-row">
          <button className="btn btn-ghost" disabled={busy} onClick={() => setNote({ title: "", text: "" })}>New note</button>
        </div>
      )}
      {message && <p className="own-files-message" role="status">{message}</p>}
      {own.length > 0 && (
        <ul className="own-files-list">
          {own.map((entry) => {
            const relative = entry.path.slice(module.length + 1);
            const name = entry.path.slice(prefix.length);
            return (
              <li key={entry.path}>
                <span>{name}</span>
                <a className="btn btn-ghost" href={libraryUrl(entry.path)} target="_blank" rel="noreferrer">Open</a>
                <button className="btn btn-danger" disabled={busy} onClick={() => remove(relative, name)}>Remove</button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

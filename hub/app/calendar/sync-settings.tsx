"use client";

import { useEffect, useState } from "react";

import {
  connectCalendar,
  disconnectCalendar,
  setSchedule,
  setupStatus,
  syncCalendarNow,
  type SetupStatus,
} from "../../lib/setup.ts";
import ModulePicker from "../module-picker.tsx";

const EVERY: { days: 1 | 3 | 7; label: string }[] = [
  { days: 1, label: "Every day" },
  { days: 3, label: "Every 3 days" },
  { days: 7, label: "Every week" },
];

/**
 * How often Study Hub syncs on its own, and the optional Google Calendar copy
 * of these deadlines (a separate "University deadlines" calendar that Study
 * Hub alone writes to).
 */
export default function SyncSettings() {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = () => setupStatus().then(setStatus).catch(() => {});
  useEffect(() => {
    refresh();
  }, []);

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      refresh();
    }
  };

  if (!status) return null;
  const cal = status.calendar;
  const report = cal.lastReport;

  return (
    <section className="sync-settings" aria-labelledby="sync-settings-title">
      <h3 id="sync-settings-title" className="list-heading">Syncing</h3>
      <p className="quiet">
        {status.freshness[0].toUpperCase() + status.freshness.slice(1)}. Study Hub syncs on its own while it is open or in the tray, and
        once when it starts if a sync is overdue.
      </p>
      <div className="segmented" role="group" aria-label="How often to sync">
        {EVERY.map((option) => (
          <button
            key={option.days}
            aria-pressed={status.schedule.everyDays === option.days}
            disabled={busy}
            onClick={() => act(() => setSchedule(option.days))}
          >
            {option.label}
          </button>
        ))}
      </div>
      <p className="quiet">
        {status.assistant
          ? `Documents and announcements are also read by ${status.assistant === "codex" ? "ChatGPT" : status.assistant === "gemini" ? "Gemini" : "Claude"} on your subscription; every date it finds is checked against the document's own words.`
          : "Documents and announcements are read with rules only. Choose “My subscription” in AI settings to let your assistant read them too."}
      </p>

      <h3 className="list-heading">Modules</h3>
      <p className="quiet">Ticked modules sync. Remove an old module to delete its folder from this computer; it will not come back unless you tick it again.</p>
      {status.signedIn ? <ModulePicker saveLabel="Save choices" /> : <p className="quiet">Sign in to choose modules.</p>}

      <h3 className="list-heading">Google Calendar</h3>
      {!cal.configured ? (
        <p className="quiet">
          Not set up on this computer. Google Calendar needs a Google OAuth client ID in google-oauth.json in Study Hub&apos;s data folder
          (or CRAWLER_GOOGLE_CLIENT_ID). Your deadlines are also in Deadlines.ics in My Studies, which any calendar app can import.
        </p>
      ) : cal.connected ? (
        <>
          <p className="quiet">
            Connected. Deadlines go to a separate “University deadlines” calendar; your other calendars are never read or changed.
            {report &&
              ` Last update ${new Date(report.at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}: ${report.created.length} added, ${report.updated.length} changed, ${report.deleted.length} removed.`}
          </p>
          {report && report.editedByUser.length > 0 && (
            <p className="quiet">
              You edited {report.editedByUser.length === 1 ? "this event" : "these events"} in Google Calendar, so Study Hub left{" "}
              {report.editedByUser.length === 1 ? "it" : "them"} alone: {report.editedByUser.map((e) => e.summary).join("; ")}.
            </p>
          )}
          <div className="calendar-tools">
            <button className="today-button" disabled={busy || cal.busy} onClick={() => act(syncCalendarNow)}>
              {cal.busy ? "Updating…" : "Update now"}
            </button>
            <button className="text-link" disabled={busy} onClick={() => act(disconnectCalendar)}>
              Disconnect
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="quiet">
            Put your deadlines in Google Calendar as their own “University deadlines” calendar. Study Hub keeps it up to date after each
            sync and never touches your other calendars. Dates that still need checking stay off it.
          </p>
          <button className="today-button" disabled={busy || cal.busy} onClick={() => act(connectCalendar)}>
            {busy ? "Waiting for Google…" : "Connect Google Calendar"}
          </button>
        </>
      )}
      {(error || cal.error) && <p className="quiet" role="alert">{error || cal.error}</p>}
    </section>
  );
}

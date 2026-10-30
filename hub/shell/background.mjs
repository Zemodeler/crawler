/**
 * What the desktop app does on its own (Crawler docs/design/05):
 *
 *  - syncs My Studies every few days (1, 3 or 7; default 3), and once on
 *    launch when the last sync is overdue (the laptop was off)
 *  - turns a sync's results into native notifications: date changes, new
 *    deadlines, new conflicts, and one line for new files
 *  - reminds about deadlines due in the next 48 hours, computed locally from
 *    Deadlines.json on a timer, so reminders never wait for a sync
 *  - keeps a tray icon with "Sync now" and "Start at login", so the schedule
 *    holds with the window closed
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { STATE_DIR, dueSoon, loadNotified, readState, saveNotified, syncDue } from "crawler";

const HOUR_MS = 60 * 60 * 1000;
/** Started at login: open in the tray (Windows passes the flag; macOS reports wasOpenedAtLogin). */
export const LOGIN_ITEM = { args: ["--background"] };
const MAX_TOASTS = 4;

/** The schedule shared with `crawler schedule`: <root>/.crawler/schedule.json. */
export async function readSchedule(root) {
  try {
    const saved = JSON.parse(await readFile(join(root, STATE_DIR, "schedule.json"), "utf8"));
    if (saved && [1, 3, 7].includes(saved.everyDays)) return { everyDays: saved.everyDays };
  } catch {
    /* missing or unreadable: the default */
  }
  return { everyDays: 3 };
}

export async function writeSchedule(root, everyDays) {
  if (![1, 3, 7].includes(everyDays)) throw new Error("A sync can run every 1, 3 or 7 days.");
  await mkdir(join(root, STATE_DIR), { recursive: true });
  await writeFile(join(root, STATE_DIR, "schedule.json"), `${JSON.stringify({ everyDays }, null, 2)}\n`);
}

/** At most a few toasts at once; the rest become one summary line. */
export function toastsFor(events, max = MAX_TOASTS) {
  if (events.length <= max) return events;
  const shown = events.slice(0, max - 1);
  return [...shown, { kind: "files-summary", title: "Study Hub", body: `${events.length - shown.length} more updates in your calendar.` }];
}

export function createBackground({ app, Notification, Tray, Menu, nativeImage, iconPath, setup, libraryRoot, openPage, updater = null }) {
  let tray = null;
  let timer = null;
  let refreshTray = () => {};

  function notify(events) {
    if (!Notification.isSupported()) return;
    for (const event of toastsFor(events)) {
      const toast = new Notification({ title: event.title, body: event.body, silent: event.kind === "files-summary" });
      toast.on("click", () => openPage(event.deadlineId ? `calendar#${encodeURIComponent(event.deadlineId)}` : "calendar"));
      toast.show();
    }
  }

  /** "Due in 48h", once per deadline and due date; one run at a time, so nothing fires twice. */
  let remindQueue = Promise.resolve();
  function remind(now = new Date()) {
    const next = remindQueue.then(() => remindNow(now));
    remindQueue = next.catch(() => {});
    return next;
  }

  async function remindNow(now) {
    const root = libraryRoot();
    let deadlines = [];
    try {
      deadlines = JSON.parse(await readFile(join(root, "Deadlines.json"), "utf8"));
    } catch {
      return;
    }
    const stateDir = join(root, STATE_DIR);
    const { events, notified } = dueSoon(deadlines, now, await loadNotified(stateDir));
    await saveNotified(stateDir, notified);
    notify(events);
  }

  /** Starts a sync when the schedule says one is due (and on launch after a gap). */
  async function maybeSync(now = new Date()) {
    const status = await setup.status();
    if (!status.signedIn || status.sync.state === "running") return;
    const root = libraryRoot();
    const due = syncDue((await readState(root)).lastSync, now, await readSchedule(root));
    if (due.due) await setup.startBackgroundSync(due.reason === "never-synced" ? "first" : "schedule");
  }

  async function tick() {
    await maybeSync().catch((error) => console.error(`Scheduled sync: ${error.message}`));
    await remind().catch((error) => console.error(`Reminders: ${error.message}`));
  }

  function buildTray() {
    const image = nativeImage.createFromPath(iconPath);
    tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image.resize({ width: 16, height: 16 }));
    tray.setToolTip("Study Hub");
    const refresh = () => {
      // Windows matches the login item by path and args, so read it back with the same args.
      const atLogin = app.getLoginItemSettings(LOGIN_ITEM).openAtLogin;
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: "Open Study Hub", click: () => openPage("") },
          { label: "Sync now", click: () => setup.startBackgroundSync("tray") },
          ...(updater?.status().state === "ready"
            ? [{ label: `Restart to update to ${updater.status().version}`, click: () => updater.restartNow() }]
            : []),
          { type: "separator" },
          {
            label: "Start at login",
            type: "checkbox",
            checked: atLogin,
            click: (item) => {
              app.setLoginItemSettings({ ...LOGIN_ITEM, openAtLogin: item.checked });
              refresh();
            },
          },
          { type: "separator" },
          { label: "Quit Study Hub", click: () => app.quit() },
        ]),
      );
    };
    refreshTray = refresh;
    refresh();
    tray.on("click", () => openPage(""));
  }

  return {
    start() {
      buildTray();
      setTimeout(tick, 5_000); // catch-up on launch, after the window is up
      timer = setInterval(tick, HOUR_MS);
    },
    stop() {
      clearInterval(timer);
      tray?.destroy();
    },
    /** Called by setup when a sync finishes. */
    onSynced(result) {
      notify(result.notifications ?? []);
      remind().catch(() => {});
    },
    notify,
    remind,
    maybeSync,
    /** Rebuilds the tray menu, e.g. when an update is ready. */
    refreshTray: () => refreshTray(),
  };
}

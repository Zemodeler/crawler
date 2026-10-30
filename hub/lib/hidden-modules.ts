/** "year/module" keys the student hid; hidden on the home page and in the sidebar. */
const HIDDEN_KEY = "studyhub:hidden-modules";
export const HIDDEN_MODULES_EVENT = "studyhub:hidden-modules";

export function readHidden(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(HIDDEN_KEY) || "[]");
    return Array.isArray(saved) ? saved.filter((key): key is string => typeof key === "string") : [];
  } catch {
    return [];
  }
}

export function writeHidden(keys: string[]) {
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify(keys));
  } catch {
    /* hidden until the page is reloaded */
  }
  window.dispatchEvent(new CustomEvent(HIDDEN_MODULES_EVENT, { detail: keys }));
}

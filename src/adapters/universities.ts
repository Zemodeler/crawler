/**
 * Supported universities. A new Moodle site is a config entry here, not code
 * (docs/design/02-university-adapters.md, "Adding another Moodle university").
 */

import type { UniversityAdapter } from "../types.ts";
import { createBrightspaceAdapter } from "./brightspace.ts";
import type { BrightspaceDeps, BrightspaceSiteConfig } from "./brightspace.ts";
import { createMoodleAdapter } from "./moodle.ts";
import type { MoodleDeps, MoodleSiteConfig } from "./moodle.ts";

export const QMUL: MoodleSiteConfig = {
  id: "qmul",
  displayName: "Queen Mary University of London",
  site: "https://qmplus.qmul.ac.uk",
};

export const SURREY: BrightspaceSiteConfig = {
  id: "surrey",
  displayName: "University of Surrey",
  site: "https://surreylearn.surrey.ac.uk",
};

/** The Moodle universities; the CLI builds Moodle adapters from this list. */
export const UNIVERSITIES: readonly MoodleSiteConfig[] = [QMUL];

export type UniversityEntry =
  | ({ platform: "moodle" } & MoodleSiteConfig)
  | ({ platform: "brightspace" } & BrightspaceSiteConfig);

/** Every university on every platform. */
export const ALL_UNIVERSITIES: readonly UniversityEntry[] = [
  ...UNIVERSITIES.map((u): UniversityEntry => ({ platform: "moodle", ...u })),
  { platform: "brightspace", ...SURREY },
];

/** The adapter for a university id, or null when Crawler doesn't know it. */
export function getUniversity(id: string, deps?: MoodleDeps & BrightspaceDeps): UniversityAdapter | null {
  const entry = ALL_UNIVERSITIES.find((university) => university.id === id);
  if (!entry) return null;
  const { platform, ...config } = entry;
  return platform === "brightspace" ? createBrightspaceAdapter(config, deps) : createMoodleAdapter(config, deps);
}

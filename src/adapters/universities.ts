/**
 * Supported universities. A new Moodle site is a config entry here, not code
 * (docs/design/02-university-adapters.md, "Adding another Moodle university").
 */

import type { UniversityAdapter } from "../types.ts";
import { createMoodleAdapter } from "./moodle.ts";
import type { MoodleDeps, MoodleSiteConfig } from "./moodle.ts";

export const QMUL: MoodleSiteConfig = {
  id: "qmul",
  displayName: "Queen Mary University of London",
  site: "https://qmplus.qmul.ac.uk",
};

export const UNIVERSITIES: readonly MoodleSiteConfig[] = [QMUL];

/** The adapter for a university id, or null when Crawler doesn't know it. */
export function getUniversity(id: string, deps?: MoodleDeps): UniversityAdapter | null {
  const config = UNIVERSITIES.find((university) => university.id === id);
  return config ? createMoodleAdapter(config, deps) : null;
}

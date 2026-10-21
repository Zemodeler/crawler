import type { SyncRun } from "../lib/setup.ts";

/** Shared by first launch and subsequent syncs so incomplete coverage is visible. */
export default function ExtractionWarnings({ summary }: { summary: SyncRun["summary"] | undefined }) {
  const issues = summary?.extractionIssues ?? [];
  if (!issues.length) return null;
  return <details>
    <summary>{issues.length} file or module checks incomplete</summary>
    <p>Some materials could not be checked for deadlines. Earlier evidence is kept; review these files yourself.</p>
    <ul>{issues.map((issue, index) => <li key={`${issue.module}:${issue.file}:${index}`}>
      <strong>{issue.module}: {issue.file}</strong> — {issue.message}
    </li>)}</ul>
  </details>;
}

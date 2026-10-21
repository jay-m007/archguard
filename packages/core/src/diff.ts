import type { Report, Violation } from "./types.js";

export interface ReportDiff {
  introduced: Violation[];
  resolved: Violation[];
  healthDelta: number;
}

/**
 * Compares two reports (e.g. main branch vs a pull request) using each
 * violation's stable `key`. This is the foundation for the Phase 3 GitHub
 * Action, which should only complain about problems a PR *introduces*.
 */
export function diffReports(base: Report, head: Report): ReportDiff {
  const baseKeys = new Set(base.violations.map((v) => v.key));
  const headKeys = new Set(head.violations.map((v) => v.key));
  return {
    introduced: head.violations.filter((v) => !baseKeys.has(v.key)),
    resolved: base.violations.filter((v) => !headKeys.has(v.key)),
    healthDelta: head.score.health - base.score.health,
  };
}

/**
 * Pure data transforms from an ArchGuard report to what the dashboard draws.
 * No React here, so it's easy to reason about (and to test).
 */
import type { History, Report, Violation, ViolationType } from "@archguard/core";

export type { History, HistoryPoint, Report, Violation, ViolationType, FileNode } from "@archguard/core";

export const ISSUE_TYPES: ViolationType[] = ["circular-dependency", "layer-violation", "god-file", "orphan-file"];

export const ISSUE_LABEL: Record<ViolationType, { one: string; many: string; icon: string; tone: "critical" | "serious" | "warning" | "info" }> = {
  "circular-dependency": { one: "Circular dependency", many: "Circular dependencies", icon: "⟲", tone: "critical" },
  "layer-violation": { one: "Layer violation", many: "Layer violations", icon: "⚠", tone: "serious" },
  "god-file": { one: "God file", many: "God files", icon: "◆", tone: "warning" },
  "orphan-file": { one: "Possibly unused", many: "Possibly unused files", icon: "○", tone: "info" },
};

/** Layer -> CSS colour token, assigned in the config's layer order (fixed, never by rank). */
export function layerColors(report: Report): Map<string | null, string> {
  const map = new Map<string | null, string>();
  report.layers.forEach((l, i) => map.set(l.name, i < 8 ? `var(--layer-${i + 1})` : "var(--layer-none)"));
  map.set(null, "var(--layer-none)");
  return map;
}

/** Everything the graph needs to know about issues, indexed for O(1) lookups. */
export interface IssueIndex {
  byFile: Map<string, Violation[]>;
  cycleOf: Map<string, number>; // file -> index of its cycle
  violatingEdges: Set<string>; // "from->to" with a layer violation
}

export function indexIssues(report: Report): IssueIndex {
  const byFile = new Map<string, Violation[]>();
  const add = (file: string, v: Violation) => byFile.set(file, [...(byFile.get(file) ?? []), v]);
  const violatingEdges = new Set<string>();

  for (const v of report.violations) {
    if (v.type === "circular-dependency") continue; // attached per file below
    add(v.file, v);
    if (v.type === "layer-violation" && v.target) violatingEdges.add(`${v.file}->${v.target}`);
  }

  const cycleOf = new Map<string, number>();
  const cycleViolations = report.violations.filter((v) => v.type === "circular-dependency");
  report.cycles.forEach((cycle, i) => {
    const violation = cycleViolations.find((v) => v.key === `circular-dependency:${cycle.files.join("|")}`);
    for (const f of cycle.files) {
      cycleOf.set(f, i);
      if (violation) add(f, violation);
    }
  });

  return { byFile, cycleOf, violatingEdges };
}

/** An edge is part of a cycle when both ends are in the same strongly connected component. */
export const isCycleEdge = (idx: IssueIndex, from: string, to: string) =>
  idx.cycleOf.has(from) && idx.cycleOf.get(from) === idx.cycleOf.get(to);

export function folderOf(file: string, depth: number): string {
  const parts = file.split("/");
  parts.pop();
  return parts.length === 0 ? "(root)" : parts.slice(0, depth).join("/");
}

export function basename(file: string): string {
  return file.slice(file.lastIndexOf("/") + 1);
}

export function dirname(file: string): string {
  const i = file.lastIndexOf("/");
  return i === -1 ? "" : file.slice(0, i);
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isNum = (x: unknown) => typeof x === "number" && Number.isFinite(x);
const isStr = (x: unknown) => typeof x === "string";

export function isReport(x: unknown): x is Report {
  if (!isObj(x) || !isObj(x.meta) || x.meta.tool !== "archguard" || x.meta.kind === "history") return false;
  if (!isStr(x.meta.root) || !isStr(x.meta.generatedAt)) return false;
  if (!isObj(x.summary) || !isObj(x.summary.violations) || !isNum(x.summary.files) || !isNum(x.summary.edges)) return false;
  if (!isObj(x.score) || !isNum(x.score.health) || !isNum(x.score.driftPoints) || !isStr(x.score.grade)) return false;
  if (![x.nodes, x.edges, x.violations, x.layers, x.cycles].every(Array.isArray)) return false;
  return (
    (x.nodes as unknown[]).every((n) => isObj(n) && isStr(n.id) && isNum(n.fanIn) && isNum(n.fanOut)) &&
    (x.edges as unknown[]).every((e) => isObj(e) && isStr(e.from) && isStr(e.to)) &&
    (x.violations as unknown[]).every((v) => isObj(v) && isStr(v.type) && isStr(v.file)) &&
    (x.layers as unknown[]).every((l) => isObj(l) && isStr(l.name) && isNum(l.files)) &&
    (x.cycles as unknown[]).every((c) => isObj(c) && Array.isArray(c.files) && Array.isArray(c.path) && c.path.length > 0 && c.path.every(isStr))
  );
}

export function isHistory(x: unknown): x is History {
  if (!isObj(x) || !isObj(x.meta) || x.meta.tool !== "archguard" || x.meta.kind !== "history") return false;
  if (!isStr(x.meta.repo) || !isStr(x.meta.subpath) || !Array.isArray(x.points) || !isObj(x.trend)) return false;
  return (x.points as unknown[]).every(
    (p) =>
      isObj(p) &&
      isStr(p.shortSha) &&
      isStr(p.date) &&
      isStr(p.message) &&
      typeof p.analyzed === "boolean" &&
      (!p.analyzed || [p.files, p.edges, p.health, p.cycles, p.layerViolations, p.godFiles].every(isNum)),
  );
}

export function projectName(report: Report): string {
  const parts = report.meta.root.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? "project";
}

export function countBy(report: Report): Record<ViolationType, number> {
  return report.summary.violations;
}

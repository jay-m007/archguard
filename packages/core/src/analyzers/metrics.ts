import picomatch from "picomatch";
import type { DependencyGraph } from "../graph.js";
import type { ArchGuardConfig, FileNode, Violation } from "../types.js";
import type { LayerOf } from "./layers.js";

/**
 * Computes coupling metrics for every file.
 *
 * - fan-in  (Ca, afferent coupling): how many files depend on this one.
 * - fan-out (Ce, efferent coupling): how many files this one depends on.
 * - instability I = Ce / (Ca + Ce)  (Robert C. Martin, "Clean Architecture").
 *   0 means maximally stable (many dependants, no dependencies — e.g. utils),
 *   1 means maximally unstable (depends on others, nothing depends on it — e.g. pages).
 *   Healthy architectures have dependencies pointing from unstable to stable code.
 */
export function computeNodes(
  graph: DependencyGraph,
  layerOf: LayerOf,
  loc: Map<string, number>,
  config: ArchGuardConfig,
): FileNode[] {
  const isEntry = picomatch(config.entryPoints, { dot: true });

  return graph.nodes.map((id) => {
    const fanIn = graph.fanIn(id);
    const fanOut = graph.fanOut(id);
    const total = fanIn + fanOut;
    return {
      id,
      layer: layerOf(id),
      fanIn,
      fanOut,
      instability: total === 0 ? 0 : round(fanOut / total),
      loc: loc.get(id) ?? 0,
      entry: isEntry(id),
    };
  });
}

/**
 * God files: files doing too much. We flag three signals:
 *   1. very high fan-out (depends on too many modules),
 *   2. "hub" files with both high fan-in and high fan-out (a change ripples everywhere),
 *   3. very long files.
 */
export function findGodFiles(nodes: FileNode[], config: ArchGuardConfig): Violation[] {
  const { maxFanOut, hubFanInOut, maxLoc } = config.thresholds;
  const violations: Violation[] = [];

  for (const n of nodes) {
    const reasons: string[] = [];
    if (n.fanOut >= maxFanOut) reasons.push(`imports ${n.fanOut} files (limit ${maxFanOut})`);
    if (n.fanIn >= hubFanInOut && n.fanOut >= hubFanInOut) {
      reasons.push(`is a hub: imported by ${n.fanIn} files and imports ${n.fanOut}`);
    }
    if (n.loc > maxLoc) reasons.push(`has ${n.loc} lines (limit ${maxLoc})`);
    if (reasons.length === 0) continue;

    violations.push({
      type: "god-file",
      severity: "warning",
      file: n.id,
      message: `${n.id} ${reasons.join("; ")}. Consider splitting it into smaller modules.`,
      key: `god-file:${n.id}`,
    });
  }

  return violations;
}

/** Orphans: files nothing imports and the framework doesn't load — usually dead code. */
export function findOrphans(nodes: FileNode[], config: ArchGuardConfig): Violation[] {
  if (!config.reportOrphans) return [];
  return nodes
    .filter((n) => n.fanIn === 0 && !n.entry)
    .map((n) => ({
      type: "orphan-file" as const,
      severity: "info" as const,
      file: n.id,
      message: `${n.id} is never imported and is not an entry point. It may be dead code.`,
      key: `orphan-file:${n.id}`,
    }));
}

function round(x: number): number {
  return Math.round(x * 100) / 100;
}

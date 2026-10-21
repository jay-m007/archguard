import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.js";
import { discoverFiles } from "./discover.js";
import { extractImports } from "./extract.js";
import { createResolver, toPosix } from "./resolve.js";
import { DependencyGraph } from "./graph.js";
import { findCycles } from "./analyzers/cycles.js";
import { createLayerMatcher, findLayerViolations } from "./analyzers/layers.js";
import { computeNodes, findGodFiles, findOrphans } from "./analyzers/metrics.js";
import { computeScore } from "./score.js";
import type { ArchGuardConfig, Edge, Report, UnresolvedImport, Violation, ViolationType } from "./types.js";

export const VERSION = "0.1.0";

export interface AnalyzeOptions {
  /** Path to a config file; defaults to <root>/archguard.config.json, then the Next.js preset. */
  configPath?: string;
  /** Pass a config object directly (used by tests and the GitHub Action). */
  config?: ArchGuardConfig;
}

/**
 * Runs the full pipeline on a project:
 *
 *   discover files -> extract imports (AST) -> resolve paths -> build graph
 *   -> detect cycles, layer violations, god files, orphans -> score -> report
 */
export async function analyze(rootDir: string, options: AnalyzeOptions = {}): Promise<Report> {
  const started = Date.now();
  const root = path.resolve(rootDir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`Not a directory: ${root}`);
  }

  const { config, source } = options.config
    ? { config: options.config, source: "inline" }
    : loadConfig(root, options.configPath);

  // 1. Discover
  const files = await discoverFiles(root, config);

  // Map each file's REAL path (symlinks resolved) to its node id, so an import
  // that goes through a symlinked folder still lands on the right node.
  const realRoot = fs.realpathSync(root);
  const idByRealPath = new Map<string, string>();
  for (const f of files) idByRealPath.set(safeRealpath(path.join(root, f)), f);
  const insideProject = (abs: string) => {
    const rel = path.relative(realRoot, abs);
    return !rel.startsWith("..") && !path.isAbsolute(rel);
  };
  let ignoredImports = 0;

  // 2 + 3. Extract and resolve
  const resolver = createResolver(root);
  const edges: Edge[] = [];
  const unresolved: UnresolvedImport[] = [];
  const external: Record<string, number> = {};
  const loc = new Map<string, number>();

  for (const file of files) {
    const abs = path.join(root, file);
    const text = fs.readFileSync(abs, "utf8");
    loc.set(file, countLines(text));

    for (const imp of extractImports(abs, text)) {
      const res = resolver.resolve(imp.specifier, abs);
      if (res.type === "internal") {
        const real = safeRealpath(res.file);
        const target = idByRealPath.get(real);
        if (target) {
          edges.push({ from: file, to: target, specifier: imp.specifier, kind: imp.kind, typeOnly: imp.typeOnly, line: imp.line });
        } else if (insideProject(real)) {
          ignoredImports++; // a real project file, but excluded from the graph
        } else {
          // Outside the analysed folder, e.g. a sibling package in a monorepo.
          const name = `(outside) ${toPosix(path.relative(realRoot, real))}`;
          external[name] = (external[name] ?? 0) + 1;
        }
      } else if (res.type === "external") {
        external[res.name] = (external[res.name] ?? 0) + 1;
      } else if (res.type === "unresolved") {
        unresolved.push({ from: file, specifier: imp.specifier, line: imp.line });
      }
    }
  }

  // 4. Graphs. Metrics use every edge; cycle detection can skip type-only
  // edges, because `import type` is erased at compile time and can't cause a
  // runtime circular-import bug.
  const fullGraph = new DependencyGraph(files, edges);
  const runtimeEdges = config.ignoreTypeOnlyImports ? edges.filter((e) => !e.typeOnly) : edges;
  const runtimeGraph = new DependencyGraph(files, runtimeEdges);

  // 5. Analyze
  const layerOf = createLayerMatcher(config);
  const nodes = computeNodes(fullGraph, layerOf, loc, config);
  const cycles = findCycles(runtimeGraph);

  const cycleViolations: Violation[] = cycles.map((c) => ({
    type: "circular-dependency",
    severity: "error",
    file: c.path[0],
    message: `Circular dependency (${c.files.length} file${c.files.length > 1 ? "s" : ""}): ${c.path.join(" -> ")}`,
    key: `circular-dependency:${c.files.join("|")}`,
  }));

  const violations: Violation[] = [
    ...cycleViolations,
    ...findLayerViolations(edges, layerOf, config),
    ...findGodFiles(nodes, config),
    ...findOrphans(nodes, config),
  ];

  // 6. Score
  const filesInCycles = new Set(cycles.flatMap((c) => c.files)).size;
  const score = computeScore(files.length, filesInCycles, violations);

  const violationCounts = { "circular-dependency": 0, "layer-violation": 0, "god-file": 0, "orphan-file": 0 } as Record<ViolationType, number>;
  for (const v of violations) violationCounts[v.type]++;

  const layerCounts = config.layers.map((l) => ({ name: l.name, files: nodes.filter((n) => n.layer === l.name).length }));

  return {
    meta: {
      tool: "archguard",
      version: VERSION,
      root,
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      configSource: source,
      tsconfig: resolver.configFile,
    },
    summary: {
      files: files.length,
      edges: fullGraph.edgeCount,
      externalPackages: Object.keys(external).length,
      unresolved: unresolved.length,
      ignoredImports,
      cycles: cycles.length,
      violations: violationCounts,
    },
    score,
    layers: layerCounts,
    nodes,
    edges,
    external: Object.fromEntries(Object.entries(external).sort((a, b) => b[1] - a[1])),
    unresolved,
    cycles,
    violations,
  };
}

function safeRealpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  let lines = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++;
  return text.endsWith("\n") ? lines - 1 : lines;
}

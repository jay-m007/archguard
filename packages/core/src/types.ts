/**
 * Shared types for ArchGuard.
 *
 * Every file path stored in these structures is POSIX-style and relative to
 * the analysed project's root (e.g. "src/components/Button.tsx"). That keeps
 * reports portable between machines and operating systems.
 */

/** How a dependency was expressed in source code. */
export type ImportKind =
  | "static" //        import x from "./x"
  | "side-effect" //   import "./polyfill"
  | "re-export" //     export * from "./x"  /  export { a } from "./x"
  | "dynamic" //       await import("./x")
  | "require" //       const x = require("./x")
  | "import-equals" // import x = require("./x")
  | "import-type"; //  type T = import("./x").T

/** A raw import found in a file, before path resolution. */
export interface RawImport {
  specifier: string;
  kind: ImportKind;
  /** True when the import is erased at compile time (import type / export type). */
  typeOnly: boolean;
  /** 1-based line number where the import appears. */
  line: number;
}

/** A resolved, internal dependency edge: `from` depends on `to`. */
export interface Edge {
  from: string;
  to: string;
  specifier: string;
  kind: ImportKind;
  typeOnly: boolean;
  line: number;
}

export interface UnresolvedImport {
  from: string;
  specifier: string;
  line: number;
}

/** Per-file metrics. */
export interface FileNode {
  id: string;
  layer: string | null;
  /** Afferent coupling (Ca): how many internal files import this file. */
  fanIn: number;
  /** Efferent coupling (Ce): how many internal files this file imports. */
  fanOut: number;
  /** Robert C. Martin's instability metric I = Ce / (Ca + Ce), 0 = stable, 1 = unstable. */
  instability: number;
  /** Number of lines in the file. */
  loc: number;
  /** True if the framework loads this file directly (page, layout, route, config...). */
  entry: boolean;
}

export interface Cycle {
  /** Every file in the strongly connected component, sorted. */
  files: string[];
  /** One concrete, shortest import loop through the component, first file repeated at the end. */
  path: string[];
}

export type ViolationType = "circular-dependency" | "layer-violation" | "god-file" | "orphan-file";
export type Severity = "error" | "warning" | "info";

export interface Violation {
  type: ViolationType;
  severity: Severity;
  message: string;
  file: string;
  /** For edge-based violations: the imported file. */
  target?: string;
  /** For layer violations: the source line of the offending import. */
  line?: number;
  /** For layer violations: the rule that was broken, e.g. "components -> api". */
  rule?: string;
  /** Stable key used to compare violations between two reports (e.g. base vs PR). */
  key: string;
}

export interface LayerDefinition {
  name: string;
  /** Glob patterns relative to the project root. First matching layer wins. */
  patterns: string[];
}

export interface LayerRule {
  from: string;
  /** Layers that `from` must never import. */
  disallow?: string[];
  /** If set, `from` may import only these layers (plus itself and unlayered files). */
  allow?: string[];
  /** Human explanation shown in reports. */
  reason?: string;
}

export interface ArchGuardConfig {
  include: string[];
  exclude: string[];
  layers: LayerDefinition[];
  rules: LayerRule[];
  /** Glob patterns for files the framework loads directly (never reported as orphans). */
  entryPoints: string[];
  thresholds: {
    /** A file importing more than this many internal files is flagged as a god file. */
    maxFanOut: number;
    /** A file is flagged as a god file when fan-in AND fan-out both reach this value (a "hub"). */
    hubFanInOut: number;
    /** A file longer than this is flagged as a god file. */
    maxLoc: number;
  };
  /** Ignore `import type` edges when detecting cycles and layer violations (they vanish at runtime). */
  ignoreTypeOnlyImports: boolean;
  /** Report files nothing imports and that are not entry points. */
  reportOrphans: boolean;
}

export interface ScoreBreakdown {
  /** 0-100, higher is healthier. */
  health: number;
  /** Raw drift points before normalisation. */
  driftPoints: number;
  filesInCycles: number;
  layerViolations: number;
  godFiles: number;
  orphanFiles: number;
  grade: "A" | "B" | "C" | "D" | "F";
}

export interface Report {
  meta: {
    tool: "archguard";
    version: string;
    root: string;
    generatedAt: string;
    durationMs: number;
    configSource: string;
    tsconfig: string | null;
  };
  summary: {
    files: number;
    edges: number;
    externalPackages: number;
    unresolved: number;
    /** Imports of project files that are excluded from the graph (by config or build-output rules). */
    ignoredImports: number;
    cycles: number;
    violations: Record<ViolationType, number>;
  };
  score: ScoreBreakdown;
  layers: { name: string; files: number }[];
  nodes: FileNode[];
  edges: Edge[];
  external: Record<string, number>;
  unresolved: UnresolvedImport[];
  cycles: Cycle[];
  violations: Violation[];
}

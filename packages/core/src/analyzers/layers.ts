import picomatch from "picomatch";
import type { ArchGuardConfig, Edge, LayerRule, Violation } from "../types.js";

export type LayerOf = (file: string) => string | null;

/** Builds a function that maps a file to its layer: the first layer with a matching glob. */
export function createLayerMatcher(config: ArchGuardConfig): LayerOf {
  const matchers = config.layers.map((layer) => ({
    name: layer.name,
    isMatch: picomatch(layer.patterns, { dot: true }),
  }));
  const cache = new Map<string, string | null>();

  return (file) => {
    if (!cache.has(file)) {
      cache.set(file, matchers.find((m) => m.isMatch(file))?.name ?? null);
    }
    return cache.get(file)!;
  };
}

/** Does importing `toLayer` from `rule.from` break this rule? */
function breaks(rule: LayerRule, toLayer: string): boolean {
  if (toLayer === rule.from) return false; // a layer may always import itself
  if (rule.disallow?.includes(toLayer)) return true;
  if (rule.allow && !rule.allow.includes(toLayer)) return true;
  return false;
}

/**
 * Checks every import edge against the layer rules. A violation is reported
 * once per (file, imported file) pair, at the first line it occurs.
 */
export function findLayerViolations(edges: Edge[], layerOf: LayerOf, config: ArchGuardConfig): Violation[] {
  const rulesByLayer = new Map<string, LayerRule[]>();
  for (const rule of config.rules) {
    rulesByLayer.set(rule.from, [...(rulesByLayer.get(rule.from) ?? []), rule]);
  }

  const seen = new Set<string>();
  const violations: Violation[] = [];

  for (const edge of edges) {
    if (config.ignoreTypeOnlyImports && edge.typeOnly) continue;

    const fromLayer = layerOf(edge.from);
    const toLayer = layerOf(edge.to);
    if (!fromLayer || !toLayer) continue; // unlayered files are not constrained

    for (const rule of rulesByLayer.get(fromLayer) ?? []) {
      if (!breaks(rule, toLayer)) continue;

      const key = `layer-violation:${edge.from}->${edge.to}`;
      if (seen.has(key)) break;
      seen.add(key);

      violations.push({
        type: "layer-violation",
        severity: "error",
        file: edge.from,
        target: edge.to,
        line: edge.line,
        rule: `${fromLayer} -> ${toLayer}`,
        message:
          `"${fromLayer}" must not import "${toLayer}": ${edge.from} imports ${edge.to}` +
          (rule.reason ? `. ${rule.reason}` : ""),
        key,
      });
      break;
    }
  }

  return violations;
}

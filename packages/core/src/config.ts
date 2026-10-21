import fs from "node:fs";
import path from "node:path";
import type { ArchGuardConfig, LayerDefinition, LayerRule } from "./types.js";

export const CONFIG_FILENAME = "archguard.config.json";

/** Prefixes both the root-level and the src/ variant of a Next.js folder. */
const both = (...globs: string[]) => globs.flatMap((g) => [g, `src/${g}`]);

/**
 * Default layers for a Next.js project (App Router and Pages Router).
 * ORDER MATTERS: a file belongs to the first layer whose pattern matches,
 * so the more specific "api" layer comes before the general "routes" layer.
 */
export const DEFAULT_LAYERS: LayerDefinition[] = [
  { name: "api", patterns: both("app/api/**", "pages/api/**") },
  { name: "routes", patterns: both("app/**", "pages/**") },
  { name: "components", patterns: both("components/**") },
  { name: "hooks", patterns: both("hooks/**") },
  { name: "services", patterns: both("services/**", "server/**", "actions/**") },
  { name: "lib", patterns: both("lib/**", "utils/**", "helpers/**", "config/**", "constants/**", "types/**") },
];

export const DEFAULT_RULES: LayerRule[] = [
  {
    from: "components",
    disallow: ["routes", "api"],
    reason: "Reusable components must not depend on specific pages or API route handlers.",
  },
  {
    from: "hooks",
    disallow: ["routes", "api", "components"],
    reason: "Hooks hold reusable logic and must not depend on UI or route modules.",
  },
  {
    from: "lib",
    disallow: ["routes", "api", "components", "hooks", "services"],
    reason: "lib/ is the foundation layer and must not depend on anything above it.",
  },
  {
    from: "services",
    disallow: ["routes", "components", "hooks"],
    reason: "Server-side services must not depend on UI code.",
  },
  {
    from: "routes",
    disallow: ["api"],
    reason: "Pages should call API routes over HTTP (or share code via lib/services), not import route handlers.",
  },
];

/** Files Next.js (and tooling) load directly, so they are legitimately never imported. */
export const DEFAULT_ENTRY_POINTS: string[] = [
  ...both(
    "app/**/{page,layout,template,loading,error,global-error,not-found,default,route,head,opengraph-image,twitter-image,icon,apple-icon,sitemap,robots,manifest}.{ts,tsx,js,jsx,mjs}",
    "pages/**",
    "middleware.{ts,js}",
    "instrumentation.{ts,js}",
  ),
  "*.config.{ts,js,mjs,cjs}",
  "**/*.{test,spec}.{ts,tsx,js,jsx}",
  "**/__tests__/**",
  "**/*.stories.{ts,tsx,js,jsx}",
  "scripts/**",
];

export const DEFAULT_CONFIG: ArchGuardConfig = {
  include: ["**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts}"],
  exclude: [],
  layers: DEFAULT_LAYERS,
  rules: DEFAULT_RULES,
  entryPoints: DEFAULT_ENTRY_POINTS,
  thresholds: {
    maxFanOut: 15,
    hubFanInOut: 10,
    maxLoc: 500,
  },
  ignoreTypeOnlyImports: true,
  reportOrphans: true,
};

/** Folders that are never source code. Always excluded on top of user excludes. */
export const ALWAYS_EXCLUDE = [
  "**/node_modules/**",
  "**/.git/**",
  "**/.next/**",
  "**/.turbo/**",
  "**/.vercel/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/coverage/**",
  "**/*.d.ts",
  "**/*.min.js",
];

export interface LoadedConfig {
  config: ArchGuardConfig;
  /** Where the config came from, for the report. */
  source: string;
}

/**
 * Loads archguard.config.json from the project root (or an explicit path) and
 * merges it over the defaults. Arrays given by the user REPLACE the defaults
 * (so you can fully redefine layers), except `exclude`, which is additive.
 */
export function loadConfig(root: string, explicitPath?: string): LoadedConfig {
  const file = explicitPath ? path.resolve(explicitPath) : path.join(root, CONFIG_FILENAME);

  if (!fs.existsSync(file)) {
    if (explicitPath) throw new Error(`Config file not found: ${file}`);
    return { config: structuredClone(DEFAULT_CONFIG), source: "defaults (Next.js preset)" };
  }

  let user: Partial<ArchGuardConfig>;
  try {
    user = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`Could not parse ${file}: ${(err as Error).message}`);
  }

  const config = mergeConfig(user);
  validateConfig(config);
  const rel = path.relative(root, file);
  return { config, source: rel.startsWith("..") || path.isAbsolute(rel) ? file : rel };
}

export function mergeConfig(user: Partial<ArchGuardConfig>): ArchGuardConfig {
  const base = structuredClone(DEFAULT_CONFIG);
  return {
    include: user.include ?? base.include,
    exclude: [...base.exclude, ...(user.exclude ?? [])],
    layers: user.layers ?? base.layers,
    // If the user redefines layers but not rules, the default rules may reference
    // layers that no longer exist; validateConfig() reports that clearly.
    rules: user.rules ?? base.rules,
    entryPoints: user.entryPoints ?? base.entryPoints,
    thresholds: { ...base.thresholds, ...(user.thresholds ?? {}) },
    ignoreTypeOnlyImports: user.ignoreTypeOnlyImports ?? base.ignoreTypeOnlyImports,
    reportOrphans: user.reportOrphans ?? base.reportOrphans,
  };
}

export function validateConfig(config: ArchGuardConfig): void {
  const names = new Set<string>();
  for (const layer of config.layers) {
    if (!layer.name || !Array.isArray(layer.patterns) || layer.patterns.length === 0) {
      throw new Error(`Invalid layer definition: ${JSON.stringify(layer)}`);
    }
    if (names.has(layer.name)) throw new Error(`Duplicate layer name: "${layer.name}"`);
    names.add(layer.name);
  }
  for (const rule of config.rules) {
    const referenced = [rule.from, ...(rule.disallow ?? []), ...(rule.allow ?? [])];
    for (const name of referenced) {
      if (!names.has(name)) {
        throw new Error(
          `Rule ${JSON.stringify(rule)} references unknown layer "${name}". Known layers: ${[...names].join(", ")}`,
        );
      }
    }
    if (!rule.disallow && !rule.allow) {
      throw new Error(`Rule for "${rule.from}" needs either "disallow" or "allow".`);
    }
  }
}

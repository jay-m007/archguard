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
  // Server Actions colocated with routes ("use server" files) are server-side
  // logic that components are SUPPOSED to import, so they are services, not routes.
  { name: "services", patterns: both("app/**/actions/**", "app/**/actions.{ts,js}", "services/**", "server/**", "actions/**") },
  { name: "routes", patterns: both("app/**", "pages/**") },
  { name: "components", patterns: both("components/**") },
  { name: "hooks", patterns: both("hooks/**") },
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
    "app/**/{page,layout,template,loading,error,global-error,not-found,global-not-found,forbidden,unauthorized,default,route,head,opengraph-image,twitter-image,icon,apple-icon,sitemap,robots,manifest}.{ts,tsx,js,jsx,mjs,mts,cts}",
    "pages/**",
    "{middleware,proxy,instrumentation,instrumentation-client,mdx-components}.{ts,tsx,js,jsx,mjs,mts,cts}",
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

/** Folders that are never source code, at any depth. Always excluded on top of user excludes. */
export const ALWAYS_EXCLUDE = [
  "**/node_modules/**",
  "**/.git/**",
  "**/.next/**",
  "**/.turbo/**",
  "**/.vercel/**",
  "**/*.d.ts",
  "**/*.min.js",
];

/**
 * Build-output folder names. These are only excluded when they sit next to a
 * package.json (the project root, or a package in a monorepo), so real source
 * folders such as src/lib/build/ are still analysed.
 */
export const OUTPUT_DIRS = ["dist", "build", "out", "coverage"];

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

  let user: unknown;
  try {
    user = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`Could not parse ${file}: ${(err as Error).message}`);
  }

  try {
    validateShape(user);
  } catch (err) {
    throw new Error(`Invalid config ${file}: ${(err as Error).message}`);
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

/** Checks the shape of a user config before merging, with messages a human can act on. */
function validateShape(user: unknown): asserts user is Partial<ArchGuardConfig> {
  if (user === null || typeof user !== "object" || Array.isArray(user)) {
    throw new Error("Config must be a JSON object, e.g. { \"layers\": [...], \"rules\": [...] }");
  }
  const u = user as Record<string, unknown>;
  const stringArray = (key: string, v: unknown) => {
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new Error(`"${key}" must be an array of strings`);
  };
  for (const key of ["include", "exclude", "entryPoints"]) if (u[key] !== undefined) stringArray(key, u[key]);
  if (u.layers !== undefined) {
    if (!Array.isArray(u.layers)) throw new Error(`"layers" must be an array of { "name", "patterns" } objects`);
    u.layers.forEach((l, i) => {
      if (!l || typeof l !== "object" || typeof l.name !== "string") throw new Error(`layers[${i}] needs a string "name"`);
      stringArray(`layers[${i}].patterns`, l.patterns);
    });
  }
  if (u.rules !== undefined) {
    if (!Array.isArray(u.rules)) throw new Error(`"rules" must be an array`);
    u.rules.forEach((r, i) => {
      if (!r || typeof r !== "object" || typeof r.from !== "string") throw new Error(`rules[${i}] needs a string "from"`);
      if (r.disallow !== undefined) stringArray(`rules[${i}].disallow`, r.disallow);
      if (r.allow !== undefined) stringArray(`rules[${i}].allow`, r.allow);
    });
  }
  if (u.thresholds !== undefined) {
    if (!u.thresholds || typeof u.thresholds !== "object") throw new Error(`"thresholds" must be an object`);
    for (const [k, v] of Object.entries(u.thresholds)) {
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Error(`thresholds.${k} must be a non-negative number`);
    }
  }
  for (const key of ["ignoreTypeOnlyImports", "reportOrphans"]) {
    if (u[key] !== undefined && typeof u[key] !== "boolean") throw new Error(`"${key}" must be true or false`);
  }
}

export function validateConfig(config: ArchGuardConfig): void {
  if (config.include.length === 0) throw new Error(`"include" must contain at least one glob pattern`);
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

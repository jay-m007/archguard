/**
 * Regression tests for issues found in an independent code review.
 * Each test builds a tiny throwaway project in a temp folder.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { analyze } from "../src/analyze.js";
import { loadConfig, mergeConfig } from "../src/config.js";
import { extractImports } from "../src/extract.js";
import { DependencyGraph } from "../src/graph.js";
import { findCycles } from "../src/analyzers/cycles.js";
import { findGodFiles } from "../src/analyzers/metrics.js";

const temps: string[] = [];
afterAll(() => temps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function project(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "archguard-"));
  temps.push(root);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return root;
}

const edges = (r: Awaited<ReturnType<typeof analyze>>) => r.edges.map((e) => `${e.from} -> ${e.to}`).sort();

describe("review fixes", () => {
  it("#1 local folders named like Node built-ins stay internal with baseUrl", async () => {
    const root = project({
      "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: "src" } }),
      "src/main.ts": `import "util/format"; import "events/bus"; import fs from "fs"; import "components/Buton";`,
      "src/util/format.ts": "export {}",
      "src/events/bus.ts": "export {}",
      "src/components/Button.ts": "export {}",
    });
    const r = await analyze(root);
    expect(edges(r)).toEqual(["src/main.ts -> src/events/bus.ts", "src/main.ts -> src/util/format.ts"]);
    expect(r.external).toEqual({ "node:fs": 1 });
    // a typo under baseUrl is unresolved, not an npm package
    expect(r.unresolved.map((u) => u.specifier)).toEqual(["components/Buton"]);
  });

  it("#2 source folders named build/out are analysed; package-level dist is not", async () => {
    const root = project({
      "package.json": "{}",
      "src/main.ts": `import "./lib/build/helper"; import "./out/o"; import "../dist/bundle";`,
      "src/lib/build/helper.ts": "export {}",
      "src/out/o.ts": "export {}",
      "dist/bundle.js": "module.exports = {}",
    });
    const r = await analyze(root);
    expect(edges(r)).toEqual(["src/main.ts -> src/lib/build/helper.ts", "src/main.ts -> src/out/o.ts"]);
    expect(r.nodes.map((n) => n.id)).not.toContain("dist/bundle.js");
    expect(r.summary.ignoredImports).toBe(1);
  });

  it("#3 imports through a symlinked folder land on the real file", async () => {
    const root = project({
      "app/page.tsx": `import "../src/linked/s";`,
      "src/shared/s.ts": "export {}",
    });
    try {
      fs.symlinkSync(path.join(root, "src/shared"), path.join(root, "src/linked"), "dir");
    } catch (err) {
      // Windows only allows symlinks with admin rights or Developer Mode: nothing to test there.
      if ((err as NodeJS.ErrnoException).code === "EPERM") return;
      throw err;
    }
    const r = await analyze(root);
    expect(edges(r)).toEqual(["app/page.tsx -> src/shared/s.ts"]);
    expect(r.violations.filter((v) => v.type === "orphan-file")).toEqual([]);
  });

  it("#4 reports the globally shortest loop in a component", () => {
    const g = new DependencyGraph(
      ["a", "b", "c"],
      [["a", "b"], ["b", "c"], ["c", "b"], ["c", "a"]].map(([from, to]) => ({ from, to })),
    );
    expect(findCycles(g)[0].path).toEqual(["b", "c", "b"]);
  });

  it("#6 Next.js 15/16 special files are entry points, not orphans", async () => {
    const root = project({
      "proxy.ts": "export {}",
      "instrumentation-client.ts": "export {}",
      "mdx-components.tsx": "export {}",
      "app/forbidden.tsx": "export {}",
      "app/(shop)/[slug]/unauthorized.tsx": "export {}",
      "app/global-not-found.tsx": "export {}",
    });
    const r = await analyze(root);
    expect(r.violations.filter((v) => v.type === "orphan-file")).toEqual([]);
  });

  it("#8 rejects malformed configs with clear messages", () => {
    const withConfig = (cfg: string) => {
      const root = project({ "archguard.config.json": cfg });
      return () => loadConfig(root);
    };
    expect(withConfig("null")).toThrow(/must be a JSON object/);
    expect(withConfig("[]")).toThrow(/must be a JSON object/);
    expect(withConfig(`{"layers":{"a":1}}`)).toThrow(/"layers" must be an array/);
    expect(withConfig(`{"rules":[{"from":"lib","disallow":"routes"}]}`)).toThrow(/disallow" must be an array/);
    expect(withConfig(`{"thresholds":{"maxFanOut":"0"}}`)).toThrow(/maxFanOut must be a non-negative number/);
    expect(withConfig(`{"include":[]}`)).toThrow(/at least one glob/);
  });

  it("#9 ignores calls to a locally defined require, but not createRequire", () => {
    expect(extractImports("a.js", `const require = (x) => x; require("./nope");`)).toEqual([]);
    expect(extractImports("b.js", `function f(require) { return require("./nope"); }`)).toEqual([]);
    const esm = `import { createRequire } from "module"; const require = createRequire(import.meta.url); require("./yes");`;
    expect(extractImports("c.mjs", esm).map((i) => i.specifier)).toEqual(["module", "./yes"]);
  });

  it("#10 god-file limits are exclusive, matching the message", () => {
    const config = mergeConfig({ thresholds: { maxFanOut: 15, hubFanInOut: 99, maxLoc: 500 } });
    const node = (fanOut: number, loc: number) => ({ id: "x.ts", layer: null, fanIn: 0, fanOut, instability: 1, loc, entry: false });
    expect(findGodFiles([node(15, 500)], config)).toEqual([]);
    expect(findGodFiles([node(16, 501)], config)).toHaveLength(1);
  });
});

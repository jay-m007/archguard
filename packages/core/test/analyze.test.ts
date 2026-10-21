import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyze } from "../src/analyze.js";
import { mergeConfig } from "../src/config.js";
import { diffReports } from "../src/diff.js";

const fixture = (name: string) => path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", name);
const edgeList = (r: Awaited<ReturnType<typeof analyze>>) => r.edges.map((e) => `${e.from} -> ${e.to}`).sort();

describe("analyze: cycles fixture", () => {
  it("reports runtime cycles and ignores type-only cycles by default", async () => {
    const report = await analyze(fixture("cycles"));
    expect(report.cycles).toEqual([
      { files: ["src/a.ts", "src/b.ts", "src/c.ts"], path: ["src/a.ts", "src/b.ts", "src/c.ts", "src/a.ts"] },
      { files: ["src/self.ts"], path: ["src/self.ts", "src/self.ts"] },
    ]);
    expect(report.score.filesInCycles).toBe(4);
  });

  it("includes type-only cycles when ignoreTypeOnlyImports is false", async () => {
    const report = await analyze(fixture("cycles"), { config: mergeConfig({ ignoreTypeOnlyImports: false }) });
    expect(report.cycles.map((c) => c.files)).toContainEqual(["src/typeA.ts", "src/typeB.ts"]);
  });
});

describe("analyze: Next.js fixture", () => {
  it("resolves @/ aliases, relative paths and skips assets", async () => {
    const report = await analyze(fixture("nextapp"));
    expect(report.meta.tsconfig).toBe("tsconfig.json");
    expect(edgeList(report)).toEqual([
      "src/app/api/users/route.ts -> src/lib/db.ts",
      "src/app/dashboard/page.tsx -> src/app/api/users/route.ts",
      "src/app/dashboard/page.tsx -> src/hooks/useUser.ts",
      "src/app/layout.tsx -> src/components/Header.tsx",
      "src/app/page.tsx -> src/components/Card.tsx",
      "src/app/page.tsx -> src/lib/format.ts",
      "src/components/Card.tsx -> src/app/api/users/route.ts",
      "src/components/Card.tsx -> src/lib/types.ts",
      "src/components/Header.tsx -> src/components/Card.tsx",
      "src/lib/format.ts -> src/components/Card.tsx",
    ]);
  });

  it("assigns files to layers (api before routes)", async () => {
    const report = await analyze(fixture("nextapp"));
    const layer = (id: string) => report.nodes.find((n) => n.id === id)?.layer;
    expect(layer("src/app/api/users/route.ts")).toBe("api");
    expect(layer("src/app/page.tsx")).toBe("routes");
    expect(layer("src/components/Card.tsx")).toBe("components");
    expect(layer("src/lib/db.ts")).toBe("lib");
  });

  it("detects exactly the three planted layer violations", async () => {
    const report = await analyze(fixture("nextapp"));
    const layerViolations = report.violations
      .filter((v) => v.type === "layer-violation")
      .map((v) => `${v.rule} | ${v.file}:${v.line}`)
      .sort();
    expect(layerViolations).toEqual([
      "components -> api | src/components/Card.tsx:1",
      "lib -> components | src/lib/format.ts:1",
      "routes -> api | src/app/dashboard/page.tsx:1",
    ]);
  });

  it("records external packages, Node built-ins and unresolved imports", async () => {
    const report = await analyze(fixture("nextapp"));
    expect(report.external).toMatchObject({ "@prisma/client": 1, "node:fs": 1, "node:path": 1, react: 1 });
    expect(report.unresolved).toEqual([{ from: "src/hooks/useUser.ts", specifier: "@/lib/doesNotExist", line: 2 }]);
  });

  it("flags orphans but not Next.js entry points", async () => {
    const report = await analyze(fixture("nextapp"));
    const orphans = report.violations.filter((v) => v.type === "orphan-file").map((v) => v.file);
    expect(orphans).toEqual(["src/lib/unused.ts"]);
  });

  it("computes coupling metrics", async () => {
    const report = await analyze(fixture("nextapp"));
    const card = report.nodes.find((n) => n.id === "src/components/Card.tsx")!;
    expect(card).toMatchObject({ fanIn: 3, fanOut: 2, instability: 0.4 });
    expect(report.score.health).toBeLessThan(100);
    expect(report.score.layerViolations).toBe(3);
  });

  it("supports custom layers and allow-list rules", async () => {
    const config = mergeConfig({
      layers: [
        { name: "ui", patterns: ["src/components/**"] },
        { name: "core", patterns: ["src/lib/**"] },
      ],
      rules: [{ from: "ui", allow: [] }],
      reportOrphans: false,
    });
    const report = await analyze(fixture("nextapp"), { config });
    const rules = report.violations.filter((v) => v.type === "layer-violation").map((v) => v.rule);
    // Card -> lib/types is type-only (ignored); Card -> api route is unlayered here.
    expect(rules).toEqual([]);
    const strict = await analyze(fixture("nextapp"), { config: { ...config, ignoreTypeOnlyImports: false } });
    expect(strict.violations.filter((v) => v.type === "layer-violation").map((v) => v.rule)).toEqual(["ui -> core"]);
  });
});

describe("analyze: plain JavaScript fixture", () => {
  it("follows require(), dynamic import() and jsconfig baseUrl imports", async () => {
    const report = await analyze(fixture("jsapp"));
    expect(edgeList(report)).toEqual([
      "index.js -> lib/helper.js",
      "index.js -> lib/lazy.mjs",
      "lib/helper.js -> utils/slug.js",
    ]);
    expect(report.external).toEqual({ express: 1 });
    expect(report.edges.find((e) => e.to === "lib/lazy.mjs")?.kind).toBe("dynamic");
  });
});

describe("diffReports", () => {
  it("finds violations introduced by a change", async () => {
    const base = await analyze(fixture("nextapp"));
    const head = await analyze(fixture("cycles"));
    const diff = diffReports(base, head);
    expect(diff.introduced.some((v) => v.type === "circular-dependency")).toBe(true);
    expect(diff.resolved.some((v) => v.type === "layer-violation")).toBe(true);
  });
});

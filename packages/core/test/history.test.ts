import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyzeHistory, selectCommits } from "../src/history.js";

let repo: string;

const write = (rel: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), content);
};
const commit = (message: string) => {
  const g = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=t@example.com", ...args], { cwd: repo, stdio: "pipe" });
  g("add", "-A");
  g("commit", "-q", "--allow-empty", "-m", message);
};

/**
 * Builds a small repo whose architecture gets worse, then better:
 *   1. clean app
 *   2. introduces a cycle           (health drops)
 *   3. introduces a layer violation (drops again)
 *   4. fixes the cycle              (recovers)
 */
beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "archguard-git-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });

  write("web/tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["./*"] } } }));
  write("web/app/page.tsx", `import { A } from "@/components/A";\nexport default A;`);
  write("web/components/A.tsx", `import { b } from "@/lib/b";\nexport const A = () => b;`);
  write("web/lib/b.ts", `export const b = 1;`);
  write("README.md", "outside the analysed folder");
  commit("clean start");

  write("web/lib/b.ts", `import { c } from "./c";\nexport const b = c;`);
  write("web/lib/c.ts", `import { b } from "./b";\nexport const c = () => b;`);
  commit("add helper c (creates a cycle)");

  write("web/lib/d.ts", `import { A } from "@/components/A";\nimport { b } from "./b";\nexport const d = [A, b];`);
  write("web/app/page.tsx", `import { A } from "@/components/A";\nimport { d } from "@/lib/d";\nexport default [A, d];`);
  commit("lib imports a component");

  write("web/lib/c.ts", `export const c = () => 2;`);
  commit("break the cycle");
});

afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

describe("analyzeHistory", () => {
  it("scores every commit of a subfolder, oldest first", async () => {
    const history = await analyzeHistory(path.join(repo, "web"));
    expect(history.meta.subpath).toBe("web");
    expect(history.points.map((p) => p.message)).toEqual([
      "clean start",
      "add helper c (creates a cycle)",
      "lib imports a component",
      "break the cycle",
    ]);
    const [p1, p2, p3, p4] = history.points;
    expect(p1).toMatchObject({ analyzed: true, health: 100, cycles: 0, layerViolations: 0 });
    expect(p2.cycles).toBe(1);
    expect(p2.health).toBeLessThan(p1.health);
    expect(p3.layerViolations).toBe(1);
    // Raw drift grows; health is normalised by file count, and this commit also added a file.
    expect(p3.driftPoints).toBeGreaterThan(p2.driftPoints);
    expect(p3.health).toBeLessThanOrEqual(p2.health);
    expect(p4.cycles).toBe(0);
    expect(p4.health).toBeGreaterThan(p3.health);
  });

  it("finds the worst regression and the best improvement", async () => {
    const { trend } = await analyzeHistory(path.join(repo, "web"));
    expect(trend.firstHealth).toBe(100);
    expect(trend.regressions[0].message).toBe("add helper c (creates a cycle)");
    expect(trend.improvements[0].message).toBe("break the cycle");
    expect(trend.delta).toBe(trend.lastHealth! - 100);
  });

  it("limits the number of commits", async () => {
    const latest = await analyzeHistory(path.join(repo, "web"), { commits: 2 });
    expect(latest.points.map((p) => p.message)).toEqual(["lib imports a component", "break the cycle"]);
    const spread = await analyzeHistory(path.join(repo, "web"), { commits: 2, strategy: "spread" });
    expect(spread.points.map((p) => p.message)).toEqual(["clean start", "break the cycle"]);
  });

  it("never touches the working tree", async () => {
    write("web/uncommitted.ts", "export const wip = true;");
    await analyzeHistory(path.join(repo, "web"));
    expect(fs.readFileSync(path.join(repo, "web/uncommitted.ts"), "utf8")).toContain("wip");
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" });
    expect(status.trim()).toBe("?? web/uncommitted.ts");
    fs.rmSync(path.join(repo, "web/uncommitted.ts"));
  });

  it("rejects folders outside a git repository", async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "archguard-nogit-"));
    await expect(analyzeHistory(plain)).rejects.toThrow(/not inside a git repository/);
    fs.rmSync(plain, { recursive: true, force: true });
  });
});

describe("selectCommits", () => {
  const all = Array.from({ length: 10 }, (_, i) => i);
  it("latest takes the newest N", () => expect(selectCommits(all, 3, "latest")).toEqual([7, 8, 9]));
  it("spread includes first and last, evenly spaced", () => expect(selectCommits(all, 4, "spread")).toEqual([0, 3, 6, 9]));
  it("returns everything when N >= length", () => expect(selectCommits(all, 50, "spread")).toEqual(all));
});

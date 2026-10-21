import type { Explanation, History, Report, ReportDiff, Violation } from "@archguard/core";

const useColor = !process.env.NO_COLOR && process.stdout.isTTY && !process.argv.includes("--no-color");
const wrap = (code: number) => (s: string | number) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));

export const c = {
  bold: wrap(1),
  dim: wrap(2),
  red: wrap(31),
  green: wrap(32),
  yellow: wrap(33),
  blue: wrap(34),
  magenta: wrap(35),
  cyan: wrap(36),
};

const gradeColor = (grade: string) => (grade === "A" || grade === "B" ? c.green : grade === "C" ? c.yellow : c.red);

function section(title: string, count: number, color: (s: string | number) => string): string {
  return `\n${c.bold(title)} ${color(`(${count})`)}`;
}

function list<T>(items: T[], limit: number, render: (item: T) => string): string[] {
  const lines = items.slice(0, limit).map(render);
  if (items.length > limit) lines.push(c.dim(`  … and ${items.length - limit} more (see the JSON report)`));
  return lines;
}

/** Human-readable terminal report. */
export function formatReport(report: Report, limit: number): string {
  const { summary, score } = report;
  const byType = (t: Violation["type"]) => report.violations.filter((v) => v.type === t);
  const out: string[] = [];

  out.push("");
  out.push(`${c.bold(c.cyan("ArchGuard"))} ${c.dim(`v${report.meta.version}`)}  ${c.dim(report.meta.root)}`);
  out.push(c.dim(`config: ${report.meta.configSource} · aliases: ${report.meta.tsconfig ?? "none"} · ${report.meta.durationMs} ms`));
  out.push("");
  out.push(
    `${c.bold("Health")} ${gradeColor(score.grade)(c.bold(`${score.health}/100`))} ${gradeColor(score.grade)(`grade ${score.grade}`)}` +
      c.dim(`   (${score.driftPoints} drift points across ${summary.files} files)`),
  );
  out.push(
    `${summary.files} files · ${summary.edges} internal imports · ${summary.externalPackages} external packages` +
      (summary.unresolved ? ` · ${c.yellow(`${summary.unresolved} unresolved`)}` : "") +
      (summary.ignoredImports ? c.dim(` · ${summary.ignoredImports} imports of excluded files`) : ""),
  );

  const layers = report.layers.filter((l) => l.files > 0);
  if (layers.length) out.push(c.dim(`layers: ${layers.map((l) => `${l.name} ${l.files}`).join(" · ")}`));

  const cycles = report.cycles;
  out.push(section("Circular dependencies", cycles.length, cycles.length ? c.red : c.green));
  if (!cycles.length) out.push(c.green("  ✓ none"));
  out.push(
    ...list(cycles, limit, (cy) => {
      const head = `  ${c.red("✗")} ${cy.files.length} file${cy.files.length > 1 ? "s" : ""}: `;
      return head + cy.path.map((p, i) => (i === cy.path.length - 1 ? c.dim(p) : p)).join(c.dim(" → "));
    }),
  );

  const layerV = byType("layer-violation");
  out.push(section("Layer violations", layerV.length, layerV.length ? c.red : c.green));
  if (!layerV.length) out.push(c.green("  ✓ none"));
  out.push(...list(layerV, limit, (v) => `  ${c.red("✗")} ${c.magenta(v.rule ?? "")}  ${v.file}:${v.line} ${c.dim("→")} ${v.target}`));

  const god = byType("god-file");
  out.push(section("God files", god.length, god.length ? c.yellow : c.green));
  if (!god.length) out.push(c.green("  ✓ none"));
  out.push(...list(god, limit, (v) => `  ${c.yellow("!")} ${v.message.replace(/ Consider splitting.*$/, "")}`));

  const top = [...report.nodes].sort((a, b) => b.fanIn + b.fanOut - (a.fanIn + a.fanOut)).slice(0, 5).filter((n) => n.fanIn + n.fanOut > 0);
  if (top.length) {
    out.push(`\n${c.bold("Most coupled files")}`);
    out.push(c.dim(`  ${"fan-in".padStart(6)} ${"fan-out".padStart(7)} ${"instab.".padStart(7)}  file`));
    for (const n of top) {
      out.push(`  ${String(n.fanIn).padStart(6)} ${String(n.fanOut).padStart(7)} ${n.instability.toFixed(2).padStart(7)}  ${n.id}`);
    }
  }

  const orphans = byType("orphan-file");
  if (orphans.length) {
    out.push(section("Possibly unused files", orphans.length, c.blue));
    out.push(...list(orphans, limit, (v) => `  ${c.blue("·")} ${v.file}`));
  }

  if (report.unresolved.length) {
    out.push(section("Unresolved imports", report.unresolved.length, c.yellow));
    out.push(...list(report.unresolved, limit, (u) => `  ${c.yellow("?")} ${u.from}:${u.line} ${c.dim("→")} ${u.specifier}`));
  }

  out.push("");
  return out.join("\n");
}

/** Terminal view of a git-history analysis, with a bar per commit. */
export function formatHistory(history: History, limit: number): string {
  const out: string[] = [""];
  const { points, trend, meta } = history;
  out.push(`${c.bold(c.cyan("ArchGuard history"))} ${c.dim(`${meta.repo}${meta.subpath !== "." ? `/${meta.subpath}` : ""}`)}`);
  out.push(c.dim(`${points.length} commits (${meta.strategy}) · ${meta.durationMs} ms · config: ${meta.configSource}`));
  out.push("");
  out.push(c.dim(`  ${"commit".padEnd(9)} ${"date".padEnd(10)} ${"health".padStart(6)}  ${"".padEnd(20)} ${"cyc".padStart(3)} ${"lay".padStart(3)} ${"god".padStart(3)} ${"files".padStart(5)}  message`));

  let prev: number | null = null;
  for (const p of points) {
    if (!p.analyzed) {
      out.push(c.dim(`  ${p.shortSha.padEnd(9)} ${p.date.slice(0, 10)}      –  (no source files at this commit)  ${p.message.slice(0, 50)}`));
      continue;
    }
    const bar = "█".repeat(Math.round(p.health / 5)).padEnd(20, "·");
    const color = gradeColor(p.grade);
    const change = prev === null || p.health === prev ? " " : p.health > prev ? c.green("▲") : c.red("▼");
    out.push(
      `  ${p.shortSha.padEnd(9)} ${p.date.slice(0, 10)} ${color(String(p.health).padStart(6))}${change} ${color(bar)} ` +
        `${String(p.cycles).padStart(3)} ${String(p.layerViolations).padStart(3)} ${String(p.godFiles).padStart(3)} ${String(p.files).padStart(5)}  ${p.message.slice(0, 60)}`,
    );
    prev = p.health;
  }

  if (trend.delta !== null) {
    const d = trend.delta;
    out.push("");
    out.push(`${c.bold("Trend")} ${trend.firstHealth} → ${trend.lastHealth} ${d > 0 ? c.green(`(+${d}, improving)`) : d < 0 ? c.red(`(${d}, drifting)`) : c.dim("(stable)")}`);
  }
  if (trend.regressions.length) {
    out.push(`\n${c.bold("Biggest regressions")}`);
    out.push(...trend.regressions.slice(0, limit).map((r) => `  ${c.red(String(r.delta).padStart(4))}  ${r.to}  ${r.message}`));
  }
  if (trend.improvements.length) {
    out.push(`\n${c.bold("Biggest improvements")}`);
    out.push(...trend.improvements.slice(0, limit).map((r) => `  ${c.green(`+${r.delta}`.padStart(4))}  ${r.to}  ${r.message}`));
  }
  out.push("");
  return out.join("\n");
}

/** Terminal view of a base vs head comparison. */
export function formatDiff(base: Report, head: Report, diff: ReportDiff, limit: number, explanations?: Map<string, Explanation>): string {
  const out: string[] = [""];
  const d = diff.healthDelta;
  out.push(`${c.bold(c.cyan("ArchGuard diff"))}  health ${base.score.health} → ${head.score.health} ${d > 0 ? c.green(`(+${d})`) : d < 0 ? c.red(`(${d})`) : c.dim("(no change)")}`);
  out.push(section("Introduced", diff.introduced.length, diff.introduced.length ? c.red : c.green));
  if (!diff.introduced.length) out.push(c.green("  ✓ no new issues"));
  for (const v of diff.introduced.slice(0, limit)) {
    out.push(`  ${v.severity === "error" ? c.red("✗") : v.severity === "warning" ? c.yellow("!") : c.blue("·")} ${v.message}`);
    const e = explanations?.get(v.key);
    if (e) out.push(c.dim(`      why: ${e.explanation}`), c.dim(`      fix: ${e.suggestion}`));
  }
  if (diff.introduced.length > limit) out.push(c.dim(`  … and ${diff.introduced.length - limit} more`));
  out.push(section("Resolved", diff.resolved.length, c.green));
  for (const v of diff.resolved.slice(0, limit)) out.push(`  ${c.green("✓")} ${v.message}`);
  out.push("");
  return out.join("\n");
}

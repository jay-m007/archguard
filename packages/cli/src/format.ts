import type { Report, Violation } from "@archguard/core";

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

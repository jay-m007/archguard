#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { analyze, CONFIG_FILENAME, DEFAULT_CONFIG, VERSION, type Report } from "@archguard/core";
import { c, formatReport } from "./format.js";

const HELP = `
${c.bold("archguard")} — architecture drift detection for JS/TS codebases

${c.bold("Usage")}
  archguard analyze [path] [options]   Analyse a project (default: current directory)
  archguard init [path]                Write a starter ${CONFIG_FILENAME}

${c.bold("Options")}
  -c, --config <file>     Config file (default: <path>/${CONFIG_FILENAME}, else Next.js preset)
  -o, --out <file>        Where to write the JSON report (default: <path>/archguard-report.json)
      --no-report         Don't write a JSON report file
      --json              Print the JSON report to stdout instead of the summary
      --fail-on <level>   Exit with code 1 if issues at this level exist: error | warning | none (default: error)
      --limit <n>         Max items listed per section (default: 10)
      --no-color          Disable colours
  -h, --help              Show help
  -v, --version           Show version

${c.bold("Exit codes")}  0 = passed · 1 = issues at --fail-on level · 2 = could not run
`;

interface Args {
  command: string;
  target: string;
  config?: string;
  out?: string;
  writeReport: boolean;
  json: boolean;
  failOn: "error" | "warning" | "none";
  limit: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { command: "", target: ".", writeReport: true, json: false, failOn: "error", limit: 10 };
  const positional: string[] = [];

  const value = (i: number, flag: string) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("-")) throw new Error(`${flag} needs a value`);
    return v;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "-h": case "--help": args.command = "help"; break;
      case "-v": case "--version": args.command = "version"; break;
      case "-c": case "--config": args.config = value(i, a); i++; break;
      case "-o": case "--out": args.out = value(i, a); i++; break;
      case "--no-report": args.writeReport = false; break;
      case "--json": args.json = true; break;
      case "--no-color": break; // handled in format.ts
      case "--fail-on": {
        const v = value(i, a); i++;
        if (v !== "error" && v !== "warning" && v !== "none") throw new Error(`--fail-on must be error, warning or none`);
        args.failOn = v;
        break;
      }
      case "--limit": {
        const n = Number(value(i, a)); i++;
        if (!Number.isInteger(n) || n < 1) throw new Error("--limit must be a positive integer");
        args.limit = n;
        break;
      }
      default:
        if (a.startsWith("-")) throw new Error(`Unknown option: ${a}`);
        positional.push(a);
    }
  }

  if (!args.command) args.command = positional.shift() ?? "help";
  if (positional[0]) args.target = positional[0];
  return args;
}

function shouldFail(report: Report, failOn: Args["failOn"]): boolean {
  if (failOn === "none") return false;
  const levels = failOn === "error" ? ["error"] : ["error", "warning"];
  return report.violations.some((v) => levels.includes(v.severity));
}

async function runAnalyze(args: Args): Promise<number> {
  const root = path.resolve(args.target);
  const report = await analyze(root, { configPath: args.config });

  if (args.writeReport && !args.json) {
    const outFile = path.resolve(args.out ?? path.join(root, "archguard-report.json"));
    fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
    console.log(formatReport(report, args.limit));
    console.log(c.dim(`JSON report written to ${path.relative(process.cwd(), outFile) || outFile}`));
  } else if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    console.log(formatReport(report, args.limit));
  }

  const failed = shouldFail(report, args.failOn);
  if (!args.json) {
    console.log(failed ? c.red(`\n✗ Failed (--fail-on ${args.failOn})`) : c.green("\n✓ Passed"));
  }
  return failed ? 1 : 0;
}

function runInit(args: Args): number {
  const file = path.join(path.resolve(args.target), CONFIG_FILENAME);
  if (fs.existsSync(file)) {
    console.error(c.yellow(`${file} already exists — not overwriting.`));
    return 2;
  }
  const { layers, rules, thresholds, ignoreTypeOnlyImports, reportOrphans } = DEFAULT_CONFIG;
  const starter = { exclude: [], layers, rules, thresholds, ignoreTypeOnlyImports, reportOrphans };
  fs.writeFileSync(file, JSON.stringify(starter, null, 2) + "\n");
  console.log(c.green(`✓ Created ${file}`));
  console.log(c.dim("Edit the layers and rules to match your project, then run: archguard analyze"));
  return 0;
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(c.red(`Error: ${(err as Error).message}`));
    console.error(HELP);
    return 2;
  }

  switch (args.command) {
    case "help": console.log(HELP); return 0;
    case "version": console.log(VERSION); return 0;
    case "analyze": return runAnalyze(args);
    case "init": return runInit(args);
    default:
      console.error(c.red(`Unknown command: ${args.command}`));
      console.error(HELP);
      return 2;
  }
}

main().then(
  (code) => { process.exitCode = code; },
  (err) => {
    console.error(c.red(`Error: ${(err as Error).message}`));
    process.exitCode = 2;
  },
);

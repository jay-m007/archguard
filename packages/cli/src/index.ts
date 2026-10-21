#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  analyze, analyzeHistory, CONFIG_FILENAME, createExplainer, DEFAULT_CONFIG, diffReports, renderPrComment, VERSION,
  type Report,
} from "@archguard/core";
import { c, formatDiff, formatHistory, formatReport } from "./format.js";

const HELP = `
${c.bold("archguard")}: architecture drift detection for JS/TS codebases

${c.bold("Usage")}
  archguard analyze [path]            Analyse a project (default: current directory)
  archguard history [path]            Score past git commits to show drift over time
  archguard diff <base.json> <head.json>  Compare two reports (e.g. main vs a branch)
  archguard init [path]               Write a starter ${CONFIG_FILENAME}

${c.bold("Common options")}
  -c, --config <file>     Config file (default: <path>/${CONFIG_FILENAME}, else Next.js preset)
  -o, --out <file>        Where to write JSON output
      --json              Print JSON to stdout instead of the summary
      --limit <n>         Max items listed per section (default: 10)
      --no-color          Disable colours
  -h, --help · -v, --version

${c.bold("analyze")}
      --no-report         Don't write archguard-report.json
      --fail-on <level>   Exit 1 if issues at this level exist: error | warning | none (default: error)

${c.bold("history")}
      --commits <n>       Number of commits to analyse (default: 30)
      --spread            Spread the commits evenly over the whole history (default: the latest n)
      --ref <ref>         Branch/tag/commit to walk back from (default: HEAD)

${c.bold("diff")}
      --markdown          Print the GitHub pull-request comment instead of the terminal summary
      --explain           Add AI explanations (needs OPENAI_API_KEY; optional OPENAI_MODEL, OPENAI_BASE_URL)
      --root <path>       Project folder for --explain code context (default: head report's root)
      --fail-on <level>   Exit 1 if NEW issues at this level exist (default: error)

${c.bold("Exit codes")}  0 = passed · 1 = issues at --fail-on level · 2 = could not run
`;

type FailOn = "error" | "warning" | "none";

interface Args {
  command: string;
  positional: string[];
  config?: string;
  out?: string;
  writeReport: boolean;
  json: boolean;
  failOn: FailOn;
  limit: number;
  commits: number;
  spread: boolean;
  ref?: string;
  markdown: boolean;
  explain: boolean;
  root?: string;
}

function parseArgs(argvIn: string[]): Args {
  const args: Args = {
    command: "", positional: [], writeReport: true, json: false, failOn: "error", limit: 10,
    commits: 30, spread: false, markdown: false, explain: false,
  };
  // Accept both "--limit 5" and "--limit=5".
  const argv = argvIn.flatMap((a) => (/^--[a-z-]+=/.test(a) ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a]));

  const value = (i: number, flag: string) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("-")) throw new Error(`${flag} needs a value`);
    return v;
  };
  const positiveInt = (v: string, flag: string) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} must be a positive integer`);
    return n;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "-h": case "--help": args.command = "help"; break;
      case "-v": case "--version": args.command = "version"; break;
      case "-c": case "--config": args.config = value(i, a); i++; break;
      case "-o": case "--out": args.out = value(i, a); i++; break;
      case "--root": args.root = value(i, a); i++; break;
      case "--ref": args.ref = value(i, a); i++; break;
      case "--no-report": args.writeReport = false; break;
      case "--json": args.json = true; break;
      case "--spread": args.spread = true; break;
      case "--markdown": args.markdown = true; break;
      case "--explain": args.explain = true; break;
      case "--no-color": break; // handled in format.ts
      case "--fail-on": {
        const v = value(i, a); i++;
        if (v !== "error" && v !== "warning" && v !== "none") throw new Error(`--fail-on must be error, warning or none`);
        args.failOn = v;
        break;
      }
      case "--limit": args.limit = positiveInt(value(i, a), a); i++; break;
      case "--commits": args.commits = positiveInt(value(i, a), a); i++; break;
      default:
        if (a.startsWith("-")) throw new Error(`Unknown option: ${a}`);
        args.positional.push(a);
    }
  }

  if (!args.command) args.command = args.positional.shift() ?? "help";
  const maxPositional = args.command === "diff" ? 2 : 1;
  if (args.positional.length > maxPositional) {
    throw new Error(`Too many arguments for "${args.command}": ${args.positional.join(" ")}`);
  }
  return args;
}

const failsAt = (severities: string[], failOn: FailOn) =>
  failOn !== "none" && severities.some((s) => s === "error" || (failOn === "warning" && s === "warning"));

function writeJson(file: string, data: unknown): string {
  const abs = path.resolve(file);
  fs.writeFileSync(abs, JSON.stringify(data, null, 2));
  return path.relative(process.cwd(), abs) || abs;
}

async function runAnalyze(args: Args): Promise<number> {
  const root = path.resolve(args.positional[0] ?? ".");
  const report = await analyze(root, { configPath: args.config });

  // An empty analysis must never pass CI with a perfect score.
  if (report.summary.files === 0) {
    console.error(c.yellow(`No source files found in ${root}. Check the path and the "include"/"exclude" settings.`));
    return 2;
  }

  // The report file is written by default, or whenever --out is given; --json alone only prints.
  const writeFile = args.out !== undefined || (args.writeReport && !args.json);
  const written = writeFile ? writeJson(args.out ?? path.join(root, "archguard-report.json"), report) : null;

  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    console.log(formatReport(report, args.limit));
    if (written) console.log(c.dim(`JSON report written to ${written}`));
  }

  const failed = failsAt(report.violations.map((v) => v.severity), args.failOn);
  if (!args.json) console.log(failed ? c.red(`\n✗ Failed (--fail-on ${args.failOn})`) : c.green("\n✓ Passed"));
  return failed ? 1 : 0;
}

async function runHistory(args: Args): Promise<number> {
  const root = path.resolve(args.positional[0] ?? ".");
  const showProgress = !args.json && process.stderr.isTTY;
  const history = await analyzeHistory(root, {
    commits: args.commits,
    strategy: args.spread ? "spread" : "latest",
    ref: args.ref,
    configPath: args.config,
    onProgress: showProgress ? (done, total, sha) => process.stderr.write(`\r${c.dim(`analysing commit ${done + 1 > total ? total : done + 1}/${total} ${sha}   `)}`) : undefined,
  });
  if (showProgress) process.stderr.write("\r\x1b[K");

  const written = writeJson(args.out ?? path.join(root, "archguard-history.json"), history);
  if (args.json) {
    process.stdout.write(JSON.stringify(history, null, 2) + "\n");
  } else {
    console.log(formatHistory(history, args.limit));
    console.log(c.dim(`History written to ${written}. Open it in the ArchGuard dashboard to see the chart.`));
  }
  return 0;
}

async function runDiff(args: Args): Promise<number> {
  if (args.positional.length !== 2) throw new Error("diff needs two report files: archguard diff <base.json> <head.json>");
  const [base, head] = args.positional.map((f) => JSON.parse(fs.readFileSync(path.resolve(f), "utf8")) as Report);
  for (const r of [base, head]) {
    if (r?.meta?.tool !== "archguard" || !Array.isArray(r.violations)) throw new Error("Both files must be ArchGuard reports (archguard-report.json)");
  }
  const diff = diffReports(base, head);

  let explanations;
  if (args.explain) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.error(c.yellow("--explain needs the OPENAI_API_KEY environment variable; continuing without explanations."));
    } else {
      try {
        const explainer = createExplainer({ provider: "openai", apiKey, model: process.env.OPENAI_MODEL, baseUrl: process.env.OPENAI_BASE_URL });
        explanations = await explainer.explain(diff.introduced, head, path.resolve(args.root ?? head.meta.root));
      } catch (err) {
        console.error(c.yellow(`AI explanations failed (${(err as Error).message}); continuing without them.`));
      }
    }
  }

  if (args.json) process.stdout.write(JSON.stringify({ ...diff, explanations: explanations ? Object.fromEntries(explanations) : undefined }, null, 2) + "\n");
  else if (args.markdown) process.stdout.write(renderPrComment(base, head, diff, { explanations, limit: args.limit }) + "\n");
  else console.log(formatDiff(base, head, diff, args.limit, explanations));

  if (args.out) writeJson(args.out, diff);
  return failsAt(diff.introduced.map((v) => v.severity), args.failOn) ? 1 : 0;
}

function runInit(args: Args): number {
  const file = path.join(path.resolve(args.positional[0] ?? "."), CONFIG_FILENAME);
  if (fs.existsSync(file)) {
    console.error(c.yellow(`${file} already exists, so it was not overwritten.`));
    return 2;
  }
  const { layers, rules, thresholds, ignoreTypeOnlyImports, reportOrphans } = DEFAULT_CONFIG;
  fs.writeFileSync(file, JSON.stringify({ exclude: [], layers, rules, thresholds, ignoreTypeOnlyImports, reportOrphans }, null, 2) + "\n");
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
    case "history": return runHistory(args);
    case "diff": return runDiff(args);
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

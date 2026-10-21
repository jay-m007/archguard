import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyze, VERSION } from "./analyze.js";
import { loadConfig } from "./config.js";
import type { ArchGuardConfig, Grade } from "./types.js";

/** One analysed commit. */
export interface HistoryPoint {
  sha: string;
  shortSha: string;
  date: string; // ISO 8601 author date
  author: string;
  message: string;
  /** False when the analysed folder didn't exist yet (or had no source files) at this commit. */
  analyzed: boolean;
  files: number;
  edges: number;
  health: number;
  grade: Grade;
  driftPoints: number;
  cycles: number;
  filesInCycles: number;
  layerViolations: number;
  godFiles: number;
  orphanFiles: number;
  unresolved: number;
}

export interface Regression {
  from: string; // short sha before
  to: string; // short sha after
  message: string; // message of the commit that caused the drop
  delta: number; // health change (negative = worse)
}

export interface History {
  meta: {
    tool: "archguard";
    kind: "history";
    version: string;
    repo: string;
    subpath: string;
    generatedAt: string;
    durationMs: number;
    configSource: string;
    strategy: "latest" | "spread";
  };
  points: HistoryPoint[]; // oldest first
  trend: {
    firstHealth: number | null;
    lastHealth: number | null;
    delta: number | null;
    /** The biggest single-commit drops in health, worst first. */
    regressions: Regression[];
    /** The biggest single-commit improvements, best first. */
    improvements: Regression[];
  };
}

export interface HistoryOptions {
  /** How many commits to analyse (default 30). */
  commits?: number;
  /** "latest" = the N most recent commits; "spread" = N commits evenly spaced across all history. */
  strategy?: "latest" | "spread";
  /** Branch, tag or commit to walk back from (default HEAD). */
  ref?: string;
  configPath?: string;
  config?: ArchGuardConfig;
  onProgress?: (done: number, total: number, sha: string) => void;
}

const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });

/**
 * Phase 4 — architecture drift over time.
 *
 * For each selected commit we export that commit's files into a temporary folder
 * with `git archive` (read-only: the user's working tree, index and branches are
 * never touched), run the normal analysis on it, and record the score.
 *
 * The CURRENT config is used for every commit, so all commits are judged by the
 * same rules and their scores are directly comparable.
 */
export async function analyzeHistory(targetDir: string, options: HistoryOptions = {}): Promise<History> {
  const started = Date.now();
  const target = path.resolve(targetDir);
  const commitsWanted = options.commits ?? 30;
  const strategy = options.strategy ?? "latest";
  const ref = options.ref ?? "HEAD";
  if (!Number.isInteger(commitsWanted) || commitsWanted < 1) throw new Error("commits must be a positive integer");

  let repo: string;
  try {
    repo = git(target, ["rev-parse", "--show-toplevel"]).trim();
  } catch {
    throw new Error(`${target} is not inside a git repository`);
  }
  repo = fs.realpathSync(repo);
  const subpath = toPosix(path.relative(repo, fs.realpathSync(target)));

  const { config, source } = options.config
    ? { config: options.config, source: "inline" }
    : loadConfig(target, options.configPath);

  const commits = selectCommits(listCommits(repo, ref), commitsWanted, strategy);
  if (commits.length === 0) throw new Error(`No commits found for ${ref}`);

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "archguard-history-"));
  const points: HistoryPoint[] = [];

  try {
    for (const [i, c] of commits.entries()) {
      options.onProgress?.(i, commits.length, c.shortSha);
      const dir = path.join(tmpRoot, c.shortSha);
      fs.mkdirSync(dir);
      const exported = exportCommit(repo, c.sha, subpath, dir);
      const analysisRoot = path.join(dir, subpath);

      let point: HistoryPoint = { ...c, ...EMPTY_METRICS, analyzed: false };
      if (exported && fs.existsSync(analysisRoot)) {
        const report = await analyze(analysisRoot, { config });
        if (report.summary.files > 0) {
          point = {
            ...c,
            analyzed: true,
            files: report.summary.files,
            edges: report.summary.edges,
            health: report.score.health,
            grade: report.score.grade,
            driftPoints: report.score.driftPoints,
            cycles: report.summary.cycles,
            filesInCycles: report.score.filesInCycles,
            layerViolations: report.score.layerViolations,
            godFiles: report.score.godFiles,
            orphanFiles: report.score.orphanFiles,
            unresolved: report.summary.unresolved,
          };
        }
      }
      points.push(point);
      fs.rmSync(dir, { recursive: true, force: true }); // keep disk use to one commit at a time
    }
    options.onProgress?.(commits.length, commits.length, "");
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  return {
    meta: {
      tool: "archguard",
      kind: "history",
      version: VERSION,
      repo,
      subpath: subpath || ".",
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      configSource: source,
      strategy,
    },
    points,
    trend: computeTrend(points),
  };
}

const EMPTY_METRICS = {
  files: 0, edges: 0, health: 0, grade: "F" as Grade, driftPoints: 0, cycles: 0,
  filesInCycles: 0, layerViolations: 0, godFiles: 0, orphanFiles: 0, unresolved: 0,
};

type CommitInfo = Pick<HistoryPoint, "sha" | "shortSha" | "date" | "author" | "message">;

/** Commits on the first-parent chain (the "main line"), oldest first. */
function listCommits(repo: string, ref: string): CommitInfo[] {
  const SEP = "\x1f";
  const out = git(repo, ["log", "--first-parent", `--format=%H${SEP}%h${SEP}%aI${SEP}%an${SEP}%s`, ref]);
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, shortSha, date, author, message] = line.split(SEP);
      return { sha, shortSha, date, author, message };
    })
    .reverse();
}

/** Pick which commits to analyse. Always includes the newest commit. */
export function selectCommits<T>(all: T[], n: number, strategy: "latest" | "spread"): T[] {
  if (all.length <= n) return all;
  if (strategy === "latest") return all.slice(-n);
  if (n === 1) return [all[all.length - 1]];
  // Evenly spaced indices from the first to the last commit, inclusive.
  const picked = new Set<number>();
  for (let k = 0; k < n; k++) picked.add(Math.round((k * (all.length - 1)) / (n - 1)));
  return [...picked].sort((a, b) => a - b).map((i) => all[i]);
}

/**
 * Writes the files of `subpath` at commit `sha` into `dest` (read-only for the repo).
 * Returns false if the path didn't exist at that commit. Also used by the GitHub
 * Action to materialise the PR's base commit next to the checked-out head.
 */
export function exportCommit(repo: string, sha: string, subpath: string, dest: string): boolean {
  const tarFile = `${dest}.tar`;
  try {
    const pathArgs = subpath ? ["--", subpath] : [];
    execFileSync("git", ["archive", "--format=tar", "-o", tarFile, sha, ...pathArgs], { cwd: repo, stdio: "pipe" });
  } catch {
    return false; // e.g. the folder didn't exist yet at this commit
  }
  try {
    execFileSync("tar", ["-xf", tarFile, "-C", dest], { stdio: "pipe" });
    return true;
  } finally {
    fs.rmSync(tarFile, { force: true });
  }
}

export function computeTrend(points: HistoryPoint[]): History["trend"] {
  const analysed = points.filter((p) => p.analyzed);
  const steps: Regression[] = [];
  for (let i = 1; i < analysed.length; i++) {
    const delta = analysed[i].health - analysed[i - 1].health;
    if (delta !== 0) {
      steps.push({ from: analysed[i - 1].shortSha, to: analysed[i].shortSha, message: analysed[i].message, delta });
    }
  }
  const first = analysed[0]?.health ?? null;
  const last = analysed[analysed.length - 1]?.health ?? null;
  return {
    firstHealth: first,
    lastHealth: last,
    delta: first !== null && last !== null ? last - first : null,
    regressions: steps.filter((s) => s.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, 5),
    improvements: steps.filter((s) => s.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, 5),
  };
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

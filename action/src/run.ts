import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  analyze, createExplainer, diffReports, exportCommit, loadConfig, renderPrComment,
  type Explanation, type Report, type Violation,
} from "@archguard/core";
import { createGitHubClient } from "./github.js";

export interface RunContext {
  env: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  /** Where log lines and workflow commands go (stdout in production). */
  log?: (line: string) => void;
}

export interface RunResult {
  exitCode: number;
  head: Report;
  base?: Report;
  commentBody?: string;
  commentAction?: "created" | "updated" | "skipped" | "failed";
}

/** Reads an action input the way the Actions runner passes them: INPUT_<NAME> env vars. */
const input = (env: NodeJS.ProcessEnv, name: string, fallback = "") =>
  (env[`INPUT_${name.toUpperCase().replace(/ /g, "_")}`] ?? "").trim() || fallback;

/** Escapes text for GitHub workflow commands (::error ...::message). */
const escapeData = (s: string) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escapeProp = (s: string) => escapeData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");

/**
 * The GitHub Action.
 *
 * On a pull request:
 *   1. analyse the checked-out PR head
 *   2. export the PR's BASE commit with `git archive` and analyse it with the SAME config
 *   3. diff the two reports by violation key: only problems the PR introduces count
 *   4. optionally ask an LLM to explain the new problems
 *   5. post or update a single PR comment, add inline annotations, write the job summary
 *   6. fail the check if the PR introduces issues at the `fail-on` level
 *
 * On any other event (e.g. push to main) it analyses the code and writes the
 * job summary, but never fails — existing debt shouldn't block your main branch.
 */
export async function run(ctx: RunContext): Promise<RunResult> {
  const { env } = ctx;
  const log = ctx.log ?? ((l: string) => process.stdout.write(l + "\n"));

  const workspace = path.resolve(env.GITHUB_WORKSPACE ?? process.cwd());
  const target = path.resolve(workspace, input(env, "path", "."));
  const configInput = input(env, "config");
  const configPath = configInput ? path.resolve(workspace, configInput) : undefined;
  const failOn = input(env, "fail-on", "error");
  if (!["error", "warning", "none"].includes(failOn)) throw new Error(`fail-on must be error, warning or none (got "${failOn}")`);
  const wantComment = input(env, "comment", "true") === "true";
  const wantAnnotations = input(env, "annotations", "true") === "true";

  const { config } = loadConfig(target, configPath);

  log(`::group::Analysing ${path.relative(workspace, target) || "."}`);
  const head = await analyze(target, { config });
  log(`${head.summary.files} files, ${head.summary.edges} imports, health ${head.score.health}/100 (${head.score.grade})`);
  log("::endgroup::");

  const reportPath = path.resolve(input(env, "report-path") || path.join(env.RUNNER_TEMP ?? os.tmpdir(), "archguard-report.json"));
  fs.writeFileSync(reportPath, JSON.stringify(head, null, 2));
  setOutput(env, "health", String(head.score.health));
  setOutput(env, "grade", head.score.grade);
  setOutput(env, "report-path", reportPath);

  const event = readEvent(env);
  const pr = event?.pull_request as { number: number; base: { sha: string }; head: { sha: string } } | undefined;

  if (!pr) {
    const summary =
      `## 🛡️ ArchGuard\n\n**Health ${head.score.health}/100 (grade ${head.score.grade})** · ` +
      `${head.summary.cycles} circular dependencies · ${head.score.layerViolations} layer violations · ${head.score.godFiles} god files\n`;
    appendSummary(env, summary);
    log(`Not a pull request event (${env.GITHUB_EVENT_NAME ?? "unknown"}): reporting only.`);
    return { exitCode: 0, head };
  }

  // --- Base report -----------------------------------------------------------
  const repoRoot = fs.realpathSync(git(workspace, ["rev-parse", "--show-toplevel"]).trim());
  const subpath = path.relative(repoRoot, fs.realpathSync(target)).split(path.sep).join("/");
  ensureCommit(repoRoot, pr.base.sha, log);

  const baseDir = fs.mkdtempSync(path.join(env.RUNNER_TEMP ?? os.tmpdir(), "archguard-base-"));
  let base: Report;
  try {
    const exported = exportCommit(repoRoot, pr.base.sha, subpath, baseDir);
    const baseRoot = path.join(baseDir, subpath);
    if (exported && fs.existsSync(baseRoot) && !configPath) {
      // The PR's own config decides what counts as a violation, so a PR could loosen the rules to pass.
      // Compare with the base branch's config and say so loudly if they differ.
      try {
        const baseConfig = loadConfig(baseRoot, undefined).config;
        if (JSON.stringify(baseConfig) !== JSON.stringify(config)) {
          log("::warning::This PR changes the ArchGuard configuration (layers, rules, thresholds or excludes). Review that change; it affects what is reported.");
        }
      } catch {
        /* an unreadable base config is not worth failing the run */
      }
    }
    base = exported && fs.existsSync(baseRoot)
      ? await analyze(baseRoot, { config })
      : emptyReport(head); // the analysed folder is new in this PR
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }

  const diff = diffReports(base, head);
  setOutput(env, "health-delta", String(diff.healthDelta));
  setOutput(env, "introduced", String(diff.introduced.length));
  log(`Base health ${base.score.health} → head ${head.score.health}. Introduced ${diff.introduced.length}, resolved ${diff.resolved.length}.`);

  // --- Optional AI explanations ---------------------------------------------
  let explanations: Map<string, Explanation> | undefined;
  const apiKey = input(env, "openai-api-key");
  if (apiKey && diff.introduced.length) {
    try {
      explanations = await createExplainer({
        provider: "openai",
        apiKey,
        model: input(env, "openai-model", "gpt-4o-mini"),
        baseUrl: input(env, "openai-base-url", "https://api.openai.com/v1"),
        maxViolations: Number(input(env, "max-explanations", "10")) || 10,
        fetchImpl: ctx.fetchImpl,
      }).explain(diff.introduced, head, target);
      log(`AI explanations: ${explanations.size}`);
    } catch (err) {
      log(`::warning::AI explanations skipped: ${escapeData((err as Error).message)}`);
    }
  }

  // --- Report back ------------------------------------------------------------
  const body = renderPrComment(base, head, diff, {
    repoUrl: env.GITHUB_REPOSITORY ? `${env.GITHUB_SERVER_URL ?? "https://github.com"}/${env.GITHUB_REPOSITORY}` : undefined,
    headSha: pr.head.sha,
    pathPrefix: subpath,
    explanations,
  });
  appendSummary(env, body);

  if (wantAnnotations) {
    for (const v of diff.introduced) log(annotation(v, subpath));
  }

  let commentAction: RunResult["commentAction"] = "skipped";
  if (wantComment) {
    const token = input(env, "github-token");
    const [owner, repo] = (env.GITHUB_REPOSITORY ?? "/").split("/");
    if (!token || !owner || !repo) {
      log("::warning::No github-token or GITHUB_REPOSITORY; skipping the PR comment.");
    } else {
      try {
        const client = createGitHubClient({ apiUrl: env.GITHUB_API_URL ?? "https://api.github.com", token, owner, repo, fetchImpl: ctx.fetchImpl });
        commentAction = (await client.upsertComment(pr.number, body)).action;
        log(`PR comment ${commentAction}.`);
      } catch (err) {
        commentAction = "failed";
        const status = (err as { status?: number }).status;
        // PRs from forks get a read-only token: report, don't crash.
        log(`::warning::Could not post the PR comment${status === 403 ? " (the token is read-only; PRs from forks can't be commented on, and the workflow needs `permissions: pull-requests: write`)" : ""}: ${escapeData((err as Error).message)}`);
      }
    }
  }

  const blocking = diff.introduced.filter((v) => v.severity === "error" || (failOn === "warning" && v.severity === "warning"));
  const exitCode = failOn !== "none" && blocking.length > 0 ? 1 : 0;
  if (exitCode) log(`::error::This PR introduces ${blocking.length} architecture issue${blocking.length > 1 ? "s" : ""} at level "${failOn}" or above.`);
  return { exitCode, head, base, commentBody: body, commentAction };
}

/** A report for "nothing existed here yet", so everything in the PR counts as introduced. */
function emptyReport(like: Report): Report {
  return {
    ...like,
    summary: {
      files: 0, edges: 0, externalPackages: 0, unresolved: 0, ignoredImports: 0, cycles: 0,
      violations: { "circular-dependency": 0, "layer-violation": 0, "god-file": 0, "orphan-file": 0 },
    },
    score: { health: 100, driftPoints: 0, filesInCycles: 0, layerViolations: 0, godFiles: 0, orphanFiles: 0, grade: "A" },
    layers: [], nodes: [], edges: [], external: {}, unresolved: [], cycles: [], violations: [],
  };
}

function annotation(v: Violation, subpath: string): string {
  const level = v.severity === "error" ? "error" : v.severity === "warning" ? "warning" : "notice";
  const file = subpath ? `${subpath}/${v.file}` : v.file;
  const props = [`file=${escapeProp(file)}`, v.line ? `line=${v.line}` : "", `title=${escapeProp(`ArchGuard: ${v.type}`)}`].filter(Boolean).join(",");
  return `::${level} ${props}::${escapeData(v.message)}`;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** actions/checkout fetches only the head commit by default; fetch the base if it's missing. */
function ensureCommit(repo: string, sha: string, log: (l: string) => void): void {
  try {
    git(repo, ["cat-file", "-e", `${sha}^{commit}`]);
  } catch {
    log(`Fetching base commit ${sha.slice(0, 7)}…`);
    git(repo, ["fetch", "--no-tags", "--depth=1", "origin", sha]);
  }
}

function readEvent(env: NodeJS.ProcessEnv): Record<string, unknown> | null {
  if (!env.GITHUB_EVENT_PATH || !fs.existsSync(env.GITHUB_EVENT_PATH)) return null;
  return JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
}

function setOutput(env: NodeJS.ProcessEnv, name: string, value: string): void {
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function appendSummary(env: NodeJS.ProcessEnv, markdown: string): void {
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, markdown + "\n");
}

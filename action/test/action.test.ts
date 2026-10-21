/**
 * End-to-end tests for the GitHub Action. They run the real bundled
 * action/dist/index.cjs (exactly what GitHub executes) against:
 *   - a temporary git repo with a base commit and a "PR head" commit
 *   - a local HTTP server pretending to be the GitHub API and an OpenAI-compatible API
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const bundle = path.join(here, "..", "dist", "index.cjs");

let repo: string;
let baseSha: string;
let headSha: string;
let server: http.Server;
let apiUrl: string;

interface Recorded { method: string; url: string; body: unknown }
let requests: Recorded[] = [];
let existingComments: { id: number; body: string }[] = [];
let commentStatus = 201;

const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@e.com", ...args], { cwd, encoding: "utf8" }).trim();
const write = (rel: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), content);
};

beforeAll(async () => {
  if (!fs.existsSync(bundle)) throw new Error("Build the action first: npm run build -w @archguard/action");

  repo = fs.mkdtempSync(path.join(os.tmpdir(), "archguard-action-"));
  sh(repo, "init", "-q", "-b", "main");
  write("web/tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["./*"] } } }));
  write("web/app/page.tsx", `import { Card } from "@/components/Card";\nexport default Card;`);
  write("web/components/Card.tsx", `import { fmt } from "@/lib/fmt";\nexport const Card = () => fmt("x");`);
  write("web/lib/fmt.ts", `export const fmt = (s: string) => s;`);
  sh(repo, "add", "-A");
  sh(repo, "commit", "-q", "-m", "base");
  baseSha = sh(repo, "rev-parse", "HEAD");

  // The PR: lib imports a component (layer violation) and creates a cycle.
  write("web/lib/fmt.ts", `import { Card } from "@/components/Card";\nexport const fmt = (s: string) => s + String(Card);`);
  sh(repo, "add", "-A");
  sh(repo, "commit", "-q", "-m", "pr");
  headSha = sh(repo, "rev-parse", "HEAD");

  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : undefined;
      requests.push({ method: req.method!, url: req.url!, body });
      res.setHeader("Content-Type", "application/json");
      if (req.url!.startsWith("/repos/bytebyjay/demo/issues/7/comments") && req.method === "GET") {
        return res.end(JSON.stringify(existingComments));
      }
      if (req.url === "/repos/bytebyjay/demo/issues/7/comments" && req.method === "POST") {
        res.statusCode = commentStatus;
        return res.end(JSON.stringify(commentStatus === 201 ? { id: 99 } : { message: "Resource not accessible by integration" }));
      }
      if (req.url!.startsWith("/repos/bytebyjay/demo/issues/comments/") && req.method === "PATCH") {
        return res.end(JSON.stringify({ id: 55 }));
      }
      if (req.url === "/llm/chat/completions") {
        const sent = JSON.parse(body.messages[1].content).violations as { key: string }[];
        const items = sent.map((v) => ({ key: v.key, explanation: `Explained ${v.key}.`, suggestion: "Move the shared code to lib/." }));
        return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items }) } }] }));
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  apiUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => {
  server?.close();
  fs.rmSync(repo, { recursive: true, force: true });
});

beforeEach(() => {
  requests = [];
  existingComments = [];
  commentStatus = 201;
});

function runAction(inputs: Record<string, string>, event: object | null, eventName = "pull_request") {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "archguard-runner-"));
  const eventPath = path.join(tmp, "event.json");
  if (event) fs.writeFileSync(eventPath, JSON.stringify(event));
  const files = { output: path.join(tmp, "output"), summary: path.join(tmp, "summary.md") };
  fs.writeFileSync(files.output, "");
  fs.writeFileSync(files.summary, "");

  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    GITHUB_WORKSPACE: repo,
    GITHUB_EVENT_NAME: eventName,
    GITHUB_EVENT_PATH: event ? eventPath : "",
    GITHUB_REPOSITORY: "bytebyjay/demo",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_API_URL: apiUrl,
    GITHUB_OUTPUT: files.output,
    GITHUB_STEP_SUMMARY: files.summary,
    RUNNER_TEMP: tmp,
    "INPUT_GITHUB-TOKEN": "ghs_test",
    INPUT_PATH: "web",
  };
  for (const [k, v] of Object.entries(inputs)) env[`INPUT_${k.toUpperCase()}`] = v;

  return new Promise<{ code: number; stdout: string; output: string; summary: string }>((resolve) => {
    const child = spawn(process.execPath, [bundle], { env, cwd: repo });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stdout += d));
    child.on("close", (code) => {
      resolve({ code: code ?? -1, stdout, output: fs.readFileSync(files.output, "utf8"), summary: fs.readFileSync(files.summary, "utf8") });
      fs.rmSync(tmp, { recursive: true, force: true });
    });
  });
}

const prEvent = () => ({ pull_request: { number: 7, base: { sha: baseSha }, head: { sha: headSha } } });

describe("GitHub Action (bundled)", () => {
  it("comments on a PR with only the issues it introduces, annotates, and fails", async () => {
    const r = await runAction({}, prEvent());
    expect(r.code).toBe(1);

    const post = requests.find((q) => q.method === "POST" && q.url.endsWith("/comments"));
    const body = (post?.body as { body: string }).body;
    expect(body).toContain("<!-- archguard:pr-comment -->");
    expect(body).toContain("**Health: 100 →");
    expect(body).toContain("Circular dependency");
    expect(body).toContain("`lib -> components`");
    expect(body).toContain(`https://github.com/bytebyjay/demo/blob/${headSha}/web/lib/fmt.ts#L1`);

    expect(r.stdout).toMatch(/::error file=web\/lib\/fmt\.ts,line=1,title=ArchGuard%3A layer-violation::/);
    expect(r.output).toMatch(/introduced=2/);
    expect(r.output).toMatch(/health-delta=-\d+/);
    expect(r.summary).toContain("ArchGuard architecture check");
  });

  it("updates its existing comment instead of posting a second one", async () => {
    existingComments = [{ id: 1, body: "unrelated" }, { id: 55, body: "<!-- archguard:pr-comment -->\nold" }];
    await runAction({}, prEvent());
    expect(requests.some((q) => q.method === "POST")).toBe(false);
    expect(requests.find((q) => q.method === "PATCH")?.url).toBe("/repos/bytebyjay/demo/issues/comments/55");
  });

  it("adds AI explanations when an API key is provided", async () => {
    const r = await runAction({ "OPENAI-API-KEY": "sk-test", "OPENAI-BASE-URL": `${apiUrl}/llm` }, prEvent());
    const body = (requests.find((q) => q.method === "POST" && q.url.endsWith("/comments"))?.body as { body: string }).body;
    expect(requests.some((q) => q.url === "/llm/chat/completions")).toBe(true);
    expect(body).toContain("💡 Why it matters");
    expect(body).toContain("Move the shared code to lib/.");
    expect(r.stdout).toContain("AI explanations: 2");
  });

  it("respects fail-on: none", async () => {
    const r = await runAction({ "FAIL-ON": "none" }, prEvent());
    expect(r.code).toBe(0);
  });

  it("warns instead of crashing when the token can't comment (fork PRs)", async () => {
    commentStatus = 403;
    const r = await runAction({ "FAIL-ON": "none" }, prEvent());
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("::warning::Could not post the PR comment (the token is read-only");
  });

  it("only reports on push events and never fails", async () => {
    const r = await runAction({}, null, "push");
    expect(r.code).toBe(0);
    expect(requests).toHaveLength(0);
    expect(r.summary).toMatch(/Health \d+\/100/);
    expect(r.stdout).toContain("Not a pull request event (push)");
  });
});

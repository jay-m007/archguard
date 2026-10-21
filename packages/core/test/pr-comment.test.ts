import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { analyze } from "../src/analyze.js";
import { diffReports } from "../src/diff.js";
import { COMMENT_MARKER, renderPrComment } from "../src/markdown.js";
import { buildViolationContext, createExplainer, parseExplanations } from "../src/llm.js";

const fixture = (name: string) => path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", name);

describe("renderPrComment", () => {
  it("lists new issues with links, fixed issues, and the score change", async () => {
    const base = await analyze(fixture("jsapp")); // clean
    const head = await analyze(fixture("nextapp")); // has layer violations
    const md = renderPrComment(base, head, diffReports(base, head), {
      repoUrl: "https://github.com/bytebyjay/demo",
      headSha: "abc123",
      pathPrefix: "web",
    });
    expect(md.startsWith(COMMENT_MARKER)).toBe(true);
    expect(md).toContain(`**Health: ${base.score.health} → ${head.score.health}**`);
    expect(md).toContain("### New issues");
    expect(md).toContain("`components -> api`");
    expect(md).toContain("[`src/components/Card.tsx:1`](https://github.com/bytebyjay/demo/blob/abc123/web/src/components/Card.tsx#L1)");
    // errors are listed before info-level orphans
    expect(md.indexOf("Layer violation")).toBeLessThan(md.indexOf("Possibly unused file"));
  });

  it("celebrates a clean PR", async () => {
    const r = await analyze(fixture("jsapp"));
    const md = renderPrComment(r, r, diffReports(r, r));
    expect(md).toContain("introduces no new architecture issues");
    expect(md).not.toContain("### New issues");
  });

  it("shows fixed issues and embeds explanations", async () => {
    const base = await analyze(fixture("cycles"));
    const head = await analyze(fixture("jsapp"));
    const diff = diffReports(base, head);
    const md = renderPrComment(head, base, diffReports(head, base), {
      explanations: new Map([[base.violations[0].key, { explanation: "Loops break init order.", suggestion: "Extract shared code." }]]),
    });
    expect(diff.resolved.length).toBeGreaterThan(0);
    expect(md).toContain("💡 Why it matters");
    expect(md).toContain("**Suggested fix:** Extract shared code.");
    expect(renderPrComment(base, head, diff)).toContain("### Fixed in this PR");
  });
});

describe("LLM explainer", () => {
  it("sends only selected violations with code context and parses the reply", async () => {
    const report = await analyze(fixture("nextapp"));
    const layer = report.violations.filter((v) => v.type === "layer-violation");
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      const sent = JSON.parse(body.messages[1].content).violations;
      expect(sent).toHaveLength(2); // maxViolations
      expect(sent.every((s: { type: string }) => s.type !== "orphan-file")).toBe(true);
      expect(sent[0].context).toMatch(/\/\/ src\/.+\n\d+: /);
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ items: [
          { key: sent[0].key, explanation: "Because.", suggestion: "Move it." },
          { key: "made-up-key", explanation: "hallucinated" },
        ] }) } }],
      }));
    });
    const explainer = createExplainer({ provider: "openai", apiKey: "sk-test", maxViolations: 2, fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await explainer.explain(report.violations, report, fixture("nextapp"));
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0][0]).toBe("https://api.openai.com/v1/chat/completions");
    expect([...result.keys()]).toHaveLength(1);
    expect(layer.map((v) => v.key)).toContain([...result.keys()][0]);
    expect(result.has("made-up-key")).toBe(false);
  });

  it("raises on HTTP errors so callers can fall back", async () => {
    const report = await analyze(fixture("nextapp"));
    const fetchImpl = (async () => new Response("rate limited", { status: 429 })) as unknown as typeof fetch;
    const explainer = createExplainer({ provider: "openai", apiKey: "x", fetchImpl });
    await expect(explainer.explain(report.violations, report, fixture("nextapp"))).rejects.toThrow(/429/);
  });

  it("parseExplanations tolerates code fences and rejects malformed output", () => {
    const keys = new Set(["k"]);
    expect(parseExplanations('```json\n{"items":[{"key":"k","explanation":"e","suggestion":"s"}]}\n```', keys).get("k"))
      .toEqual({ explanation: "e", suggestion: "s" });
    expect(parseExplanations("not json", keys).size).toBe(0);
    expect(parseExplanations('{"items":"nope"}', keys).size).toBe(0);
    expect(parseExplanations('{"items":[{"key":"k","explanation":42}]}', keys).size).toBe(0);
  });

  it("builds cycle context from the import lines along the loop", async () => {
    const report = await analyze(fixture("cycles"));
    const cycle = report.violations.find((v) => v.type === "circular-dependency" && v.file === "src/a.ts")!;
    const ctx = buildViolationContext(cycle, report, fixture("cycles"));
    expect(ctx).toContain("// src/a.ts");
    expect(ctx).toContain('import { b } from "./b"');
    expect(ctx).toContain("// src/c.ts");
  });
});

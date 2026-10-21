import fs from "node:fs";
import path from "node:path";
import type { Report, Violation } from "./types.js";

/**
 * LLM explanations — optional and never load-bearing.
 *
 * Detection is 100% deterministic (graph algorithms). The LLM only turns a
 * violation that was ALREADY found into a short, human explanation plus a
 * concrete refactoring suggestion. If the API key is missing, the call fails or
 * the model returns garbage, ArchGuard simply posts its comment without
 * explanations.
 */

export interface Explanation {
  explanation: string;
  suggestion: string;
}

export interface Explainer {
  explain(violations: Violation[], report: Report, root: string): Promise<Map<string, Explanation>>;
}

export interface ExplainerConfig {
  /** Only "openai" today; any OpenAI-compatible API works via baseUrl (OpenRouter, Groq, Ollama...). */
  provider: "openai";
  apiKey: string;
  model?: string;
  baseUrl?: string;
  /** Explain at most this many violations per run, to bound cost (default 10). */
  maxViolations?: number;
  timeoutMs?: number;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
}

export function createExplainer(config: ExplainerConfig): Explainer {
  if (config.provider !== "openai") throw new Error(`Unknown LLM provider: ${config.provider}`);
  const model = config.model ?? "gpt-4o-mini";
  const baseUrl = (config.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const max = config.maxViolations ?? 10;
  const doFetch = config.fetchImpl ?? fetch;

  return {
    async explain(violations, report, root) {
      // Explain the important ones first; orphans are self-explanatory.
      const selected = violations
        .filter((v) => v.type !== "orphan-file")
        .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1))
        .slice(0, max);
      if (selected.length === 0) return new Map();

      const items = selected.map((v) => ({ key: v.key, type: v.type, message: v.message, context: buildViolationContext(v, report, root) }));

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 60_000);
      try {
        const res = await doFetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
          body: JSON.stringify({
            model,
            temperature: 0.2,
            response_format: { type: "json_object" },
            messages: buildPrompt(items),
          }),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`LLM API returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
        const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
        return parseExplanations(data.choices?.[0]?.message?.content ?? "", new Set(selected.map((v) => v.key)));
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

type PromptItem = { key: string; type: string; message: string; context: string };

export function buildPrompt(items: PromptItem[]): { role: "system" | "user"; content: string }[] {
  return [
    {
      role: "system",
      content:
        "You are a senior software architect reviewing a pull request in a JavaScript/TypeScript (often Next.js) codebase. " +
        "A static analysis tool has already detected architecture violations; they are real, do not dispute them. " +
        "For each one, explain in 1-2 plain sentences why it is a problem in THIS code, and give one concrete, minimal fix " +
        "(e.g. which import to move, which function to extract into which file). Refer to actual file and symbol names from the context. " +
        'Respond with JSON only: {"items":[{"key":"<key>","explanation":"...","suggestion":"..."}]}.',
    },
    { role: "user", content: JSON.stringify({ violations: items }, null, 1) },
  ];
}

/** Validates the model's JSON. Unknown keys and malformed entries are dropped, never trusted. */
export function parseExplanations(content: string, allowedKeys: Set<string>): Map<string, Explanation> {
  const result = new Map<string, Explanation>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    return result;
  }
  const items = (parsed as { items?: unknown })?.items;
  if (!Array.isArray(items)) return result;
  for (const item of items) {
    const { key, explanation, suggestion } = (item ?? {}) as Record<string, unknown>;
    if (typeof key !== "string" || !allowedKeys.has(key) || typeof explanation !== "string") continue;
    result.set(key, {
      explanation: explanation.slice(0, 600),
      suggestion: typeof suggestion === "string" ? suggestion.slice(0, 600) : "",
    });
  }
  return result;
}

/**
 * The code the model sees: just the relevant import lines with a little
 * surrounding context, never whole files — cheaper, faster and less private.
 */
export function buildViolationContext(v: Violation, report: Report, root: string): string {
  const snippet = (file: string, line: number, radius = 3) => {
    try {
      const all = fs.readFileSync(path.join(root, file), "utf8").split("\n");
      const from = Math.max(0, line - 1 - radius);
      return `// ${file}\n` + all.slice(from, line + radius).map((l, i) => `${from + i + 1}: ${l}`).join("\n");
    } catch {
      return `// ${file} (unreadable)`;
    }
  };

  if (v.type === "layer-violation" && v.line) return snippet(v.file, v.line);

  if (v.type === "circular-dependency") {
    const loop = v.message.split(": ").slice(1).join(": ").split(" -> ");
    const parts: string[] = [];
    for (let i = 0; i < loop.length - 1 && parts.length < 6; i++) {
      const edge = report.edges.find((e) => e.from === loop[i] && e.to === loop[i + 1]);
      if (edge) parts.push(snippet(edge.from, edge.line, 1));
    }
    return parts.join("\n\n");
  }

  if (v.type === "god-file") {
    const node = report.nodes.find((n) => n.id === v.file);
    const imports = report.edges.filter((e) => e.from === v.file).map((e) => e.to).slice(0, 25);
    return `// ${v.file}: ${node?.loc ?? "?"} lines, fan-in ${node?.fanIn}, fan-out ${node?.fanOut}\n// imports: ${imports.join(", ")}`;
  }

  return "";
}

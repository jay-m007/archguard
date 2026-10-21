import type { Edge } from "./types.js";

/**
 * A directed graph of files. An edge A -> B means "A imports B".
 *
 * Stored as an adjacency list (Map from node to the set of its successors),
 * which is O(V + E) in memory and lets us iterate a node's dependencies in
 * O(out-degree) — ideal for the traversal algorithms in ./analyzers.
 */
export class DependencyGraph {
  readonly nodes: string[];
  private readonly out = new Map<string, Set<string>>();
  private readonly inn = new Map<string, Set<string>>();

  constructor(nodes: string[], edges: Pick<Edge, "from" | "to">[]) {
    this.nodes = [...nodes].sort();
    for (const n of this.nodes) {
      this.out.set(n, new Set());
      this.inn.set(n, new Set());
    }
    for (const { from, to } of edges) {
      if (!this.out.has(from) || !this.out.has(to)) continue;
      this.out.get(from)!.add(to);
      this.inn.get(to)!.add(from);
    }
  }

  /** Files that `node` imports, sorted for deterministic traversal. */
  successors(node: string): string[] {
    return [...(this.out.get(node) ?? [])].sort();
  }

  /** Files that import `node`. */
  predecessors(node: string): string[] {
    return [...(this.inn.get(node) ?? [])].sort();
  }

  hasEdge(from: string, to: string): boolean {
    return this.out.get(from)?.has(to) ?? false;
  }

  /** Efferent coupling: number of distinct files this node imports. */
  fanOut(node: string): number {
    return this.out.get(node)?.size ?? 0;
  }

  /** Afferent coupling: number of distinct files importing this node. */
  fanIn(node: string): number {
    return this.inn.get(node)?.size ?? 0;
  }

  get edgeCount(): number {
    let total = 0;
    for (const set of this.out.values()) total += set.size;
    return total;
  }
}

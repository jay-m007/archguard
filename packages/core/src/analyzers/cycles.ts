import type { DependencyGraph } from "../graph.js";
import type { Cycle } from "../types.js";

/**
 * Tarjan's strongly connected components algorithm.
 *
 * A strongly connected component (SCC) is a maximal set of nodes where every
 * node can reach every other node. In a dependency graph, any SCC with more
 * than one file — or a file that imports itself — is a circular dependency.
 *
 * Idea: run a depth-first search, numbering nodes in the order they are first
 * visited (`index`). For each node we also track `lowlink`: the smallest index
 * reachable from it through the DFS subtree plus at most one "back edge" to a
 * node still on the stack. When a node finishes with lowlink == index, it is
 * the root of an SCC, and every node above it on the stack belongs to that SCC.
 *
 * Complexity: O(V + E) — each node and edge is processed once.
 *
 * This version is ITERATIVE (explicit work stack instead of recursion) so that
 * very long import chains in big repositories cannot overflow the call stack.
 */
export function stronglyConnectedComponents(graph: DependencyGraph): string[][] {
  let nextIndex = 0;
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];

  for (const start of graph.nodes) {
    if (index.has(start)) continue;

    // Each frame remembers which successor of `node` we will look at next.
    const work: { node: string; successors: string[]; next: number }[] = [];

    const enter = (node: string) => {
      index.set(node, nextIndex);
      lowlink.set(node, nextIndex);
      nextIndex++;
      stack.push(node);
      onStack.add(node);
      work.push({ node, successors: graph.successors(node), next: 0 });
    };

    enter(start);

    while (work.length > 0) {
      const frame = work[work.length - 1];

      if (frame.next < frame.successors.length) {
        const w = frame.successors[frame.next++];
        if (!index.has(w)) {
          enter(w); // tree edge: descend
        } else if (onStack.has(w)) {
          // back edge to a node in the current SCC candidate
          lowlink.set(frame.node, Math.min(lowlink.get(frame.node)!, index.get(w)!));
        }
        continue;
      }

      // All successors processed: finish this node.
      work.pop();
      const v = frame.node;

      if (lowlink.get(v) === index.get(v)) {
        const component: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          component.push(w);
        } while (w !== v);
        components.push(component.sort());
      }

      // Propagate lowlink to the parent frame (the "return" of the recursion).
      const parent = work[work.length - 1];
      if (parent) {
        lowlink.set(parent.node, Math.min(lowlink.get(parent.node)!, lowlink.get(v)!));
      }
    }
  }

  return components;
}

/**
 * Finds every circular dependency and, for each one, a concrete shortest loop
 * that a developer can follow ("a.ts -> b.ts -> c.ts -> a.ts").
 */
export function findCycles(graph: DependencyGraph): Cycle[] {
  const cycles: Cycle[] = [];

  for (const component of stronglyConnectedComponents(graph)) {
    const isSelfLoop = component.length === 1 && graph.hasEdge(component[0], component[0]);
    if (component.length < 2 && !isSelfLoop) continue;

    cycles.push({ files: component, path: shortestCycle(graph, component) });
  }

  // Biggest tangles first: they are the most expensive to untangle.
  return cycles.sort((a, b) => b.files.length - a.files.length || a.files[0].localeCompare(b.files[0]));
}

/** Components larger than this only search from one start file, to keep big repos fast. */
export const EXACT_SHORTEST_CYCLE_LIMIT = 300;

/**
 * The shortest import loop anywhere in the component: one BFS per member, keep
 * the shortest result. That costs O(V·(V+E)) inside the component, so for very
 * large tangles we fall back to a single BFS from the first file, which still
 * gives a valid (but not necessarily globally shortest) loop.
 */
export function shortestCycle(graph: DependencyGraph, component: string[]): string[] {
  const starts = component.length <= EXACT_SHORTEST_CYCLE_LIMIT ? component : [component[0]];
  let best: string[] | null = null;
  for (const start of starts) {
    const loop = shortestCycleThrough(graph, component, start);
    if (!best || loop.length < best.length) best = loop;
    if (best.length === 2) break; // a self-import can't be beaten
  }
  return best!;
}

/**
 * Breadth-first search restricted to one SCC, starting from `start` and
 * stopping when we get back to it. BFS explores paths in order of length, so the
 * first loop found is the shortest one through `start`.
 */
function shortestCycleThrough(graph: DependencyGraph, component: string[], start: string): string[] {
  const members = new Set(component);
  if (graph.hasEdge(start, start)) return [start, start];

  const parent = new Map<string, string>();
  const queue: string[] = [];
  for (const s of graph.successors(start)) {
    if (members.has(s) && !parent.has(s)) {
      parent.set(s, start);
      queue.push(s);
    }
  }

  while (queue.length > 0) {
    const node = queue.shift()!;
    for (const next of graph.successors(node)) {
      if (!members.has(next)) continue;
      if (next === start) {
        // Walk parents back to the start to rebuild the loop.
        const loop = [node];
        let cur = node;
        while (parent.get(cur) !== start) {
          cur = parent.get(cur)!;
          loop.push(cur);
        }
        return [start, ...loop.reverse(), start];
      }
      if (!parent.has(next)) {
        parent.set(next, node);
        queue.push(next);
      }
    }
  }

  return [start, ...component.filter((f) => f !== start), start]; // unreachable for a true SCC; defensive fallback
}

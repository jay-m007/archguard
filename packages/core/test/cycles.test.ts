import { describe, expect, it } from "vitest";
import { DependencyGraph } from "../src/graph.js";
import { findCycles, stronglyConnectedComponents } from "../src/analyzers/cycles.js";

const graph = (edges: [string, string][]) => {
  const nodes = [...new Set(edges.flat())];
  return new DependencyGraph(nodes, edges.map(([from, to]) => ({ from, to })));
};

describe("Tarjan's SCC", () => {
  it("finds no cycles in a DAG", () => {
    const g = graph([["a", "b"], ["b", "c"], ["a", "c"]]);
    expect(findCycles(g)).toEqual([]);
    expect(stronglyConnectedComponents(g)).toHaveLength(3); // every node is its own SCC
  });

  it("finds a simple three-file cycle with its loop path", () => {
    const g = graph([["a", "b"], ["b", "c"], ["c", "a"], ["c", "d"]]);
    expect(findCycles(g)).toEqual([{ files: ["a", "b", "c"], path: ["a", "b", "c", "a"] }]);
  });

  it("finds multiple independent cycles, largest first", () => {
    const g = graph([
      ["a", "b"], ["b", "a"],
      ["x", "y"], ["y", "z"], ["z", "x"],
      ["b", "x"], // connects the two cycles one-way: still separate SCCs
    ]);
    const cycles = findCycles(g);
    expect(cycles.map((c) => c.files)).toEqual([["x", "y", "z"], ["a", "b"]]);
  });

  it("detects self-imports", () => {
    const g = graph([["a", "a"], ["a", "b"]]);
    expect(findCycles(g)).toEqual([{ files: ["a"], path: ["a", "a"] }]);
  });

  it("returns the SHORTEST loop through a tangled component", () => {
    // a -> b -> c -> d -> a  plus a shortcut d? no: a -> d directly and d -> a.
    const g = graph([["a", "b"], ["b", "c"], ["c", "d"], ["d", "a"], ["a", "d"]]);
    const [cycle] = findCycles(g);
    expect(cycle.files).toEqual(["a", "b", "c", "d"]);
    expect(cycle.path).toEqual(["a", "d", "a"]);
  });

  it("handles a 20,000-node chain without stack overflow (iterative DFS)", () => {
    const n = 20_000;
    const edges: [string, string][] = [];
    for (let i = 0; i < n - 1; i++) edges.push([`f${i}`, `f${i + 1}`]);
    edges.push([`f${n - 1}`, "f0"]); // close the loop
    const cycles = findCycles(graph(edges));
    expect(cycles).toHaveLength(1);
    expect(cycles[0].files).toHaveLength(n);
  });
});

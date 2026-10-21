/**
 * Turns a report into React Flow nodes/edges and lays them out with dagre
 * (a layered "Sugiyama" layout: it arranges a directed graph in ranks so most
 * edges point the same way, and minimises edge crossings between ranks).
 */
import dagre from "@dagrejs/dagre";
import type { Edge, Node } from "@xyflow/react";
import { basename, dirname, folderOf, indexIssues, isCycleEdge, type Report, type Violation, type ViolationType } from "./model";

export type IssueFilter = "all" | "issues" | ViolationType;

export interface GraphOptions {
  mode: "files" | "folders";
  folderDepth: number;
  hiddenLayers: Set<string>;
  issueFilter: IssueFilter;
  /** Only show files under this folder (set by double-clicking a folder). */
  scope: string | null;
  showTypeOnly: boolean;
  /** Restrict to exactly these files (e.g. one cycle). */
  onlyFiles?: Set<string> | null;
}

export interface FileNodeData extends Record<string, unknown> {
  kind: "file";
  id: string;
  label: string;
  dir: string;
  layer: string | null;
  color: string;
  issues: ViolationType[];
  fanIn: number;
  fanOut: number;
}

export interface FolderNodeData extends Record<string, unknown> {
  kind: "folder";
  id: string;
  label: string;
  files: number;
  layer: string | null;
  color: string;
  issueCounts: Partial<Record<ViolationType, number>>;
}

export interface EdgeData extends Record<string, unknown> {
  cycle: boolean;
  violation: boolean;
  typeOnly: boolean;
  weight: number;
}

export interface BuiltGraph {
  nodes: Node<FileNodeData | FolderNodeData>[];
  edges: Edge<EdgeData>[];
  /** Files hidden by the filters (shown as a hint in the UI). */
  hiddenFiles: number;
  tooLarge: boolean;
}

const FILE_W = 196;
const FILE_H = 46;
const FOLDER_W = 216;
const FOLDER_H = 58;
/** Above this many file nodes, the files view becomes unreadable; we suggest the folder view. */
export const FILE_NODE_LIMIT = 400;

export function buildGraph(report: Report, colors: Map<string | null, string>, opts: GraphOptions): BuiltGraph {
  const idx = indexIssues(report);

  // 1. Which files are visible?
  const involved = (file: string): boolean => {
    const list = idx.byFile.get(file) ?? [];
    if (opts.issueFilter === "all") return true;
    if (opts.issueFilter === "issues") return list.length > 0;
    return list.some((v) => v.type === opts.issueFilter);
  };
  const visible = new Set(
    report.nodes
      .filter((n) => !opts.hiddenLayers.has(n.layer ?? "(none)"))
      .filter((n) => !opts.scope || n.id === opts.scope || n.id.startsWith(`${opts.scope}/`))
      .filter((n) => involved(n.id))
      .filter((n) => !opts.onlyFiles || opts.onlyFiles.has(n.id))
      .map((n) => n.id),
  );
  const hiddenFiles = report.nodes.length - visible.size;

  // Edge flags, deduplicated per (from, to).
  const edgeMap = new Map<string, EdgeData & { from: string; to: string }>();
  for (const e of report.edges) {
    if (!opts.showTypeOnly && e.typeOnly) continue;
    if (!visible.has(e.from) || !visible.has(e.to)) continue;
    const key = `${e.from}->${e.to}`;
    const prev = edgeMap.get(key);
    edgeMap.set(key, {
      from: e.from,
      to: e.to,
      cycle: isCycleEdge(idx, e.from, e.to) && !e.typeOnly,
      violation: idx.violatingEdges.has(key),
      typeOnly: (prev?.typeOnly ?? true) && e.typeOnly,
      weight: 1,
    });
  }

  if (opts.mode === "files") {
    const fileNodes = report.nodes.filter((n) => visible.has(n.id));
    const nodes: Node<FileNodeData>[] = fileNodes.map((n) => ({
      id: n.id,
      type: "file",
      position: { x: 0, y: 0 },
      data: {
        kind: "file",
        id: n.id,
        label: basename(n.id),
        dir: dirname(n.id),
        layer: n.layer,
        color: colors.get(n.layer) ?? "var(--layer-none)",
        issues: [...new Set((idx.byFile.get(n.id) ?? []).map((v: Violation) => v.type))],
        fanIn: n.fanIn,
        fanOut: n.fanOut,
      },
    }));
    const edges = [...edgeMap.values()].map((e) => toEdge(`${e.from}->${e.to}`, e.from, e.to, e));
    return { ...layout(nodes, edges, FILE_W, FILE_H), hiddenFiles, tooLarge: nodes.length > FILE_NODE_LIMIT };
  }

  // 2. Folder view: aggregate files into folders and edges into weighted folder edges.
  const folders = new Map<string, FolderNodeData & { layerVotes: Map<string | null, number> }>();
  for (const n of report.nodes) {
    if (!visible.has(n.id)) continue;
    const f = folderOf(n.id, opts.folderDepth);
    const entry: FolderNodeData & { layerVotes: Map<string | null, number> } = folders.get(f) ?? {
      kind: "folder", id: f, label: f, files: 0, layer: null, color: "", issueCounts: {}, layerVotes: new Map(),
    };
    entry.files++;
    entry.layerVotes.set(n.layer, (entry.layerVotes.get(n.layer) ?? 0) + 1);
    for (const t of new Set((idx.byFile.get(n.id) ?? []).map((v) => v.type))) {
      entry.issueCounts[t] = (entry.issueCounts[t] ?? 0) + 1;
    }
    folders.set(f, entry);
  }

  const nodes: Node<FolderNodeData>[] = [...folders.values()].map(({ layerVotes, ...f }) => {
    const layer = [...layerVotes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null; // majority layer
    return { id: f.id, type: "folder", position: { x: 0, y: 0 }, data: { ...f, layer, color: colors.get(layer) ?? "var(--layer-none)" } };
  });

  const folderEdges = new Map<string, EdgeData & { from: string; to: string }>();
  for (const e of edgeMap.values()) {
    const a = folderOf(e.from, opts.folderDepth);
    const b = folderOf(e.to, opts.folderDepth);
    if (a === b) continue;
    const key = `${a}->${b}`;
    const prev = folderEdges.get(key);
    folderEdges.set(key, {
      from: a,
      to: b,
      cycle: (prev?.cycle ?? false) || e.cycle,
      violation: (prev?.violation ?? false) || e.violation,
      typeOnly: (prev?.typeOnly ?? true) && e.typeOnly,
      weight: (prev?.weight ?? 0) + 1,
    });
  }
  const edges = [...folderEdges.values()].map((e) => toEdge(`${e.from}->${e.to}`, e.from, e.to, e));
  return { ...layout(nodes, edges, FOLDER_W, FOLDER_H), hiddenFiles, tooLarge: false };
}

function toEdge(id: string, source: string, target: string, data: EdgeData): Edge<EdgeData> {
  return { id, source, target, type: "dep", data };
}

function layout<N extends Node>(nodes: N[], edges: Edge[], w: number, h: number): { nodes: N[]; edges: Edge<EdgeData>[] } {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 18, ranksep: 90, marginx: 40, marginy: 40 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.id, { width: w, height: h });
  for (const e of edges) g.setEdge(e.source, e.target);
  dagre.layout(g);
  return {
    nodes: nodes.map((n) => {
      const p = g.node(n.id);
      return { ...n, width: w, height: h, position: { x: p.x - w / 2, y: p.y - h / 2 } };
    }),
    edges: edges as Edge<EdgeData>[],
  };
}

"use client";

import {
  Background,
  BaseEdge,
  Controls,
  getBezierPath,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { memo, useEffect, useMemo, useState } from "react";
import { buildGraph, FILE_NODE_LIMIT, type EdgeData, type FileNodeData, type FolderNodeData, type IssueFilter } from "@/lib/layout";
import { ISSUE_LABEL, type Report, type ViolationType } from "@/lib/model";

interface Props {
  report: Report;
  colors: Map<string | null, string>;
  issueFilter: IssueFilter;
  /** When set, only the files of this cycle are drawn. */
  cycleFocus: number | null;
  hiddenLayers: Set<string>;
  selected: string | null;
  onSelect: (id: string | null) => void;
}

export function GraphView(props: Props) {
  return (
    <ReactFlowProvider>
      <GraphInner {...props} />
    </ReactFlowProvider>
  );
}

function GraphInner({ report, colors, issueFilter, cycleFocus, hiddenLayers, selected, onSelect }: Props) {
  const large = report.nodes.length > FILE_NODE_LIMIT;
  const [mode, setMode] = useState<"files" | "folders">(large ? "folders" : "files");
  const [folderDepth, setFolderDepth] = useState(2);
  const [scope, setScope] = useState<string | null>(null);
  const [showTypeOnly, setShowTypeOnly] = useState(false);
  const [query, setQuery] = useState("");
  const flow = useReactFlow();

  // Reset view state when a different report is loaded.
  useEffect(() => {
    setMode(report.nodes.length > FILE_NODE_LIMIT ? "folders" : "files");
    setChosenMode(false);
    setScope(null);
    setQuery("");
  }, [report]);

  // A narrowed issue filter usually leaves few enough files to show individually.
  const [chosenMode, setChosenMode] = useState(false); // the user clicked Files/Folders themselves
  const effectiveMode = !chosenMode && issueFilter !== "all" && issueFilter !== "issues" && mode === "folders" && !scope ? "files" : mode;

  const onlyFiles = useMemo(
    () => (issueFilter === "circular-dependency" && cycleFocus !== null && report.cycles[cycleFocus] ? new Set(report.cycles[cycleFocus].files) : null),
    [issueFilter, cycleFocus, report],
  );
  const graph = useMemo(
    () => buildGraph(report, colors, { mode: effectiveMode, folderDepth, hiddenLayers, issueFilter, scope, showTypeOnly, onlyFiles }),
    [report, colors, effectiveMode, folderDepth, hiddenLayers, issueFilter, scope, showTypeOnly, onlyFiles],
  );

  // Neighbourhood of the selected file: it and its direct imports/importers stay bright.
  const focus = useMemo(() => {
    if (!selected || effectiveMode !== "files") return null;
    const ids = new Set([selected]);
    for (const e of graph.edges) {
      if (e.source === selected) ids.add(e.target);
      if (e.target === selected) ids.add(e.source);
    }
    return ids;
  }, [selected, graph.edges, effectiveMode]);

  const q = query.trim().toLowerCase();
  const nodes = useMemo(
    () =>
      graph.nodes.map((n) => {
        const dim = (focus && !focus.has(n.id)) || (q && !n.id.toLowerCase().includes(q));
        return { ...n, selected: n.id === selected, className: dim ? "is-dim" : undefined };
      }),
    [graph.nodes, focus, q, selected],
  );
  const edges = useMemo(
    () =>
      graph.edges.map((e) => {
        const dim = focus ? !(e.source === selected || e.target === selected) : false;
        return { ...e, className: dim ? "is-dim" : undefined, zIndex: e.data?.cycle || e.data?.violation ? 1 : 0 };
      }),
    [graph.edges, focus, selected],
  );

  // Re-frame the drawing whenever the set of visible nodes changes.
  const signature = `${effectiveMode}|${folderDepth}|${scope}|${issueFilter}|${cycleFocus}|${[...hiddenLayers].join(",")}|${graph.nodes.length}`;
  useEffect(() => {
    const t = setTimeout(() => flow.fitView({ padding: 0.12, duration: 300, maxZoom: 1.2 }), 30);
    return () => clearTimeout(t);
  }, [signature, flow]);

  // Center on a file selected from elsewhere (search result, issue table, inspector link).
  useEffect(() => {
    if (!selected || effectiveMode !== "files") return;
    const n = graph.nodes.find((x) => x.id === selected);
    if (n) flow.setCenter(n.position.x + 98, n.position.y + 23, { zoom: Math.max(flow.getZoom(), 0.9), duration: 300 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const searchHits = q ? graph.nodes.filter((n) => n.id.toLowerCase().includes(q)) : [];

  return (
    <div className="graph">
      <EdgeMarkers />
      <div className="graph__toolbar" role="toolbar" aria-label="Graph view options">
        <div className="segmented" role="radiogroup" aria-label="Group by">
          <button role="radio" aria-checked={effectiveMode === "files"} onClick={() => { setChosenMode(true); setMode("files"); }}>
            Files
          </button>
          <button role="radio" aria-checked={effectiveMode === "folders"} onClick={() => { setChosenMode(true); setMode("folders"); onSelect(null); }}>
            Folders
          </button>
        </div>
        {effectiveMode === "folders" && (
          <label className="field">
            <span>Depth</span>
            <select value={folderDepth} onChange={(e) => setFolderDepth(Number(e.target.value))}>
              {[1, 2, 3, 4].map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="check">
          <input type="checkbox" checked={showTypeOnly} onChange={(e) => setShowTypeOnly(e.target.checked)} />
          Type-only imports
        </label>
        <div className="search">
          <input
            type="search"
            placeholder="Find a file"
            aria-label="Find a file"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && searchHits[0]) {
                if (effectiveMode === "files") onSelect(searchHits[0].id);
                else flow.setCenter(searchHits[0].position.x + 108, searchHits[0].position.y + 29, { zoom: 1, duration: 300 });
              }
            }}
          />
          {q && <span className="search__count">{searchHits.length} found</span>}
        </div>
      </div>

      {scope && (
        <div className="scope-bar">
          Showing <span className="mono">{scope}/</span>
          <button className="btn btn--small" onClick={() => { setScope(null); setMode("folders"); onSelect(null); }}>
            Back to all folders
          </button>
        </div>
      )}

      {graph.tooLarge && effectiveMode === "files" && (
        <div className="scope-bar scope-bar--warn">
          {graph.nodes.length} files is a lot to draw at once. The folder view, or an issue filter, is easier to read.
          <button className="btn btn--small" onClick={() => setMode("folders")}>
            Group by folder
          </button>
        </div>
      )}

      <div className="graph__canvas blueprint-grid">
        {graph.nodes.length === 0 ? (
          <div className="graph__empty">
            <p>No files match these filters.</p>
          </div>
        ) : (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodeClick={(_, n: Node) => {
              if (effectiveMode === "files") {
                onSelect(n.id === selected ? null : n.id);
              } else {
                setScope(n.id === "(root)" ? null : n.id);
                setMode("files");
                setChosenMode(true);
              }
            }}
            onPaneClick={() => onSelect(null)}
            nodesDraggable={false}
            nodesConnectable={false}
            edgesFocusable={false}
            onlyRenderVisibleElements
            minZoom={0.05}
            maxZoom={2}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={24} size={0} color="transparent" />
            <Controls showInteractive={false} position="bottom-left" />
            <MiniMap
              pannable
              zoomable
              position="bottom-right"
              nodeColor={(n) => {
                const d = n.data as FileNodeData | FolderNodeData;
                const critical = d.kind === "file" ? d.issues.includes("circular-dependency") : !!d.issueCounts["circular-dependency"];
                return critical ? "var(--critical)" : "var(--ink-2)";
              }}
              nodeBorderRadius={2}
              nodeStrokeWidth={0}
              maskColor="var(--minimap-mask)"
              ariaLabel="Overview of the whole graph"
            />
          </ReactFlow>
        )}
      </div>

      <GraphLegend mode={effectiveMode} />
    </div>
  );
}

function GraphLegend({ mode }: { mode: "files" | "folders" }) {
  return (
    <div className="graph-legend" aria-label="Legend">
      <span className="legend-item">
        <svg width="26" height="8" aria-hidden="true"><line x1="0" y1="4" x2="26" y2="4" className="legend-edge" /></svg>
        imports
      </span>
      <span className="legend-item">
        <svg width="26" height="8" aria-hidden="true"><line x1="0" y1="4" x2="26" y2="4" className="legend-edge legend-edge--cycle" /></svg>
        <span className="tone-critical" aria-hidden="true">⟲</span> part of a cycle
      </span>
      <span className="legend-item">
        <svg width="26" height="8" aria-hidden="true"><line x1="0" y1="4" x2="26" y2="4" className="legend-edge legend-edge--violation" /></svg>
        <span className="tone-serious" aria-hidden="true">⚠</span> breaks a layer rule
      </span>
      <span className="legend-hint">
        {mode === "folders" ? "Click a folder to open it." : "Click a file to inspect it."} Arrows point from a file to what it imports.
      </span>
    </div>
  );
}

const IssueBadges = ({ types }: { types: ViolationType[] }) =>
  types.length ? (
    <span className="badges">
      {types.map((t) => (
        <span key={t} className={`issue-icon tone-${ISSUE_LABEL[t].tone}`} title={ISSUE_LABEL[t].one} aria-label={ISSUE_LABEL[t].one} role="img">
          {ISSUE_LABEL[t].icon}
        </span>
      ))}
    </span>
  ) : null;

const FileNode = memo(function FileNode({ data, selected }: NodeProps<Node<FileNodeData>>) {
  const critical = data.issues.includes("circular-dependency");
  return (
    <div className={`gnode${selected ? " gnode--selected" : ""}${critical ? " gnode--critical" : ""}`} style={{ "--layer": data.color } as React.CSSProperties}>
      <Handle type="target" position={Position.Left} className="ghandle" />
      <span className="gnode__stripe" aria-hidden="true" />
      <span className="gnode__body">
        <span className="gnode__name mono">{data.label}</span>
        <span className="gnode__meta">
          <span className="gnode__layer">{data.layer ?? "no layer"}</span>
          <span className="gnode__dir mono">{data.dir}</span>
        </span>
      </span>
      <IssueBadges types={data.issues} />
      <Handle type="source" position={Position.Right} className="ghandle" />
    </div>
  );
});

const FolderNode = memo(function FolderNode({ data }: NodeProps<Node<FolderNodeData>>) {
  const types = (Object.keys(data.issueCounts) as ViolationType[]).filter((t) => (data.issueCounts[t] ?? 0) > 0);
  return (
    <div className={`gnode gnode--folder${data.issueCounts["circular-dependency"] ? " gnode--critical" : ""}`} style={{ "--layer": data.color } as React.CSSProperties}>
      <Handle type="target" position={Position.Left} className="ghandle" />
      <span className="gnode__stripe" aria-hidden="true" />
      <span className="gnode__body">
        <span className="gnode__name mono">{data.label}/</span>
        <span className="gnode__meta">
          <span className="gnode__layer">{data.files} {data.files === 1 ? "file" : "files"}</span>
          {types.map((t) => (
            <span key={t} className={`folder-issue tone-${ISSUE_LABEL[t].tone}`} title={`${data.issueCounts[t]} ${ISSUE_LABEL[t].many.toLowerCase()}`}>
              {ISSUE_LABEL[t].icon} {data.issueCounts[t]}
            </span>
          ))}
        </span>
      </span>
      <Handle type="source" position={Position.Right} className="ghandle" />
    </div>
  );
});

function DepEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps & { data?: EdgeData }) {
  const [path] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const kind = data?.cycle ? "cycle" : data?.violation ? "violation" : "plain";
  const width = data && data.weight > 1 ? Math.min(1.25 + Math.log2(data.weight) * 0.6, 4.5) : undefined;
  return (
    <BaseEdge
      id={id}
      path={path}
      className={`gedge gedge--${kind}${data?.typeOnly ? " gedge--type" : ""}`}
      markerEnd={`url(#arrow-${kind})`}
      style={width ? { strokeWidth: width } : undefined}
    />
  );
}

const nodeTypes = { file: FileNode, folder: FolderNode };
const edgeTypes = { dep: DepEdge };

/** Arrowheads in the three edge colours; rendered once and referenced by id. */
export function EdgeMarkers() {
  return (
    <svg className="visually-hidden" aria-hidden="true">
      <defs>
        {["plain", "cycle", "violation"].map((k) => (
          <marker key={k} id={`arrow-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,1 L9,5 L0,9 Z" className={`arrowhead arrowhead--${k}`} />
          </marker>
        ))}
      </defs>
    </svg>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isHistory, isReport, layerColors, projectName, type History, type Report } from "@/lib/model";
import type { IssueFilter } from "@/lib/layout";
import { EmptyState } from "./EmptyState";
import { GraphView } from "./GraphView";
import { HistoryView } from "./HistoryView";
import { Inspector } from "./Inspector";
import { IssuesTable } from "./IssuesTable";
import { Sidebar } from "./Sidebar";
import { ThemeToggle } from "./ThemeToggle";

type Tab = "graph" | "issues" | "history";

export function Dashboard() {
  const [report, setReport] = useState<Report | null>(null);
  const [history, setHistory] = useState<History | null>(null);
  const [tab, setTab] = useState<Tab>("graph");
  const [selected, setSelected] = useState<string | null>(null);
  const [issueFilter, setIssueFilter] = useState<IssueFilter>("all");
  const [cycleFocus, setCycleFocus] = useState<number | null>(null);
  const [hiddenLayers, setHiddenLayers] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const accept = useCallback((data: unknown, source: string) => {
    if (isReport(data)) {
      setReport(data);
      setSelected(null);
      setIssueFilter("all");
      setCycleFocus(null);
      setHiddenLayers(new Set());
      setTab((t) => (t === "history" ? "graph" : t));
      setError(null);
      return true;
    }
    if (isHistory(data)) {
      setHistory(data);
      setTab("history");
      setError(null);
      return true;
    }
    setError(`${source} isn't an ArchGuard report or history file. Create one with "archguard analyze" or "archguard history".`);
    return false;
  }, []);

  // On start-up, load data/report.json and data/history.json when `archguard dashboard`
  // serves them, or the files named in ?report= and ?history=.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sources = [params.get("report") ?? "data/report.json", params.get("history") ?? "data/history.json"];
    if (params.get("demo") !== null) sources.splice(0, 2, "demo/report.json", "demo/history.json");
    Promise.all(
      sources.map((url) =>
        fetch(url)
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
      ),
    ).then(([r, h]) => {
      if (isReport(r)) setReport(r);
      if (isHistory(h)) {
        setHistory(h);
        if (!isReport(r)) setTab("history");
      }
      setLoading(false);
    });
  }, []);

  const openFiles = useCallback(
    async (files: FileList | File[]) => {
      for (const file of Array.from(files)) {
        try {
          accept(JSON.parse(await file.text()), file.name);
        } catch {
          setError(`${file.name} isn't valid JSON.`);
        }
      }
    },
    [accept],
  );

  const loadDemo = useCallback(async () => {
    try {
      const [r, h] = await Promise.all(["demo/report.json", "demo/history.json"].map((u) => fetch(u).then((x) => x.json())));
      accept(r, "The demo report");
      accept(h, "The demo history");
      setTab("graph");
    } catch {
      setError("Couldn't load the demo data. Open a report file instead.");
    }
  }, [accept]);

  const colors = useMemo(() => (report ? layerColors(report) : new Map()), [report]);

  // Opening a file from the issues table or an inspector link must show it in the graph,
  // so lift any filter that would hide it.
  const selectFile = useCallback(
    (id: string | null) => {
      setSelected(id);
      if (!id) return;
      setTab("graph");
      const node = report?.nodes.find((n) => n.id === id);
      if (node && hiddenLayers.has(node.layer ?? "(none)")) setHiddenLayers(new Set());
      setIssueFilter((f) => (f === "all" ? f : "all"));
      setCycleFocus(null);
    },
    [report, hiddenLayers],
  );

  const dropHandlers = {
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(true);
    },
    onDragLeave: (e: React.DragEvent) => {
      if (e.currentTarget === e.target) setDragging(false);
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      if (e.dataTransfer.files.length) openFiles(e.dataTransfer.files);
    },
  };

  const hiddenInput = (
    <input
      ref={fileInput}
      type="file"
      accept=".json,application/json"
      multiple
      className="visually-hidden"
      onChange={(e) => {
        if (e.target.files) openFiles(e.target.files);
        e.target.value = "";
      }}
    />
  );

  if (loading) {
    return <div className="app app--loading blueprint-grid" aria-busy="true" />;
  }

  if (!report && !history) {
    return (
      <div className="app" {...dropHandlers}>
        {hiddenInput}
        <EmptyState onChoose={() => fileInput.current?.click()} onDemo={loadDemo} error={error} dragging={dragging} />
      </div>
    );
  }

  const tabs: { id: Tab; label: string; disabled?: boolean }[] = [
    { id: "graph", label: "Graph", disabled: !report },
    { id: "issues", label: "Issues", disabled: !report },
    { id: "history", label: "History", disabled: !history },
  ];

  return (
    <div className={`app${dragging ? " app--dragging" : ""}`} {...dropHandlers}>
      {hiddenInput}
      <header className="topbar">
        <div className="brand">
          <Logo />
          <span>ArchGuard</span>
        </div>
        <nav className="tabs" aria-label="Views">
          {tabs.map((t) => (
            <button
              key={t.id}
              className="tab"
              aria-current={tab === t.id ? "page" : undefined}
              disabled={t.disabled}
              title={t.disabled ? (t.id === "history" ? "Open a history file to see drift over time" : "Open a report first") : undefined}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <div className="topbar__actions">
          <button className="btn" onClick={() => fileInput.current?.click()}>
            Open file
          </button>
          <ThemeToggle />
        </div>
      </header>

      {error && (
        <div className="banner" role="alert">
          {error}
          <button className="btn btn--ghost" onClick={() => setError(null)} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}

      <div className={`workspace workspace--${tab}${selected && tab === "graph" ? " workspace--inspecting" : ""}`}>
        {report && tab !== "history" && (
          <Sidebar
            report={report}
            colors={colors}
            issueFilter={issueFilter}
            onIssueFilter={(f) => {
              setIssueFilter(f);
              setCycleFocus(null);
            }}
            cycleFocus={cycleFocus}
            onCycleFocus={setCycleFocus}
            hiddenLayers={hiddenLayers}
            onToggleLayer={(name) =>
              setHiddenLayers((prev) => {
                const next = new Set(prev);
                if (next.has(name)) next.delete(name);
                else next.add(name);
                return next;
              })
            }
          />
        )}

        <main className="stage" aria-label={tab === "graph" ? "Dependency graph" : tab === "issues" ? "Issues" : "History"}>
          {tab === "graph" && report && (
            <GraphView
              report={report}
              colors={colors}
              issueFilter={issueFilter}
              cycleFocus={cycleFocus}
              hiddenLayers={hiddenLayers}
              selected={selected}
              onSelect={selectFile}
            />
          )}
          {tab === "issues" && report && <IssuesTable report={report} onSelectFile={selectFile} />}
          {tab === "history" && history && <HistoryView history={history} />}
        </main>

        {tab === "graph" && report && selected && (
          <Inspector report={report} colors={colors} fileId={selected} onSelect={selectFile} onClose={() => setSelected(null)} />
        )}
      </div>

      <footer className="statusbar">
        {report ? (
          <span>
            {projectName(report)}: {report.summary.files} files, {report.summary.edges} imports, analysed{" "}
            {new Date(report.meta.generatedAt).toLocaleString()}
          </span>
        ) : (
          <span>History only. Open a report to explore the graph.</span>
        )}
        {history && tab !== "history" && (
          <button className="linkish" onClick={() => setTab("history")}>
            {history.points.length} commits of history loaded
          </button>
        )}
      </footer>
    </div>
  );
}

function Logo() {
  // A shield drawn as a drafting mark: an outline with a node graph inside.
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2.5 4 5.5v6c0 5 3.4 8.6 8 10 4.6-1.4 8-5 8-10v-6l-8-3Z" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="9" cy="10" r="1.6" fill="currentColor" />
      <circle cx="15" cy="10" r="1.6" fill="currentColor" />
      <circle cx="12" cy="15" r="1.6" fill="currentColor" />
      <path d="M9 10 12 15 15 10" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

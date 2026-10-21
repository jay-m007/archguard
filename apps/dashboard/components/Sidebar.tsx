import { ISSUE_LABEL, ISSUE_TYPES, projectName, type Report } from "@/lib/model";
import type { IssueFilter } from "@/lib/layout";

/**
 * The left rail. Its top is drawn as the title block of an architectural
 * drawing (the boxed corner of a blueprint that names the project, scale and
 * date), carrying the health score, so the whole dashboard reads as a drawing of the codebase.
 */
export function Sidebar(props: {
  report: Report;
  colors: Map<string | null, string>;
  issueFilter: IssueFilter;
  onIssueFilter: (f: IssueFilter) => void;
  cycleFocus: number | null;
  onCycleFocus: (i: number | null) => void;
  hiddenLayers: Set<string>;
  onToggleLayer: (name: string) => void;
}) {
  const { report, colors } = props;
  const { score, summary } = report;
  const unlayered = report.nodes.filter((n) => n.layer === null).length;
  const layers = [...report.layers.filter((l) => l.files > 0), ...(unlayered ? [{ name: "(none)", files: unlayered }] : [])];
  const date = new Date(report.meta.generatedAt);

  return (
    <aside className="sidebar" aria-label="Project summary and filters">
      <section className="titleblock" aria-label="Project health">
        <div className="titleblock__cell titleblock__project">
          <span className="tb-label">Project</span>
          <span className="tb-value tb-value--project" title={report.meta.root}>
            {projectName(report)}
          </span>
        </div>
        <div className="titleblock__cell titleblock__health">
          <span className="tb-label">Health</span>
          <span className="tb-hero">
            {score.health}
            <span className="tb-hero__of">/100</span>
          </span>
        </div>
        <div className="titleblock__cell titleblock__grade" data-grade={score.grade}>
          <span className="tb-label">Grade</span>
          <span className="tb-grade">{score.grade}</span>
        </div>
        <div className="titleblock__cell">
          <span className="tb-label">Files</span>
          <span className="tb-value">{summary.files.toLocaleString()}</span>
        </div>
        <div className="titleblock__cell">
          <span className="tb-label">Imports</span>
          <span className="tb-value">{summary.edges.toLocaleString()}</span>
        </div>
        <div className="titleblock__cell">
          <span className="tb-label">Drift</span>
          <span className="tb-value" title="Weighted issue points before normalising by file count">
            {score.driftPoints}
          </span>
        </div>
        <div className="titleblock__cell titleblock__wide">
          <span className="tb-label">Drawn</span>
          <span className="tb-value tb-value--small">
            {date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}, ArchGuard v{report.meta.version}
          </span>
        </div>
      </section>

      <section className="rail-section" aria-labelledby="issues-heading">
        <h2 id="issues-heading" className="rail-heading">
          Issues
        </h2>
        <div className="filter-list" role="radiogroup" aria-label="Show on the graph">
          <FilterRow label="All files" count={summary.files} active={props.issueFilter === "all"} onClick={() => props.onIssueFilter("all")} />
          <FilterRow
            label="Files with any issue"
            count={new Set(report.violations.flatMap((v) => (v.type === "circular-dependency" ? [] : [v.file]))).size + report.cycles.reduce((a, c) => a + c.files.length, 0)}
            active={props.issueFilter === "issues"}
            onClick={() => props.onIssueFilter("issues")}
          />
          {ISSUE_TYPES.map((t) => (
            <div key={t}>
              <FilterRow
                label={ISSUE_LABEL[t].many}
                count={summary.violations[t]}
                icon={ISSUE_LABEL[t].icon}
                tone={ISSUE_LABEL[t].tone}
                active={props.issueFilter === t}
                onClick={() => props.onIssueFilter(t)}
                disabled={summary.violations[t] === 0}
              />
              {t === "circular-dependency" && props.issueFilter === t && report.cycles.length > 1 && (
                <ul className="cycle-list" role="radiogroup" aria-label="Choose a cycle">
                  <li>
                    <button role="radio" aria-checked={props.cycleFocus === null} className="cycle-row" onClick={() => props.onCycleFocus(null)}>
                      All cycles together
                    </button>
                  </li>
                  {report.cycles.map((c, i) => (
                    <li key={c.files.join("|")}>
                      <button role="radio" aria-checked={props.cycleFocus === i} className="cycle-row" onClick={() => props.onCycleFocus(i)} title={c.path.join(" → ")}>
                        <span className="mono">{c.path[0].split("/").pop()}</span>
                        <span className="count">{c.files.length} files</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="rail-section" aria-labelledby="layers-heading">
        <h2 id="layers-heading" className="rail-heading">
          Layers
        </h2>
        <ul className="layer-list">
          {layers.map((l) => {
            const hidden = props.hiddenLayers.has(l.name);
            return (
              <li key={l.name}>
                <label className={`layer-row${hidden ? " layer-row--hidden" : ""}`}>
                  <input type="checkbox" checked={!hidden} onChange={() => props.onToggleLayer(l.name)} />
                  <span className="layer-swatch" style={{ background: colors.get(l.name === "(none)" ? null : l.name) }} aria-hidden="true" />
                  <span className="layer-name">{l.name === "(none)" ? "No layer" : l.name}</span>
                  <span className="count">{l.files}</span>
                </label>
              </li>
            );
          })}
        </ul>
      </section>
    </aside>
  );
}

function FilterRow(props: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  icon?: string;
  tone?: string;
  disabled?: boolean;
}) {
  return (
    <button
      role="radio"
      aria-checked={props.active}
      className={`filter-row${props.active ? " filter-row--active" : ""}`}
      onClick={props.onClick}
      disabled={props.disabled}
    >
      <span className={`issue-icon${props.tone ? ` tone-${props.tone}` : ""}`} aria-hidden="true">
        {props.icon ?? ""}
      </span>
      <span className="filter-row__label">{props.label}</span>
      <span className="count">{props.count.toLocaleString()}</span>
    </button>
  );
}

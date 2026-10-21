import { useMemo } from "react";
import { basename, dirname, indexIssues, ISSUE_LABEL, type Report } from "@/lib/model";

/** Right-hand panel describing one file: its layer, coupling metrics, issues and neighbours. */
export function Inspector(props: {
  report: Report;
  colors: Map<string | null, string>;
  fileId: string;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const { report, fileId } = props;
  const node = report.nodes.find((n) => n.id === fileId);
  const idx = useMemo(() => indexIssues(report), [report]);

  const { imports, importedBy } = useMemo(() => {
    const imp = new Map<string, { typeOnly: boolean; line: number }>();
    const by = new Map<string, { typeOnly: boolean; line: number }>();
    for (const e of report.edges) {
      if (e.from === fileId && !imp.has(e.to)) imp.set(e.to, { typeOnly: e.typeOnly, line: e.line });
      if (e.to === fileId && !by.has(e.from)) by.set(e.from, { typeOnly: e.typeOnly, line: e.line });
    }
    return { imports: [...imp.entries()].sort(), importedBy: [...by.entries()].sort() };
  }, [report, fileId]);

  if (!node) return null;
  const issues = idx.byFile.get(fileId) ?? [];
  const cycleIndex = idx.cycleOf.get(fileId);
  const cycle = cycleIndex !== undefined ? report.cycles[cycleIndex] : null;

  return (
    <aside className="inspector" aria-label={`Details for ${fileId}`}>
      <header className="inspector__head">
        <div>
          <h2 className="inspector__title mono">{basename(fileId)}</h2>
          <p className="inspector__path mono">{dirname(fileId) || "(project root)"}</p>
        </div>
        <button className="btn btn--icon" onClick={props.onClose} aria-label="Close details">
          ✕
        </button>
      </header>

      <div className="inspector__layer">
        <span className="layer-swatch" style={{ background: props.colors.get(node.layer) }} aria-hidden="true" />
        {node.layer ? (
          <span>
            In the <strong>{node.layer}</strong> layer
          </span>
        ) : (
          <span>Not in any layer</span>
        )}
        {node.entry && <span className="pill">entry point</span>}
      </div>

      <dl className="metrics">
        <div>
          <dt>Imported by</dt>
          <dd>{node.fanIn}</dd>
        </div>
        <div>
          <dt>Imports</dt>
          <dd>{node.fanOut}</dd>
        </div>
        <div>
          <dt title="Fan-out / (fan-in + fan-out). 0 = stable foundation, 1 = depends on others but nothing depends on it.">Instability</dt>
          <dd>{node.instability.toFixed(2)}</dd>
        </div>
        <div>
          <dt>Lines</dt>
          <dd>{node.loc.toLocaleString()}</dd>
        </div>
      </dl>

      {issues.length > 0 && (
        <section className="inspector__section">
          <h3>Issues</h3>
          <ul className="issue-list">
            {issues.map((v) => (
              <li key={v.key} className={`issue tone-border-${ISSUE_LABEL[v.type].tone}`}>
                <span className="issue__type">
                  <span className={`issue-icon tone-${ISSUE_LABEL[v.type].tone}`} aria-hidden="true">
                    {ISSUE_LABEL[v.type].icon}
                  </span>
                  {ISSUE_LABEL[v.type].one}
                </span>
                {v.type === "layer-violation" ? (
                  <span>
                    <span className="mono">{v.rule}</span>: line {v.line} imports{" "}
                    <button className="linkish mono" onClick={() => props.onSelect(v.target!)}>
                      {v.target}
                    </button>
                  </span>
                ) : v.type === "circular-dependency" && cycle ? (
                  <span>
                    {cycle.files.length} files import each other. Shortest loop:
                    <ol className="loop">
                      {cycle.path.slice(0, -1).map((f, i) => (
                        <li key={`${f}-${i}`}>
                          <button className={`linkish mono${f === fileId ? " is-current" : ""}`} onClick={() => props.onSelect(f)}>
                            {f}
                          </button>
                        </li>
                      ))}
                    </ol>
                    <span className="loop__back">then back to the first file</span>
                  </span>
                ) : (
                  <span>{v.message.replace(fileId, "This file").replace(/^This file /, "This file ")}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <NeighbourList title="Imports" items={imports} onSelect={props.onSelect} empty="Doesn't import any project files." />
      <NeighbourList title="Imported by" items={importedBy} onSelect={props.onSelect} empty="No project file imports this one." />
    </aside>
  );
}

function NeighbourList(props: {
  title: string;
  items: [string, { typeOnly: boolean; line: number }][];
  onSelect: (id: string) => void;
  empty: string;
}) {
  return (
    <section className="inspector__section">
      <h3>
        {props.title} <span className="count">{props.items.length}</span>
      </h3>
      {props.items.length === 0 ? (
        <p className="muted">{props.empty}</p>
      ) : (
        <ul className="neighbours">
          {props.items.map(([id, info]) => (
            <li key={id}>
              <button className="linkish mono" onClick={() => props.onSelect(id)} title={id}>
                {id}
              </button>
              {info.typeOnly && <span className="pill pill--quiet">type</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

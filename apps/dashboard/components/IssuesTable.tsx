import { useMemo, useState } from "react";
import { ISSUE_LABEL, ISSUE_TYPES, type Report, type ViolationType } from "@/lib/model";

const RANK = { error: 0, warning: 1, info: 2 } as const;
const SEVERITY_LABEL = { error: "Error", warning: "Warning", info: "Info" } as const;

/** Every issue as a sortable, filterable table: the accessible alternative to the graph. */
export function IssuesTable({ report, onSelectFile }: { report: Report; onSelectFile: (id: string) => void }) {
  const [types, setTypes] = useState<Set<ViolationType>>(new Set(ISSUE_TYPES.filter((t) => t !== "orphan-file")));
  const [query, setQuery] = useState("");

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return report.violations
      .filter((v) => types.has(v.type))
      .filter((v) => !q || v.message.toLowerCase().includes(q))
      .sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.file.localeCompare(b.file));
  }, [report, types, query]);

  const toggle = (t: ViolationType) =>
    setTypes((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });

  return (
    <div className="issues">
      <div className="issues__toolbar">
        <div className="chips" role="group" aria-label="Issue types">
          {ISSUE_TYPES.map((t) => (
            <button key={t} className="chip" aria-pressed={types.has(t)} onClick={() => toggle(t)} disabled={report.summary.violations[t] === 0}>
              <span className={`issue-icon tone-${ISSUE_LABEL[t].tone}`} aria-hidden="true">
                {ISSUE_LABEL[t].icon}
              </span>
              {ISSUE_LABEL[t].many}
              <span className="count">{report.summary.violations[t]}</span>
            </button>
          ))}
        </div>
        <input type="search" className="issues__search" placeholder="Filter by file or message" aria-label="Filter issues" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>

      {rows.length === 0 ? (
        <p className="issues__empty">
          {report.violations.length === 0 ? "No architecture issues found. This codebase is in good shape." : "No issues match these filters."}
        </p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <caption className="visually-hidden">{rows.length} issues</caption>
            <thead>
              <tr>
                <th scope="col">Severity</th>
                <th scope="col">Issue</th>
                <th scope="col">File</th>
                <th scope="col">Details</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 500).map((v) => (
                <tr key={v.key}>
                  <td>
                    <span className={`sev sev--${v.severity}`}>{SEVERITY_LABEL[v.severity]}</span>
                  </td>
                  <td className="nowrap">
                    <span className={`issue-icon tone-${ISSUE_LABEL[v.type].tone}`} aria-hidden="true">
                      {ISSUE_LABEL[v.type].icon}
                    </span>{" "}
                    {ISSUE_LABEL[v.type].one}
                  </td>
                  <td>
                    <button className="linkish mono" onClick={() => onSelectFile(v.file)}>
                      {v.file}
                      {v.line ? `:${v.line}` : ""}
                    </button>
                  </td>
                  <td className="details">{detail(v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > 500 && <p className="muted table-note">Showing the first 500 of {rows.length}. Narrow the filter to see the rest.</p>}
        </div>
      )}
    </div>
  );
}

function detail(v: Report["violations"][number]): string {
  if (v.type === "circular-dependency") return v.message.split(": ").slice(1).join(": ").replace(/ -> /g, " → ");
  if (v.type === "layer-violation") return `${v.rule}: imports ${v.target}`;
  return v.message.replace(`${v.file} `, "").replace(/^./, (c) => c.toUpperCase());
}

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { History, HistoryPoint } from "@/lib/model";

/**
 * Drift over time.
 * One hero chart (health, 0-100, single series so no legend) and three small
 * multiples for the issue counts (one measure per chart, so no dual axes). All
 * charts share the x-axis and a synchronised crosshair; the table view below
 * carries every value for readers who don't use the hover layer.
 */
export function HistoryView({ history }: { history: History }) {
  const points = useMemo(() => history.points.filter((p) => p.analyzed), [history]);
  const [hover, setHover] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);
  const { trend, meta } = history;

  if (points.length === 0) {
    return <p className="issues__empty">None of the analysed commits contained source files in {meta.subpath}.</p>;
  }

  const last = points[points.length - 1];
  const first = points[0];
  const delta = trend.delta ?? 0;
  const span = `${fmtDate(first.date)} to ${fmtDate(last.date)}`;

  return (
    <div className="history">
      <header className="history__head">
        <div>
          <h1 className="history__title">How the architecture changed</h1>
          <p className="history__sub">
            {points.length} commits of <span className="mono">{meta.repo.split(/[\\/]/).pop()}{meta.subpath !== "." ? `/${meta.subpath}` : ""}</span>, {span}.
            Every commit is scored with today&apos;s rules, so the numbers are comparable.
          </p>
        </div>
        <div className="history__delta" data-direction={delta > 0 ? "up" : delta < 0 ? "down" : "flat"}>
          <span className="history__delta-value">
            {first.health} → {last.health}
          </span>
          <span className="history__delta-label">
            {delta > 0 ? `▲ ${delta} points better` : delta < 0 ? `▼ ${-delta} points worse` : "No overall change"}
          </span>
        </div>
      </header>

      <section className="chart-card" aria-labelledby="health-chart-title">
        <h2 id="health-chart-title" className="chart-title">
          Health score per commit
        </h2>
        <LineChart points={points} value={(p) => p.health} domain={[0, 100]} height={260} hover={hover} onHover={setHover} hero format={(v) => `${v}`} />
      </section>

      <div className="multiples">
        {(
          [
            ["Circular dependencies", "⟲", "tone-critical", (p: HistoryPoint) => p.cycles],
            ["Layer violations", "⚠", "tone-serious", (p: HistoryPoint) => p.layerViolations],
            ["God files", "◆", "tone-warning", (p: HistoryPoint) => p.godFiles],
          ] as const
        ).map(([title, icon, tone, value]) => (
          <section key={title} className="chart-card chart-card--small" aria-label={title}>
            <h2 className="chart-title">
              <span className={`issue-icon ${tone}`} aria-hidden="true">
                {icon}
              </span>{" "}
              {title}
            </h2>
            <LineChart points={points} value={value} height={120} hover={hover} onHover={setHover} format={(v) => `${v}`} />
          </section>
        ))}
      </div>

      <div className="history__moves">
        <MoveList title="Biggest drops" moves={trend.regressions} tone="down" empty="No commit made the score worse." />
        <MoveList title="Biggest improvements" moves={trend.improvements} tone="up" empty="No commit improved the score." />
      </div>

      <div className="history__table">
        <button className="btn" aria-expanded={showTable} onClick={() => setShowTable((s) => !s)}>
          {showTable ? "Hide the data table" : "Show the data table"}
        </button>
        {showTable && (
          <div className="table-wrap">
            <table className="table">
              <caption className="visually-hidden">Health and issue counts for each analysed commit</caption>
              <thead>
                <tr>
                  <th scope="col">Commit</th>
                  <th scope="col">Date</th>
                  <th scope="col" className="num">Health</th>
                  <th scope="col" className="num">Cycles</th>
                  <th scope="col" className="num">Layer</th>
                  <th scope="col" className="num">God files</th>
                  <th scope="col" className="num">Files</th>
                  <th scope="col">Message</th>
                </tr>
              </thead>
              <tbody>
                {[...points].reverse().map((p) => (
                  <tr key={p.sha}>
                    <td className="mono">{p.shortSha}</td>
                    <td className="nowrap">{fmtDate(p.date)}</td>
                    <td className="num">{p.health}</td>
                    <td className="num">{p.cycles}</td>
                    <td className="num">{p.layerViolations}</td>
                    <td className="num">{p.godFiles}</td>
                    <td className="num">{p.files}</td>
                    <td className="details">{p.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function MoveList(props: { title: string; moves: History["trend"]["regressions"]; tone: "up" | "down"; empty: string }) {
  return (
    <section className="moves">
      <h2 className="chart-title">{props.title}</h2>
      {props.moves.length === 0 ? (
        <p className="muted">{props.empty}</p>
      ) : (
        <ol className="moves__list">
          {props.moves.map((m) => (
            <li key={`${m.from}-${m.to}`}>
              <span className={`moves__delta moves__delta--${props.tone}`}>{m.delta > 0 ? `+${m.delta}` : m.delta}</span>
              <span className="mono moves__sha">{m.to}</span>
              <span className="moves__msg">{m.message}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function LineChart(props: {
  points: HistoryPoint[];
  value: (p: HistoryPoint) => number;
  domain?: [number, number];
  height: number;
  hover: number | null;
  onHover: (i: number | null) => void;
  format: (v: number) => string;
  hero?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useWidth(ref);
  const { points, value, height, hover } = props;
  const values = points.map(value);
  const max = props.domain ? props.domain[1] : niceMax(Math.max(1, ...values));
  const min = props.domain ? props.domain[0] : 0;

  const pad = { top: 12, right: 16, bottom: props.hero ? 28 : 22, left: 36 };
  const w = Math.max(width - pad.left - pad.right, 10);
  const h = height - pad.top - pad.bottom;
  const x = (i: number) => pad.left + (points.length === 1 ? w / 2 : (i / (points.length - 1)) * w);
  const y = (v: number) => pad.top + h - ((v - min) / (max - min || 1)) * h;

  const line = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const area = `${line}L${x(values.length - 1).toFixed(1)},${y(min)}L${x(0).toFixed(1)},${y(min)}Z`;
  const ticks = props.domain ? [0, 25, 50, 75, 100] : [...new Set([0, max / 2, max].map((t) => Math.round(t)))];
  const xTicks = yearTicks(points, width < 480 ? 4 : 10);

  const indexAt = (clientX: number) => {
    const rect = ref.current!.getBoundingClientRect();
    const rel = (clientX - rect.left - pad.left) / w;
    return Math.max(0, Math.min(points.length - 1, Math.round(rel * (points.length - 1))));
  };

  const hp = hover !== null ? points[hover] : null;
  const lastI = values.length - 1;

  return (
    <div
      ref={ref}
      className="linechart"
      style={{ height }}
      tabIndex={0}
      role="img"
      aria-label={`${props.hero ? "Health" : "Value"} from ${values[0]} to ${values[lastI]} across ${points.length} commits. Use the left and right arrow keys to read each commit.`}
      onPointerMove={(e) => props.onHover(indexAt(e.clientX))}
      onPointerLeave={() => props.onHover(null)}
      onFocus={() => props.onHover(hover ?? lastI)}
      onBlur={() => props.onHover(null)}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") props.onHover(Math.min(lastI, (hover ?? -1) + 1));
        if (e.key === "ArrowLeft") props.onHover(Math.max(0, (hover ?? lastI + 1) - 1));
      }}
    >
      {width > 0 && (
        <svg width={width} height={height} aria-hidden="true">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.left} x2={pad.left + w} y1={y(t)} y2={y(t)} className="chart-grid" />
              <text x={pad.left - 8} y={y(t)} className="chart-tick" textAnchor="end" dominantBaseline="middle">
                {props.format(t)}
              </text>
            </g>
          ))}
          {xTicks.map(({ i, label }) => (
            <text key={i} x={x(i)} y={height - 6} className="chart-tick" textAnchor="middle">
              {label}
            </text>
          ))}
          <path d={area} className="chart-area" />
          <path d={line} className="chart-line" />
          {/* Direct label on the end point only */}
          <circle cx={x(lastI)} cy={y(values[lastI])} r={4} className="chart-dot" />
          {props.hero && (
            <text x={x(lastI) - 8} y={y(values[lastI]) - 10} className="chart-endlabel" textAnchor="end">
              {values[lastI]}
            </text>
          )}
          {hp && hover !== null && (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={pad.top} y2={pad.top + h} className="chart-crosshair" />
              <circle cx={x(hover)} cy={y(values[hover])} r={4.5} className="chart-dot chart-dot--hover" />
            </g>
          )}
        </svg>
      )}
      {hp && hover !== null && props.hero && (
        <div className="chart-tooltip" style={{ left: Math.min(Math.max(x(hover) - 120, 0), Math.max(width - 248, 0)) }} role="status">
          <div className="chart-tooltip__value">
            {hp.health}
            <span>/100, grade {hp.grade}</span>
          </div>
          <div className="chart-tooltip__msg">{hp.message}</div>
          <div className="chart-tooltip__meta">
            <span className="mono">{hp.shortSha}</span> {fmtDate(hp.date)}
          </div>
          <div className="chart-tooltip__rows">
            <span>{hp.cycles} cycles</span>
            <span>{hp.layerViolations} layer violations</span>
            <span>{hp.godFiles} god files</span>
            <span>{hp.files} files</span>
          </div>
        </div>
      )}
      {hp && hover !== null && !props.hero && (
        <div className="chart-tooltip chart-tooltip--mini" style={{ left: Math.min(Math.max(x(hover) - 30, 0), Math.max(width - 70, 0)) }}>
          {values[hover]}
        </div>
      )}
    </div>
  );
}

function useWidth(ref: React.RefObject<HTMLDivElement | null>) {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

function niceMax(v: number): number {
  const steps = [1, 2, 4, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000];
  return steps.find((s) => s >= v) ?? Math.ceil(v / 1000) * 1000;
}

/** Label the first commit of each year (or each month for short histories). */
function yearTicks(points: HistoryPoint[], maxTicks = 10) {
  const ticks: { i: number; label: string }[] = [];
  const years = new Set(points.map((p) => p.date.slice(0, 4)));
  const byMonth = years.size <= 1;
  let prev = "";
  points.forEach((p, i) => {
    const key = byMonth ? p.date.slice(0, 7) : p.date.slice(0, 4);
    if (key !== prev) {
      ticks.push({ i, label: byMonth ? new Date(p.date).toLocaleDateString(undefined, { month: "short" }) : key });
      prev = key;
    }
  });
  // Thin out crowded ticks.
  return ticks.length > maxTicks ? ticks.filter((_, k) => k % Math.ceil(ticks.length / maxTicks) === 0) : ticks;
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

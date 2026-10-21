export function EmptyState(props: { onChoose: () => void; onDemo: () => void; error: string | null; dragging: boolean }) {
  return (
    <div className={`empty blueprint-grid${props.dragging ? " empty--dragging" : ""}`}>
      <div className="empty__sheet">
        <h1 className="empty__title">Open an ArchGuard report</h1>
        <p className="empty__lede">
          See your project as a dependency graph, with circular imports, layer violations and oversized files marked
          on it. Add a history file to see how the architecture changed over time.
        </p>
        <ol className="empty__steps">
          <li>
            In your project, run <code className="mono">archguard analyze</code> (and optionally{" "}
            <code className="mono">archguard history</code>).
          </li>
          <li>
            Drop <code className="mono">archguard-report.json</code> or <code className="mono">archguard-history.json</code>{" "}
            anywhere on this page.
          </li>
        </ol>
        <div className="empty__actions">
          <button className="btn btn--primary" onClick={props.onChoose}>
            Choose files
          </button>
          <button className="btn" onClick={props.onDemo}>
            Explore the excalidraw demo
          </button>
        </div>
        {props.error && (
          <p className="empty__error" role="alert">
            {props.error}
          </p>
        )}
        <p className="empty__note">Files stay in your browser. Nothing is uploaded.</p>
      </div>
    </div>
  );
}

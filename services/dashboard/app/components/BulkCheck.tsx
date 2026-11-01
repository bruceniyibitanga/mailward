"use client";
// The Bulk check page: choose a CSV, preview it, run it, and read or download the results.
import { useMemo, useRef, useState } from "react";
import { MAX_BYTES, MAX_ROWS, MESSAGES, buildEntries, readUpload, toCsv } from "@/lib/csv.mjs";
import { type BulkInputEntry, type BulkRow, useBulk } from "./BulkProvider";
import { RecommendationBadge, VerdictBadge } from "./ui";

interface Counts { total: number; unique: number; invalid: number; duplicates: number }
interface Parsed {
  ok: true; rows: string[][]; hasHeader: boolean; column: number; columnNeedsChoosing: boolean;
  labels: string[]; entries: BulkInputEntry[]; counts: Counts;
}
interface Failed { ok: false; error: string; rowCount?: number }
interface Preview { fileName: string; parsed: Parsed }

const PAGE_SIZE = 50;
const MAILBOX_LABEL: Record<string, string> = {
  invalid_format: "Invalid format", placeholder: "Placeholder name", role_account: "Role account",
  suspicious: "Looks random", unverifiable: "Can't be confirmed",
};

type Filter = "all" | "allow" | "review" | "block" | "problem" | "waiting";
type Bucket = Exclude<Filter, "all">;

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: "all", label: "All" }, { key: "allow", label: "Allow" }, { key: "review", label: "Review" },
  { key: "block", label: "Block" }, { key: "problem", label: "Problems" }, { key: "waiting", label: "Waiting" },
];

function explainFailure(f: Failed) {
  const base = (MESSAGES as Record<string, string>)[f.error] ?? "That file couldn't be read.";
  return f.error === "too_many_rows" && f.rowCount ? `${base} (This one has ${f.rowCount.toLocaleString()}.)` : base;
}

// A duplicate row shows the result of the first row with the same address.
function resolve(row: BulkRow, rows: BulkRow[]) {
  return row.duplicateOf !== null ? rows[row.duplicateOf - 1] ?? row : row;
}

function bucketOf(row: BulkRow): Bucket {
  if (row.status === "invalid" || row.status === "error") return "problem";
  if (row.status === "done" && row.recommendation) return row.recommendation;
  return "waiting";
}

function statusText(row: BulkRow, rows: BulkRow[]) {
  const shown = resolve(row, rows);
  if (shown.status === "invalid") return row.duplicateOf !== null ? `invalid (same as row ${row.duplicateOf})` : "invalid";
  if (shown.status === "done") return row.duplicateOf !== null ? `duplicate of row ${row.duplicateOf}` : "checked";
  if (shown.status === "error") return "failed";
  if (shown.status === "pending") return "still analysing";
  return "not checked";
}

export default function BulkCheck() {
  const { run, version, start, cancel, resume, clear } = useBulk();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [page, setPage] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const running = run?.state === "running";

  async function takeFile(file: File | undefined) {
    if (!file) return;
    setProblem(null);
    setPreview(null);
    if (file.size > MAX_BYTES) { setProblem(MESSAGES.too_big); return; }
    try {
      const out = readUpload(new Uint8Array(await file.arrayBuffer()), file.size) as unknown as Parsed | Failed;
      if (!out.ok) { setProblem(explainFailure(out)); return; }
      setPreview({ fileName: file.name, parsed: out });
      if (out.columnNeedsChoosing) setProblem(MESSAGES.no_email_column);
    } catch {
      setProblem("That file couldn't be read.");
    }
  }

  function chooseColumn(column: number) {
    if (!preview) return;
    const { rows, hasHeader } = preview.parsed;
    const built = buildEntries(rows, column, hasHeader) as unknown as { entries: BulkInputEntry[]; counts: Counts } | { error: string; rowCount?: number };
    if ("error" in built) { setProblem(explainFailure({ ok: false, ...built })); return; }
    setProblem(null);
    setPreview({ ...preview, parsed: { ...preview.parsed, column, columnNeedsChoosing: false, ...built } });
  }

  function begin() {
    if (!preview || running) return;
    start(preview.fileName, preview.parsed.entries);
    setPreview(null);
    setFilter("all");
    setPage(0);
    if (input.current) input.current.value = "";
  }

  // Everything below is worked out from the rows each time they change (`version`).
  const view = useMemo(() => {
    const rows = run?.rows ?? [];
    const counts = { allow: 0, review: 0, block: 0, problem: 0, waiting: 0 };
    let finished = 0;
    for (const row of rows) {
      const bucket = bucketOf(resolve(row, rows));
      counts[bucket]++;
      if (bucket !== "waiting") finished++;
    }
    const shown = rows.filter((r) => filter === "all" || bucketOf(resolve(r, rows)) === filter);
    return { rows, counts, finished, shown };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, version, filter]);

  const pages = Math.max(1, Math.ceil(view.shown.length / PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  const slice = view.shown.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);
  const percent = view.rows.length ? Math.round((view.finished / view.rows.length) * 100) : 0;

  function download() {
    if (!run) return;
    const records = view.rows.map((row) => {
      const shown = resolve(row, view.rows);
      return [
        row.n, row.email ?? row.raw ?? "", shown.domain ?? "", shown.verdict ?? "", shown.confidence ?? "",
        shown.mailboxStatus ? MAILBOX_LABEL[shown.mailboxStatus] ?? shown.mailboxStatus : "",
        shown.status === "done" ? shown.recommendation ?? "" : "", statusText(row, view.rows),
        row.note ?? shown.note ?? shown.reasons?.join(" ") ?? "",
      ];
    });
    const csv = toCsv(["Row", "Email", "Domain", "Domain verdict", "Confidence", "Mailbox", "Recommendation", "Status", "Details"], records);
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${run.fileName.replace(/\.[^.]+$/, "") || "results"}-results.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const unfinished = view.counts.waiting > 0;

  return (
    <div className="stack">
      <section className="card">
        <div className="card-head">
          <div>
            <h2>Upload a CSV</h2>
            <p className="card-sub">One email address per row, up to {MAX_ROWS.toLocaleString()} rows and 1 MB. A header row is fine.</p>
          </div>
        </div>

        <label
          className={`dropzone${dragging ? " drag" : ""}${running ? " disabled" : ""}`}
          onDragOver={(e) => { e.preventDefault(); if (!running) setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); if (!running) void takeFile(e.dataTransfer.files[0]); }}
        >
          <input
            ref={input}
            type="file"
            accept=".csv,.txt,text/csv,text/plain"
            disabled={running}
            onChange={(e) => void takeFile(e.target.files?.[0])}
          />
          <strong>{running ? "A check is running" : "Choose a file or drop it here"}</strong>
          <span className="muted small">{running ? "Wait for it to finish, or cancel it below." : "CSV files only. Addresses stay in this browser."}</span>
        </label>

        {problem && <p className="error" role="alert">{problem}</p>}

        {preview && (
          <div className="bulk-preview">
            <div className="row">
              <strong>{preview.fileName}</strong>
              <span className="muted small">
                {preview.parsed.counts.total.toLocaleString()} rows
                {preview.parsed.counts.duplicates > 0 && `, ${preview.parsed.counts.duplicates} duplicate`}
                {preview.parsed.counts.invalid > 0 && `, ${preview.parsed.counts.invalid} unusable`}
              </span>
            </div>
            <div className="row">
              <label className="small" htmlFor="bulk-column">Email column</label>
              <select id="bulk-column" value={preview.parsed.column} onChange={(e) => chooseColumn(Number(e.target.value))}>
                {preview.parsed.labels.map((label, i) => <option key={i} value={i}>{label}</option>)}
              </select>
              <button onClick={begin} disabled={running || preview.parsed.columnNeedsChoosing || preview.parsed.counts.unique === 0}>
                Check {preview.parsed.counts.unique.toLocaleString()} address{preview.parsed.counts.unique === 1 ? "" : "es"}
              </button>
            </div>
            {run && <p className="muted small">Starting a new check replaces the results below.</p>}
          </div>
        )}
      </section>

      {run && (
        <section className="card" aria-live="polite">
          <div className="card-head">
            <div>
              <h2>Results: {run.fileName}</h2>
              <p className="card-sub">
                {run.state === "running" && "Checking. You can look at other tabs; this carries on."}
                {run.state === "done" && (unfinished ? "Finished, with some rows not decided." : "Finished.")}
                {run.state === "cancelled" && "Cancelled. Rows already checked are kept."}
                {run.state === "paused" && (run.pauseReason ?? "Paused.")}
              </p>
            </div>
            <div className="row">
              {running && <button className="secondary small" onClick={cancel}>Cancel</button>}
              {(run.state === "paused" || run.state === "cancelled") && unfinished && <button className="small" onClick={resume}>Resume</button>}
              <button className="secondary small" onClick={download} disabled={view.rows.length === 0}>Download results (CSV)</button>
              <button className="ghost small" onClick={() => { clear(); setPage(0); }} disabled={running}>Clear</button>
            </div>
          </div>

          <div
            className="meter"
            role="progressbar"
            aria-label="Rows decided"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            style={{ color: "var(--accent)" }}
          >
            <span style={{ width: `${percent}%` }} />
          </div>
          <p className="muted small">{view.finished.toLocaleString()} of {view.rows.length.toLocaleString()} rows decided ({percent}%)</p>

          <div className="tiles bulk-tiles">
            <div className="tile"><div className="label">Allow</div><div className="value">{view.counts.allow.toLocaleString()}</div></div>
            <div className="tile"><div className="label">Review</div><div className="value">{view.counts.review.toLocaleString()}</div></div>
            <div className="tile"><div className="label">Block</div><div className="value">{view.counts.block.toLocaleString()}</div></div>
            <div className="tile"><div className="label">Problems</div><div className="value">{view.counts.problem.toLocaleString()}</div></div>
            <div className="tile">
              <div className="label">Waiting</div>
              <div className="value">{view.counts.waiting.toLocaleString()}</div>
              <div className="hint">New domains take a few minutes</div>
            </div>
          </div>

          {!run.savedLocally && run.state !== "running" && (
            <p className="muted small">These results could not be saved in this browser, so they will be lost if you reload the page. Download them to keep them.</p>
          )}

          <div className="row bulk-filter">
            <div className="seg" role="group" aria-label="Filter results">
              {FILTERS.map((f) => (
                <button key={f.key} className={filter === f.key ? "on" : ""} onClick={() => { setFilter(f.key); setPage(0); }}>
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          {view.shown.length === 0 ? (
            <p className="empty muted">Nothing to show for this filter.</p>
          ) : (
            <div className="table-wrap bulk-table">
              <table>
                <thead>
                  <tr><th>Row</th><th>Email</th><th>Domain</th><th>Verdict</th><th>Mailbox</th><th>Result</th><th>Details</th></tr>
                </thead>
                <tbody>
                  {slice.map((row) => {
                    const shown = resolve(row, view.rows);
                    const decided = shown.status === "done" && shown.recommendation;
                    return (
                      <tr key={row.n}>
                        <td className="muted">{row.n}</td>
                        <td className="bulk-email">{row.email ?? (row.raw ? row.raw : <span className="muted">(empty)</span>)}</td>
                        <td className="nowrap">{shown.domain ?? <span className="muted">-</span>}</td>
                        <td>{decided ? <VerdictBadge verdict={shown.verdict} /> : <span className="muted">-</span>}</td>
                        <td className="nowrap">{decided && shown.mailboxStatus ? MAILBOX_LABEL[shown.mailboxStatus] ?? shown.mailboxStatus : <span className="muted">-</span>}</td>
                        <td>
                          {decided && shown.recommendation ? <RecommendationBadge value={shown.recommendation} />
                            : shown.status === "pending" ? <span className="badge info">Analysing</span>
                            : shown.status === "invalid" ? <span className="badge bad">Invalid</span>
                            : shown.status === "error" ? <span className="badge bad">Failed</span>
                            : <span className="badge neutral">Waiting</span>}
                        </td>
                        <td className="small">
                          {row.note ?? shown.note ?? shown.reasons?.[0] ?? ""}
                          {row.duplicateOf !== null && <span className="muted"> Same as row {row.duplicateOf}.</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {view.shown.length > PAGE_SIZE && (
            <div className="pager">
              <button className="secondary small" onClick={() => setPage(current - 1)} disabled={current === 0}>Previous</button>
              <span className="muted small">
                {(current * PAGE_SIZE + 1).toLocaleString()} to {Math.min((current + 1) * PAGE_SIZE, view.shown.length).toLocaleString()} of {view.shown.length.toLocaleString()}
              </span>
              <button className="secondary small" onClick={() => setPage(current + 1)} disabled={current >= pages - 1}>Next</button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

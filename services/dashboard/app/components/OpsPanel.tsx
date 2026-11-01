"use client";
// The live ops page used in the demo video. It tells two stories side by side:
//   Background jobs: jobs wait in a queue, workers appear to clear it, then disappear.
//   API traffic:     requests arrive, API servers are added to carry them.
// Blue is always LOAD (work arriving), aqua is always CAPACITY (servers running to handle it).
// Polls every 3 s and keeps the last 10 minutes, saved so the history survives changing tabs.
import { useEffect, useRef, useState } from "react";
import TimeChart, { type Sample, type Series } from "./TimeChart";

type Ops = {
  at: string;
  queue: { waiting: number; inFlight: number } | null;
  dlq: { waiting: number; inFlight: number } | null;
  services: { api?: { running: number; desired: number }; worker?: { running: number; desired: number } };
  traffic: { cacheHitRate: number | null; lookupsPerMinute: number | null; latencyP95Ms: number | null };
  ingestion: { ranAt?: string; inserted?: number; listSize?: number } | null;
};

const WINDOW_MS = 10 * 60 * 1000;
const POLL_MS = 3000;
const STORE_KEY = "xv-ops-samples";

const LOAD = "var(--c-load)";
const CAPACITY = "var(--c-capacity)";
const WANTED = "var(--c-wanted)";

function toSample(d: Ops): Sample {
  return {
    t: Date.now(),
    waiting: d.queue?.waiting ?? null,
    inFlight: d.queue?.inFlight ?? null,
    failed: d.dlq?.waiting ?? null,
    workersRunning: d.services?.worker?.running ?? null,
    workersWanted: d.services?.worker?.desired ?? null,
    apiRunning: d.services?.api?.running ?? null,
    apiWanted: d.services?.api?.desired ?? null,
    rpm: d.traffic?.lookupsPerMinute ?? null,
    cacheHit: d.traffic?.cacheHitRate ?? null,
    p95: d.traffic?.latencyP95Ms ?? null,
  };
}

function loadSaved(): Sample[] {
  try {
    const raw = sessionStorage.getItem(STORE_KEY);
    const all: Sample[] = raw ? JSON.parse(raw) : [];
    return all.filter((s) => Date.now() - s.t < WINDOW_MS);
  } catch { return []; }
}

// ---------- One plain-English sentence about what is happening right now ----------
type Status = { tone: "good" | "info" | "warn" | "bad"; icon: string; text: string };

function describe(s: Sample | undefined): Status {
  if (!s) return { tone: "info", icon: "…", text: "Connecting" };
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const wR = s.workersRunning ?? 0, wW = s.workersWanted ?? 0, aR = s.apiRunning ?? 0, aW = s.apiWanted ?? 0;
  const waiting = s.waiting ?? 0, inFlight = s.inFlight ?? 0;

  if ((s.failed ?? 0) > 0) return { tone: "bad", icon: "⚠", text: `${plural(s.failed ?? 0, "job")} failed and need attention` };
  if (waiting > 0 && wR === 0) return { tone: "info", icon: "↑", text: `${plural(waiting, "job")} waiting. Starting workers…` };
  if (wR < wW) return { tone: "info", icon: "↑", text: `Adding workers: ${wR} running, ${wW} wanted` };
  if (aR < aW) return { tone: "info", icon: "↑", text: `Adding API servers: ${aR} running, ${aW} wanted` };
  if (wR > wW) return { tone: "info", icon: "↓", text: `Removing workers: ${wR} running, ${wW} wanted` };
  if (aR > aW) return { tone: "info", icon: "↓", text: `Removing API servers: ${aR} running, ${aW} wanted` };
  if (waiting + inFlight > 0) return { tone: "info", icon: "●", text: `Processing ${plural(waiting + inFlight, "job")} with ${plural(wR, "worker")}` };
  if (wR === 0) return { tone: "good", icon: "✓", text: "All quiet. No jobs, workers scaled to zero" };
  return { tone: "good", icon: "✓", text: "All quiet. No jobs waiting" };
}

// ---------- Small pieces ----------
function Tile({ label, value, hint, tone, meter }: { label: string; value: string; hint?: string; tone?: "bad"; meter?: number | null }) {
  return (
    <div className={`otile${tone ? ` ${tone}` : ""}`}>
      <div className="otile-label">{label}</div>
      <div className="otile-value">{tone === "bad" && <span aria-hidden>⚠ </span>}{value}</div>
      {meter != null && (
        <div className="meter otile-meter" aria-hidden><span style={{ width: `${Math.round(meter * 100)}%` }} /></div>
      )}
      <div className="otile-hint">{hint ?? " "}</div>
    </div>
  );
}

const num = (v: number | null | undefined, unit = "") => (v == null ? "–" : `${Math.round(v).toLocaleString()}${unit}`);
const wanted = (r: number | null, w: number | null) => (r != null && w != null && r !== w ? `wanted ${w}` : undefined);

export default function OpsPanel() {
  const [samples, setSamples] = useState<Sample[]>([]);
  const [ops, setOps] = useState<Ops | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  const [hoverT, setHoverT] = useState<number | null>(null);
  const [view, setView] = useState<"charts" | "table">("charts");
  const ready = useRef(false);

  useEffect(() => {
    setSamples(loadSaved());
    ready.current = true;
    let stopped = false;
    async function tick() {
      try {
        const res = await fetch("/api/ops", { cache: "no-store" });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data: Ops = await res.json();
        if (stopped) return;
        setOps(data);
        setError(null);
        setSamples((prev) => {
          const next = [...prev, toSample(data)].filter((s) => Date.now() - s.t < WINDOW_MS).slice(-260);
          try { sessionStorage.setItem(STORE_KEY, JSON.stringify(next)); } catch { /* storage unavailable */ }
          return next;
        });
      } catch (err) {
        if (!stopped) setError((err as Error).message);
      }
      if (!stopped) setNow(Date.now());
    }
    tick();
    const timer = setInterval(tick, POLL_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, []);

  const last = samples[samples.length - 1];
  const status = describe(last);

  // The window grows with the data (2 min at first, up to 10) so early charts aren't mostly empty.
  const span = samples.length ? now - samples[0].t : 0;
  const windowMs = Math.min(WINDOW_MS, Math.max(2 * 60_000, Math.ceil(span / 60_000) * 60_000));
  const common = { samples, now, windowMs, hoverT, onHover: setHoverT };

  const jobsSeries: Series[] = [{ key: "waiting", label: "Jobs waiting", color: LOAD, kind: "line", area: true, value: (s) => s.waiting }];
  const workerSeries: Series[] = [
    { key: "wanted", label: "Wanted", color: WANTED, kind: "step", value: (s) => s.workersWanted },
    { key: "running", label: "Running", color: CAPACITY, kind: "step", value: (s) => s.workersRunning },
  ];
  const rpmSeries: Series[] = [{ key: "rpm", label: "Requests per minute", color: LOAD, kind: "line", area: true, value: (s) => s.rpm }];
  const apiSeries: Series[] = [
    { key: "wanted", label: "Wanted", color: WANTED, kind: "step", value: (s) => s.apiWanted },
    { key: "running", label: "Running", color: CAPACITY, kind: "step", value: (s) => s.apiRunning },
  ];

  const tableRows = samples.filter((_sample, i) => i === samples.length - 1 || i % 5 === 0).slice(-14).reverse();

  return (
    <div className="ops">
      <div className="ops-bar">
        <div className={`ops-status ${status.tone}`} role="status" aria-live="polite">
          <span className="ops-status-icon" aria-hidden>{status.icon}</span>
          <span>{status.text}</span>
        </div>
        <div className="ops-bar-right">
          <span className="small muted ops-live">
            <span className={`live-dot${error ? " off" : ""}`} />
            {error ? "Connection lost" : last ? `Live · ${new Date(last.t).toLocaleTimeString()}` : "Connecting…"}
          </span>
          <div className="seg" role="group" aria-label="View">
            <button className={view === "charts" ? "on" : ""} aria-pressed={view === "charts"} onClick={() => setView("charts")}>Charts</button>
            <button className={view === "table" ? "on" : ""} aria-pressed={view === "table"} onClick={() => setView("table")}>Table</button>
          </div>
        </div>
      </div>

      <h2 className="ops-section">Background jobs</h2>
      <div className="otiles">
        <Tile label="Jobs waiting" value={num(last?.waiting)} hint={last?.inFlight ? `${last.inFlight} in progress` : undefined} />
        <Tile label="Workers" value={num(last?.workersRunning)} hint={wanted(last?.workersRunning ?? null, last?.workersWanted ?? null)} />
        <Tile label="Failed jobs" value={num(last?.failed)} tone={(last?.failed ?? 0) > 0 ? "bad" : undefined} hint={(last?.failed ?? 0) > 0 ? "in the dead-letter queue" : undefined} />
      </div>
      {view === "charts" && (
        <div className="ops-card">
          <TimeChart {...common} title="Jobs waiting" current={num(last?.waiting)} series={jobsSeries} integer
            extra={(s) => [{ label: "in progress", value: num(s.inFlight) }]} />
          <TimeChart {...common} title="Workers" current={`${num(last?.workersRunning)} running`} series={workerSeries} integer showXAxis />
        </div>
      )}

      <h2 className="ops-section">API traffic</h2>
      <div className="otiles">
        <Tile label="Requests / min" value={num(last?.rpm)} hint="≈ 1 min behind" />
        <Tile label="Served from cache" value={last?.cacheHit == null ? "–" : `${Math.round(last.cacheHit * 100)}%`} meter={last?.cacheHit ?? null} hint="≈ 1 min behind" />
        <Tile label="Response time (p95)" value={num(last?.p95, " ms")} hint="≈ 1 min behind" />
        <Tile label="API servers" value={num(last?.apiRunning)} hint={wanted(last?.apiRunning ?? null, last?.apiWanted ?? null)} />
      </div>
      {view === "charts" && (
        <div className="ops-card">
          <TimeChart {...common} title="Requests per minute" current={num(last?.rpm)} series={rpmSeries} minMax={10} />
          <TimeChart {...common} title="API servers" current={`${num(last?.apiRunning)} running`} series={apiSeries} integer showXAxis />
        </div>
      )}

      {view === "table" && (
        <div className="ops-card table-wrap">
          <table>
            <thead>
              <tr><th>Time</th><th>Jobs waiting</th><th>In progress</th><th>Workers</th><th>API servers</th><th>Requests / min</th><th>Cache</th><th>p95</th></tr>
            </thead>
            <tbody>
              {tableRows.map((s) => (
                <tr key={s.t}>
                  <td>{new Date(s.t).toLocaleTimeString()}</td>
                  <td>{num(s.waiting)}</td><td>{num(s.inFlight)}</td>
                  <td>{num(s.workersRunning)} / {num(s.workersWanted)}</td>
                  <td>{num(s.apiRunning)} / {num(s.apiWanted)}</td>
                  <td>{num(s.rpm)}</td>
                  <td>{s.cacheHit == null ? "–" : `${Math.round(s.cacheHit * 100)}%`}</td>
                  <td>{num(s.p95, " ms")}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small muted" style={{ margin: "10px 0 0" }}>Workers and API servers show running / wanted.</p>
        </div>
      )}

      {ops?.ingestion?.ranAt && (
        <p className="small muted ops-foot">
          Domain list last updated {new Date(ops.ingestion.ranAt).toLocaleString()}
          {ops.ingestion.listSize ? ` · ${ops.ingestion.listSize.toLocaleString()} domains` : ""}
        </p>
      )}
    </div>
  );
}

"use client";
// One time-series chart. Several charts stacked in a group share the same time axis and the
// same hover position, so cause and effect line up (e.g. jobs waiting -> workers starting).
import { useEffect, useRef, useState } from "react";

export type Sample = {
  t: number;
  waiting: number | null;
  inFlight: number | null;
  failed: number | null;
  workersRunning: number | null;
  workersWanted: number | null;
  apiRunning: number | null;
  apiWanted: number | null;
  rpm: number | null;
  cacheHit: number | null;
  p95: number | null;
};

export type Series = {
  key: string;
  label: string;
  color: string; // CSS colour or var(--token)
  kind: "line" | "step";
  area?: boolean;
  value: (s: Sample) => number | null;
};

type Props = {
  title: string;
  current: string;
  samples: Sample[];
  now: number;
  windowMs: number;
  series: Series[];
  integer?: boolean;
  minMax?: number;
  hoverT: number | null;
  onHover: (t: number | null) => void;
  showXAxis?: boolean;
  format?: (v: number) => string;
  extra?: (s: Sample) => { label: string; value: string }[];
};

const PAD = { l: 34, r: 14, t: 8, b: 4 };
const PLOT_H = 104;
const AXIS_H = 22;
const GAP_MS = 20_000; // a longer silence than this breaks the line instead of joining across it

function niceMax(m: number, integer: boolean, min: number) {
  const target = Math.max(m, min);
  if (integer && target <= 5) return Math.ceil(target);
  const pow = 10 ** Math.floor(Math.log10(target));
  const n = target / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(240, el.clientWidth)));
    ro.observe(el);
    setWidth(Math.max(240, el.clientWidth));
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

export default function TimeChart({
  title, current, samples, now, windowMs, series, integer = false, minMax = 1,
  hoverT, onHover, showXAxis = false, format, extra,
}: Props) {
  const [wrapRef, width] = useWidth();
  const plotW = width - PAD.l - PAD.r;
  const height = PAD.t + PLOT_H + PAD.b + (showXAxis ? AXIS_H : 0);
  const t0 = now - windowMs;
  const fmt = format ?? ((v: number) => String(Math.round(v * 10) / 10));

  const inWindow = samples.filter((s) => s.t >= t0 - GAP_MS);
  const maxVal = Math.max(0, ...series.flatMap((se) => inWindow.map((s) => se.value(s) ?? 0)));
  const yMax = niceMax(maxVal, integer, minMax);
  const x = (t: number) => PAD.l + ((t - t0) / windowMs) * plotW;
  const y = (v: number) => PAD.t + PLOT_H - (v / yMax) * PLOT_H;
  const base = PAD.t + PLOT_H;

  const ticks = integer && yMax <= 5
    ? Array.from({ length: yMax + 1 }, (_, i) => i)
    : [0, yMax / 2, yMax];

  // Split into runs so missing data or long silences show as gaps.
  function runs(se: Series) {
    const out: { t: number; v: number }[][] = [];
    let cur: { t: number; v: number }[] = [];
    let last = -Infinity;
    for (const s of inWindow) {
      const v = se.value(s);
      if (v === null || s.t - last > GAP_MS) { if (cur.length) out.push(cur); cur = []; }
      if (v !== null) { cur.push({ t: s.t, v }); last = s.t; }
    }
    if (cur.length) out.push(cur);
    return out;
  }

  function path(run: { t: number; v: number }[], kind: Series["kind"], closed: boolean) {
    const pts = run.map((p) => [x(p.t), y(p.v)] as const);
    let d = `M${pts[0][0]},${pts[0][1]}`;
    for (let i = 1; i < pts.length; i++) {
      d += kind === "step" ? ` H${pts[i][0]} V${pts[i][1]}` : ` L${pts[i][0]},${pts[i][1]}`;
    }
    if (closed) d += ` L${pts[pts.length - 1][0]},${base} L${pts[0][0]},${base} Z`;
    return d;
  }

  const hovered = hoverT === null ? null : samples.find((s) => s.t === hoverT) ?? null;

  function nearest(clientX: number, rectLeft: number) {
    const t = t0 + ((clientX - rectLeft - PAD.l) / plotW) * windowMs;
    let best: Sample | null = null;
    for (const s of inWindow) if (!best || Math.abs(s.t - t) < Math.abs(best.t - t)) best = s;
    return best;
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "Escape") return onHover(null);
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    if (inWindow.length === 0) return;
    const i = hovered ? inWindow.findIndex((s) => s.t === hovered.t) : inWindow.length - 1;
    const next = Math.min(inWindow.length - 1, Math.max(0, i + (e.key === "ArrowRight" ? 1 : -1)));
    onHover(inWindow[next].t);
  }

  const hx = hovered ? x(hovered.t) : 0;
  const flip = hx > width * 0.6;
  const lastSample = inWindow[inWindow.length - 1];
  const live = lastSample && now - lastSample.t < GAP_MS;

  return (
    <div className="tchart" ref={wrapRef}>
      <div className="tchart-head">
        <h3>{title}</h3>
        <span className="sr-only">Currently {current}</span>
      </div>

      <div
        className="tchart-body"
        tabIndex={0}
        role="group"
        aria-label={`${title} over the last ${windowMs / 60000} minutes. Use the arrow keys to read values.`}
        onKeyDown={onKey}
        onBlur={() => onHover(null)}
      >
        <svg width={width} height={height} aria-hidden="true">
          {ticks.map((tv) => (
            <g key={tv}>
              <line x1={PAD.l} x2={width - PAD.r} y1={y(tv)} y2={y(tv)} className="tchart-grid" />
              <text x={PAD.l - 8} y={y(tv) + 4} textAnchor="end" className="tchart-tick">{fmt(tv)}</text>
            </g>
          ))}

          {series.map((se) => runs(se).map((run, i) => (
            <g key={`${se.key}-${i}`}>
              {se.area && <path d={path(run, se.kind, true)} fill={se.color} opacity="0.10" />}
              <path d={path(run, se.kind, false)} fill="none" stroke={se.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
            </g>
          )))}

          {live && series.map((se) => {
            const v = se.value(lastSample);
            return v === null ? null : (
              <circle key={se.key} cx={x(lastSample.t)} cy={y(v)} r="4" fill={se.color} className="tchart-dot" />
            );
          })}

          {hovered && (
            <g>
              <line x1={hx} x2={hx} y1={PAD.t} y2={base} className="tchart-cross" />
              {series.map((se) => {
                const v = se.value(hovered);
                return v === null ? null : <circle key={se.key} cx={hx} cy={y(v)} r="4" fill={se.color} className="tchart-dot" />;
              })}
            </g>
          )}

          {showXAxis && (
            <g className="tchart-tick">
              <text x={PAD.l} y={base + 18} textAnchor="start">{windowMs / 60000} min ago</text>
              <text x={PAD.l + plotW / 2} y={base + 18} textAnchor="middle">{windowMs / 120000} min</text>
              <text x={PAD.l + plotW} y={base + 18} textAnchor="end">now</text>
            </g>
          )}

          {/* Hit area: the full plot height and wider than any mark */}
          <rect
            x={PAD.l} y={PAD.t} width={plotW} height={PLOT_H} fill="transparent"
            onPointerMove={(e) => {
              const n = nearest(e.clientX, e.currentTarget.getBoundingClientRect().left - PAD.l);
              onHover(n ? n.t : null);
            }}
            onPointerLeave={() => onHover(null)}
          />
        </svg>

        {hovered && (
          <div className="tchart-tip" style={flip ? { right: width - hx + 12 } : { left: hx + 12 }}>
            <div className="tchart-tip-time">{new Date(hovered.t).toLocaleTimeString()}</div>
            {series.map((se) => {
              const v = se.value(hovered);
              return (
                <div className="tchart-tip-row" key={se.key}>
                  <span className="tchart-key" style={{ background: se.color }} />
                  <strong>{v === null ? "no data" : fmt(v)}</strong>
                  <span>{se.label}</span>
                </div>
              );
            })}
            {extra?.(hovered).map((r) => (
              <div className="tchart-tip-row" key={r.label}><span className="tchart-key none" /><strong>{r.value}</strong><span>{r.label}</span></div>
            ))}
          </div>
        )}
      </div>

      {series.length > 1 && (
        <div className="tchart-legend">
          {series.map((se) => (
            <span key={se.key}><span className="tchart-key" style={{ background: se.color }} />{se.label}</span>
          ))}
        </div>
      )}
    </div>
  );
}

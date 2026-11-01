"use client";
// Requests per key per day (last 7 days), with totals on top.
import { useEffect, useState } from "react";

type Day = { day: string; requests: number; cacheHits: number; queued: number };
type KeyUsage = { name: string; prefix: string; days: Day[] };

export default function Usage() {
  const [usage, setUsage] = useState<KeyUsage[] | null>(null);

  useEffect(() => {
    fetch("/api/usage").then((r) => (r.ok ? r.json() : null)).then((d) => setUsage(d?.usage ?? []));
  }, []);

  const rows = (usage ?? []).flatMap((k) => k.days.map((d) => ({ ...d, key: k.name, prefix: k.prefix })));
  const total = rows.reduce((a, r) => ({ req: a.req + r.requests, hits: a.hits + r.cacheHits, queued: a.queued + r.queued }), { req: 0, hits: 0, queued: 0 });
  const hitRate = total.req ? Math.round((total.hits / total.req) * 100) : null;

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>Usage · last 7 days</h2>
          <p className="card-sub">Counts are saved every 15 seconds, so very recent requests may take a moment to appear.</p>
        </div>
      </div>
      {usage === null ? (
        <div style={{ display: "grid", gap: 10 }}><div className="skeleton" /><div className="skeleton" style={{ width: "60%" }} /></div>
      ) : rows.length === 0 ? (
        <div className="empty"><strong>No usage yet</strong>Requests made with your API keys will show up here.</div>
      ) : (
        <>
          <div className="tiles" style={{ marginBottom: 16 }}>
            <div className="tile"><div className="label">Requests</div><div className="value">{total.req.toLocaleString()}</div></div>
            <div className="tile"><div className="label">Cache hit rate</div><div className="value">{hitRate === null ? "n/a" : `${hitRate}%`}</div></div>
            <div className="tile"><div className="label">Queued for analysis</div><div className="value">{total.queued.toLocaleString()}</div></div>
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Key</th><th>Day</th><th>Requests</th><th>Cache hits</th><th>Queued</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.prefix}-${r.day}`}>
                    <td><strong>{r.key}</strong></td><td className="muted">{r.day}</td>
                    <td>{r.requests.toLocaleString()}</td><td>{r.cacheHits.toLocaleString()}</td><td>{r.queued.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

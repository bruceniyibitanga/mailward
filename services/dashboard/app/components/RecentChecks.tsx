"use client";
// Every check made in this browser, newest first. Pending ones update by themselves.
import { useState } from "react";
import { useChecks } from "./ChecksProvider";
import { Facts, Findings, RecommendationBadge, VerdictBadge, timeAgo } from "./ui";

export default function RecentChecks() {
  const { checks, clear } = useChecks();
  const [open, setOpen] = useState<string | null>(null);

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>Recent checks</h2>
          <p className="card-sub">Saved in this browser, so results are here when you come back.</p>
        </div>
        {checks.some((c) => c.status !== "pending") && (
          <button className="ghost small" onClick={clear}>Clear finished</button>
        )}
      </div>
      {checks.length === 0 ? (
        <div className="empty"><strong>No checks yet</strong>Results of the emails you check will appear here.</div>
      ) : (
        <ul className="history">
          {checks.map((c) => (
            <li key={c.id}>
              <button className="history-item" onClick={() => setOpen(open === c.id ? null : c.id)} aria-expanded={open === c.id}>
                <span>
                  <span className="history-domain">{c.input.includes("@") ? c.input : c.domain}</span>
                  <span className="history-meta"> · {timeAgo(c.startedAt)}</span>
                </span>
                {c.status === "pending" && <span className="badge info"><span className="spinner" /> Analysing</span>}
                {c.status === "error" && <span className="badge bad">Failed</span>}
                {c.status === "done" && (c.recommendation ? <RecommendationBadge value={c.recommendation} /> : <VerdictBadge verdict={c.verdict} />)}
              </button>
              {open === c.id && (
                <div className="history-detail">
                  {c.status === "done" && c.recommendationReasons && c.recommendationReasons.length > 0 && <p className="small" style={{ margin: "0 0 8px" }}>{c.recommendationReasons.join(" ")}</p>}
                  {c.status === "done" && <Findings check={c} />}
                  {c.status === "error" && <p className="small error" style={{ margin: 0 }}>{c.error}</p>}
                  {c.status === "pending" && <p className="small muted" style={{ margin: 0 }}>Waiting for the background worker. This updates automatically.</p>}
                  {c.status === "done" && <Facts check={c} />}
                  {c.status === "done" && c.confidence !== undefined && (
                    <p className="small muted" style={{ margin: "8px 0 0" }}>
                      Confidence {Math.round(c.confidence * 100)}% · source: {c.source ?? "store"}
                    </p>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

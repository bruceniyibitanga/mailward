// Small presentational pieces shared by several pages.
import type { Check, Mailbox, Recommendation } from "./ChecksProvider";

type Tone = "good" | "bad" | "warn" | "info" | "neutral";

// ---------- Domain verdict ----------
const TONES: Record<string, Tone> = {
  legitimate: "good",
  disposable: "bad",
  undeliverable: "warn",
  suspicious: "warn",
  unverified: "warn",
  unknown: "info",
  pending: "info",
};

export function toneFor(verdict: string | undefined): Tone {
  return TONES[verdict ?? ""] ?? "neutral";
}

export function VerdictBadge({ verdict }: { verdict: string | undefined }) {
  return <span className={`badge ${toneFor(verdict)}`}>{verdict ?? "unknown"}</span>;
}

// What the DOMAIN verdict means. Note: "legitimate" says the provider is real, not that this mailbox exists.
const EXPLAIN: Record<string, string> = {
  legitimate: "A real mail provider or established domain (not a disposable service).",
  disposable: "A throwaway email service.",
  undeliverable: "The domain can't receive email (no MX records).",
  suspicious: "Some risk signals were found for this domain.",
  unverified: "No red flags, but not enough evidence either.",
};

export function explain(verdict: string | undefined) {
  return EXPLAIN[verdict ?? ""] ?? "";
}

// ---------- Mailbox assessment ----------
const MAILBOX_LABEL: Record<string, string> = {
  invalid_format: "Invalid format",
  placeholder: "Placeholder name",
  role_account: "Role account",
  suspicious: "Looks random",
  unverifiable: "Can't be confirmed",
};

function mailboxTone(m: Mailbox): Tone {
  if (m.status === "invalid_format") return m.certain ? "bad" : "warn";
  if (m.status === "unverifiable") return "neutral";
  return "warn";
}

export function MailboxBadge({ mailbox }: { mailbox: Mailbox }) {
  return <span className={`badge ${mailboxTone(mailbox)}`}>{MAILBOX_LABEL[mailbox.status] ?? mailbox.status}</span>;
}

// ---------- Recommendation (the headline) ----------
const REC_TONE: Record<Recommendation, Tone> = { allow: "good", review: "warn", block: "bad" };
const REC_LABEL: Record<Recommendation, string> = { allow: "Allow", review: "Review", block: "Block" };

export function RecommendationBadge({ value }: { value: Recommendation }) {
  return <span className={`badge ${REC_TONE[value]}`}>{REC_LABEL[value]}</span>;
}

export function headlineTone(check: Check): Tone {
  return check.recommendation ? REC_TONE[check.recommendation] : toneFor(check.verdict);
}

// ---------- Helpers ----------
export function timeAgo(ms: number) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function Facts({ check }: { check: Check }) {
  const s = check.signals;
  if (!s) return null;
  const age = s.domainAgeDays;
  return (
    <div className="facts">
      {s.onPublicList !== undefined && <span className="fact"><b>Public blocklist</b>{s.onPublicList ? "listed" : "not listed"}</span>}
      {age != null && <span className="fact"><b>Domain age</b>{age >= 365 ? `${(age / 365).toFixed(1)} years` : `${age} days`}</span>}
      {s.mxHosts && <span className="fact"><b>Mail servers</b>{s.mxHosts.length ? s.mxHosts.slice(0, 2).join(", ") : "none"}</span>}
      {s.mxSharedWithDisposable !== undefined && s.mxSharedWithDisposable > 0 && (
        <span className="fact"><b>Shared with disposable</b>{s.mxSharedWithDisposable}</span>
      )}
      {s.homepageReachable !== undefined && <span className="fact"><b>Website</b>{s.homepageReachable ? "reachable" : "unreachable"}</span>}
      {s.keywords && s.keywords.length > 0 && <span className="fact"><b>Keywords</b>{s.keywords.join(", ")}</span>}
    </div>
  );
}

// The two separate answers: what we know about the domain, and what we can say about the mailbox.
export function Findings({ check }: { check: Check }) {
  const m = check.mailbox;
  return (
    <div className="findings">
      <div className="finding">
        <span className="finding-label">Domain</span>
        <span className="finding-body">
          {check.status === "pending"
            ? <span className="badge info"><span className="spinner" /> Analysing</span>
            : <VerdictBadge verdict={check.verdict} />}
          <span className="small muted">{check.status === "pending" ? "New domain, queued for background analysis." : explain(check.verdict)}</span>
        </span>
      </div>
      {m && (
        <div className="finding">
          <span className="finding-label">Mailbox</span>
          <span className="finding-body">
            <MailboxBadge mailbox={m} />
            <span className="small muted">
              {m.reasons.length > 0 ? m.reasons.join(" ") : "Nothing unusual about the name. Whether it exists can't be known from outside."}
            </span>
          </span>
        </div>
      )}
    </div>
  );
}

export function ResultCard({ check }: { check: Check }) {
  if (check.status === "error") {
    return (
      <div className="result bad" role="alert">
        <div className="result-top"><span className="result-domain">{check.input}</span></div>
        <p style={{ margin: 0 }}>{check.error}</p>
      </div>
    );
  }
  const tone = headlineTone(check);
  const pending = check.status === "pending";
  const pct = Math.round((check.confidence ?? 0) * 100);
  const reasons = check.recommendationReasons ?? [];

  return (
    <div className={`result ${tone}`} role={pending ? "status" : undefined}>
      <div className="result-top">
        <span className="result-domain">{check.input.includes("@") ? check.input : check.domain}</span>
        {check.recommendation && !pending
          ? <RecommendationBadge value={check.recommendation} />
          : pending && check.recommendation === "block"
            ? <RecommendationBadge value="block" />
            : <span className="badge info"><span className="spinner" /> {pending ? "Analysing" : "Checked"}</span>}
      </div>

      {check.recommendation && !pending && reasons.length > 0 && (
        <p className="small" style={{ margin: 0 }}>{reasons.join(" ")}</p>
      )}
      {check.recommendation === "allow" && !pending && (
        <p className="small" style={{ margin: 0 }}>No problems found. This does not prove the mailbox exists; send a confirmation email to be sure.</p>
      )}

      <Findings check={check} />

      {!pending && check.confidence !== undefined && (
        <div>
          <div className="small muted" style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
            <span>Domain confidence</span><span>{pct}%</span>
          </div>
          <div className="meter" style={{ color: `var(--${toneFor(check.verdict) === "neutral" ? "muted" : toneFor(check.verdict)})` }}>
            <span style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}
      {!pending && <Facts check={check} />}
      {!pending && <div className="small muted">Source: {check.source ?? "store"}</div>}
      {pending && (
        <p className="muted small" style={{ margin: 0 }}>
          This can take a few minutes if the worker is starting up. You can leave this page; the result is saved under Recent checks.
        </p>
      )}
    </div>
  );
}

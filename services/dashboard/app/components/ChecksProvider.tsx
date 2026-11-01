"use client";
// Holds every "Try it" check for the signed-in user. It lives in the root layout, so it
// survives page changes, keeps polling pending (background-analysed) domains while you
// look at other tabs, and saves to localStorage so a reload doesn't lose the results.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

export type Signals = {
  domainAgeDays?: number | null;
  homepageReachable?: boolean;
  keywords?: string[];
  mxHosts?: string[];
  mxSharedWithDisposable?: number;
  onPublicList?: boolean;
};

export type Mailbox = {
  status: "invalid_format" | "role_account" | "placeholder" | "suspicious" | "unverifiable" | string;
  certain: boolean;
  risk: string;
  reasons: string[];
  note: string;
};

export type Recommendation = "allow" | "review" | "block";

export type Check = {
  id: string;
  input: string;
  domain: string;
  startedAt: number;
  status: "pending" | "done" | "error";
  verdict?: string;
  confidence?: number;
  source?: string;
  signals?: Signals;
  checkedAt?: string;
  mailbox?: Mailbox;
  recommendation?: Recommendation;
  recommendationReasons?: string[];
  finishedAt?: number;
  error?: string;
};

type Ctx = {
  checks: Check[];
  pendingCount: number;
  submitting: boolean;
  submit: (email: string) => Promise<Check | null>;
  clear: () => void;
};

const ChecksContext = createContext<Ctx | null>(null);

export const STORAGE_PREFIX = "xv-checks:";
const MAX_CHECKS = 25;
const POLL_MS = 4000;
// A cold worker (scaled to zero) can take several minutes to start, so wait a long time.
const GIVE_UP_MS = 15 * 60 * 1000;

function save(key: string, checks: Check[]) {
  try { localStorage.setItem(key, JSON.stringify(checks)); } catch { /* storage unavailable */ }
}

// The lookup and polling endpoints wrap the verdict differently; flatten both shapes.
function flatten(v: Record<string, unknown> | null | undefined) {
  if (!v) return null;
  const inner = (v.result as Record<string, unknown> | undefined) ?? v;
  if (typeof inner.verdict !== "string") return null;
  return {
    verdict: inner.verdict as string,
    confidence: typeof inner.confidence === "number" ? inner.confidence : undefined,
    source: typeof inner.source === "string" ? inner.source : undefined,
    signals: inner.signals as Signals | undefined,
    checkedAt: typeof inner.checkedAt === "string" ? inner.checkedAt : undefined,
  };
}

// The mailbox assessment and recommendation come from the server, so the rules live in one place.
function extras(data: Record<string, unknown> | null | undefined) {
  if (!data) return {};
  return {
    mailbox: data.mailbox as Mailbox | undefined,
    recommendation: data.recommendation as Recommendation | undefined,
    recommendationReasons: data.recommendationReasons as string[] | undefined,
  };
}

export function ChecksProvider({ email, children }: { email: string; children: React.ReactNode }) {
  const storageKey = `${STORAGE_PREFIX}${email}`;
  const [checks, setChecks] = useState<Check[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const checksRef = useRef<Check[]>([]);
  checksRef.current = checks;

  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) setChecks(JSON.parse(raw));
    } catch { /* ignore corrupt or blocked storage */ }
    setHydrated(true);
  }, [storageKey]);

  useEffect(() => { if (hydrated) save(storageKey, checks); }, [checks, hydrated, storageKey]);

  const patch = useCallback((id: string, changes: Partial<Check>) => {
    setChecks((prev) => prev.map((c) => (c.id === id ? { ...c, ...changes } : c)));
  }, []);

  const pendingCount = checks.filter((c) => c.status === "pending").length;

  // One timer polls every pending check, wherever the user is in the app.
  useEffect(() => {
    if (!hydrated || pendingCount === 0) return;
    let stopped = false;
    async function tick() {
      for (const c of checksRef.current.filter((x) => x.status === "pending")) {
        if (Date.now() - c.startedAt > GIVE_UP_MS) {
          patch(c.id, { status: "error", error: "Timed out waiting for the background worker." });
          continue;
        }
        try {
          const res = await fetch(`/api/try/${encodeURIComponent(c.domain)}`, { cache: "no-store" });
          if (!res.ok || stopped) continue;
          const data = await res.json();
          const jobStatus: string | undefined = data.job?.status;
          const flat = flatten(data.verdict);
          if (jobStatus === "failed") {
            patch(c.id, { status: "error", error: "The background analysis failed." });
          } else if (flat && (jobStatus === "done" || !data.job)) {
            // Ask again now that the domain is known, so the recommendation reflects the new verdict.
            let full: Record<string, unknown> | null = null;
            try {
              const again = await fetch("/api/try", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ email: c.input }),
              });
              if (again.status === 200) full = await again.json();
            } catch { /* keep the plain verdict */ }
            patch(c.id, { status: "done", ...flat, ...extras(full), source: "fresh analysis", finishedAt: Date.now() });
          }
        } catch { /* network blip; try again next tick */ }
      }
    }
    tick();
    const timer = setInterval(tick, POLL_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, [hydrated, pendingCount, patch]);

  const submit = useCallback(async (input: string): Promise<Check | null> => {
    setSubmitting(true);
    const base = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, input: input.trim(), startedAt: Date.now() };
    try {
      const res = await fetch("/api/try", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: base.input }),
      });
      const data = await res.json().catch(() => ({}));
      let check: Check;
      if (res.status === 202) {
        check = { ...base, domain: data.domain ?? base.input, status: "pending", ...extras(data) };
      } else if (res.ok) {
        const flat = flatten(data);
        check = flat
          ? { ...base, domain: data.domain ?? base.input, status: "done", ...flat, ...extras(data), finishedAt: Date.now() }
          : { ...base, domain: base.input, status: "error", error: "Unexpected response from the API." };
      } else {
        const msg = data.error === "invalid_email_or_domain" ? "That doesn't look like a valid email or domain." : "The check could not be completed.";
        check = { ...base, domain: base.input, status: "error", error: msg };
      }
      setChecks((prev) => [check, ...prev].slice(0, MAX_CHECKS));
      return check;
    } catch {
      return null;
    } finally {
      setSubmitting(false);
    }
  }, []);

  const clear = useCallback(() => setChecks((prev) => prev.filter((c) => c.status === "pending")), []);

  const value = useMemo(() => ({ checks, pendingCount, submitting, submit, clear }), [checks, pendingCount, submitting, submit, clear]);
  return <ChecksContext.Provider value={value}>{children}</ChecksContext.Provider>;
}

export function useChecks(): Ctx {
  const ctx = useContext(ChecksContext);
  if (!ctx) throw new Error("useChecks must be used inside ChecksProvider");
  return ctx;
}

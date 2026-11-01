"use client";
// Runs a bulk check (an uploaded CSV) in the browser and keeps the results for the Bulk check page.
// Mounted once in the layout, so a run carries on while the user looks at other tabs.
//
// How a run works:
//  1. Each unique address is sent to /api/bulk in chunks (two requests at a time). The server
//     looks each domain up once and queues unknown domains for background analysis.
//  2. Rows whose domain is still being analysed are followed up with "peek" requests, which
//     only report what is known and never queue anything, until they are decided or 15 minutes
//     have passed.
//  3. If the server is busy (429/5xx) the run slows down and retries; if the sign-in has ended
//     (401) it pauses, so nothing is lost and it can be resumed.
// Addresses stay in this browser. They are never stored on the server.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { MESSAGES } from "@/lib/csv.mjs";
import type { Recommendation } from "./ChecksProvider";

export const BULK_STORAGE_PREFIX = "xv-bulk:";

const START_CHUNK = 100;
const MIN_CHUNK = 20;
const LANES = 2;                       // requests in flight at once
const MAX_ATTEMPTS = 3;                // per row, for temporary failures
const MAX_DEFERRALS = 10;              // per row, when the server keeps asking to try again
const FOLLOW_UP_MIN_MS = 5_000;
const GIVE_UP_MS = 15 * 60_000;        // same limit as a single check

export type RowStatus = "waiting" | "checking" | "pending" | "done" | "invalid" | "error" | "duplicate";

export interface BulkRow {
  n: number;                           // row number below the header
  email: string | null;                // null when the row had no usable address
  raw?: string;                        // what the cell held, for rows with no usable address
  duplicateOf: number | null;
  status: RowStatus;
  note?: string;                       // why a row is invalid or failed
  domain?: string;
  verdict?: string;
  confidence?: number;
  recommendation?: Recommendation;
  reasons?: string[];
  mailboxStatus?: string | null;
  attempts: number;
  deferrals: number;
  pendingSince?: number;
}

export type RunState = "running" | "paused" | "done" | "cancelled";

export interface BulkRun {
  fileName: string;
  startedAt: number;
  finishedAt?: number;
  state: RunState;
  pauseReason?: string;
  rows: BulkRow[];                     // changed in place; read `version` to know when
  savedLocally: boolean;
}

export interface BulkInputEntry {
  n: number;
  email: string | null;
  error: string | null;
  duplicateOf: number | null;
  raw?: string;
}

interface ApiItem {
  status: "done" | "pending" | "invalid" | "deferred" | "error";
  error?: string;
  domain?: string;
  verdict?: string;
  confidence?: number;
  recommendation?: Recommendation;
  reasons?: string[];
  mailboxStatus?: string | null;
}

interface BulkContextValue {
  run: BulkRun | null;
  version: number;                     // changes whenever rows change
  start: (fileName: string, entries: BulkInputEntry[]) => void;
  cancel: () => void;
  resume: () => void;
  clear: () => void;
}

const BulkContext = createContext<BulkContextValue | null>(null);

export function useBulk() {
  const ctx = useContext(BulkContext);
  if (!ctx) throw new Error("useBulk must be used inside <BulkProvider>");
  return ctx;
}

// ---------------------------------------------------------------------------------------------
// Talking to the server
// ---------------------------------------------------------------------------------------------

class AuthError extends Error {}
class RateLimited extends Error { constructor(readonly seconds: number) { super("rate limited"); } }
class Temporary extends Error {}
class Refused extends Error {}

async function postBatch(emails: string[], mode: "submit" | "peek", signal: AbortSignal): Promise<ApiItem[]> {
  let res: Response;
  try {
    res = await fetch("/api/bulk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ emails, mode }),
      signal,
    });
  } catch (err) {
    if (signal.aborted) throw err;
    throw new Temporary("network");
  }
  if (res.status === 401) throw new AuthError();
  if (res.status === 429) {
    const body = await res.json().catch(() => ({}));
    throw new RateLimited(Number(body?.retryAfterSeconds) || 10);
  }
  if (res.status >= 500 || res.status === 408) throw new Temporary(`HTTP ${res.status}`);
  if (!res.ok) throw new Refused(`HTTP ${res.status}`);
  const data = await res.json().catch(() => null);
  if (!data || !Array.isArray(data.results) || data.results.length !== emails.length) throw new Temporary("unexpected reply");
  return data.results as ApiItem[];
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

// ---------------------------------------------------------------------------------------------
// Saving finished results in this browser (codes only, no long text)
// ---------------------------------------------------------------------------------------------

interface SavedRun {
  v: 1;
  fileName: string;
  startedAt: number;
  finishedAt?: number;
  state: RunState;
  pauseReason?: string;
  rows: Array<[number, string | null, number | null, RowStatus, string | undefined, string | undefined, string | undefined, number | undefined, Recommendation | undefined, string | null | undefined, string | undefined]>;
}

function pack(run: BulkRun): SavedRun {
  return {
    v: 1, fileName: run.fileName, startedAt: run.startedAt, finishedAt: run.finishedAt, state: run.state, pauseReason: run.pauseReason,
    rows: run.rows.map((r) => [
      r.n, r.email ?? r.raw ?? null, r.duplicateOf, r.status, r.note, r.domain, r.verdict, r.confidence, r.recommendation, r.mailboxStatus,
      r.recommendation && r.recommendation !== "allow" ? r.reasons?.join(" ").slice(0, 200) : undefined,
    ]),
  };
}

function unpack(saved: SavedRun): BulkRun | null {
  if (!saved || saved.v !== 1 || !Array.isArray(saved.rows)) return null;
  const rows: BulkRow[] = saved.rows.map((r) => ({
    n: r[0], email: r[1], duplicateOf: r[2], status: r[3] === "checking" ? "waiting" : r[3], note: r[4], domain: r[5], verdict: r[6],
    confidence: r[7], recommendation: r[8], mailboxStatus: r[9], reasons: r[10] ? [r[10]] : undefined, attempts: 0, deferrals: 0,
    pendingSince: r[3] === "pending" ? Date.now() : undefined,
  }));
  const wasRunning = saved.state === "running";
  return {
    fileName: saved.fileName, startedAt: saved.startedAt, finishedAt: saved.finishedAt, rows, savedLocally: true,
    state: wasRunning ? "paused" : saved.state,
    pauseReason: wasRunning ? "The page was closed or reloaded while this was running. Press Resume to carry on." : saved.pauseReason,
  };
}

// ---------------------------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------------------------

export function BulkProvider({ email, children }: { email: string; children: React.ReactNode }) {
  const storageKey = `${BULK_STORAGE_PREFIX}${email}`;
  const runRef = useRef<BulkRun | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [version, setVersion] = useState(0);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Re-render at most a few times a second, however fast rows arrive.
  const touch = useCallback(() => {
    if (flushTimer.current) return;
    flushTimer.current = setTimeout(() => { flushTimer.current = null; setVersion((v) => v + 1); }, 200);
  }, []);

  const save = useCallback(() => {
    const run = runRef.current;
    if (!run) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify(pack(run)));
      run.savedLocally = true;
    } catch {
      run.savedLocally = false; // storage full or blocked: results stay in memory only
    }
  }, [storageKey]);

  // Pick up a saved run after the page loads.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        runRef.current = unpack(JSON.parse(raw));
        setVersion((v) => v + 1);
      }
    } catch { /* ignore an unreadable saved run */ }
  }, [storageKey]);

  // Keep progress if the page is closed or reloaded mid-run, and warn before it happens.
  useEffect(() => {
    const onHide = () => { if (runRef.current) save(); };
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (runRef.current?.state === "running") { e.preventDefault(); e.returnValue = ""; }
    };
    window.addEventListener("pagehide", onHide);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [save]);

  const execute = useCallback(async () => {
    const run = runRef.current;
    if (!run) return;
    const controller = new AbortController();
    abortRef.current = controller;
    const { signal } = controller;

    run.state = "running";
    run.pauseReason = undefined;
    run.finishedAt = undefined;
    touch();

    let chunk = START_CHUNK;
    let pauseUntil = 0;
    const flags = { authEnded: false }; // an object, because nested functions change it
    const rows = run.rows;
    const live = () => !signal.aborted && !flags.authEnded;

    function apply(row: BulkRow, item: ApiItem) {
      if (item.status === "done" || item.status === "pending") {
        row.status = item.status;
        row.domain = item.domain;
        row.verdict = item.verdict;
        row.confidence = item.confidence;
        row.recommendation = item.recommendation;
        row.reasons = item.reasons;
        row.mailboxStatus = item.mailboxStatus ?? null;
        row.note = undefined;
        if (item.status === "pending") row.pendingSince ??= Date.now(); else row.pendingSince = undefined;
      } else if (item.status === "invalid") {
        row.status = "invalid";
        row.note = "Not a valid email address or domain";
      } else if (item.status === "deferred") {
        // The server ran out of time, or has nothing queued for it: send it again, but not forever.
        if (++row.deferrals > MAX_DEFERRALS) { row.status = "error"; row.note = "The service was too busy to check this row. Try again later"; }
        else row.status = "waiting";
      } else if (item.error === "analysis_failed") {
        row.status = "error";
        row.note = "The analysis of this domain failed";
      } else if (++row.attempts < MAX_ATTEMPTS) {
        row.status = "waiting";
      } else {
        row.status = "error";
        row.note = "Couldn't be checked just now. Try again later";
      }
    }

    // Sends one chunk and applies the reply. Returns the share of rows the server deferred.
    async function send(batch: BulkRow[], mode: "submit" | "peek") {
      try {
        const items = await postBatch(batch.map((r) => r.email as string), mode, signal);
        batch.forEach((row, i) => apply(row, items[i]));
        const share = items.filter((i) => i.status === "deferred").length / batch.length;
        if (share > 0) pauseUntil = Math.max(pauseUntil, Date.now() + 1000); // don't hammer a busy server
        return share;
      } catch (err) {
        if (signal.aborted) { batch.forEach((r) => { if (r.status === "checking") r.status = "waiting"; }); return 0; }
        if (err instanceof AuthError) {
          flags.authEnded = true;
          batch.forEach((r) => { r.status = r.pendingSince ? "pending" : "waiting"; });
        } else if (err instanceof RateLimited) {
          pauseUntil = Math.max(pauseUntil, Date.now() + err.seconds * 1000 + 500);
          batch.forEach((r) => { r.status = r.pendingSince ? "pending" : "waiting"; });
        } else {
          // A temporary failure: slow down, and give up on a row only after a few tries.
          pauseUntil = Math.max(pauseUntil, Date.now() + 1000 * 2 ** Math.min(batch[0].attempts, 4));
          batch.forEach((r) => {
            if (++r.attempts < MAX_ATTEMPTS) r.status = r.pendingSince ? "pending" : "waiting";
            else { r.status = "error"; r.note = err instanceof Refused ? "The request was refused" : "Couldn't be checked just now. Try again later"; }
          });
        }
        return 0;
      } finally {
        touch();
      }
    }

    async function submitWaiting() {
      await Promise.all(Array.from({ length: LANES }, async () => {
        while (live()) {
          const wait = pauseUntil - Date.now();
          if (wait > 0) await sleep(wait, signal);
          if (!live()) return;
          const batch = rows.filter((r) => r.status === "waiting" && r.email).slice(0, chunk);
          if (batch.length === 0) return;
          batch.forEach((r) => { r.status = "checking"; });
          const deferred = await send(batch, "submit");
          if (deferred > 0.25) chunk = Math.max(MIN_CHUNK, Math.floor(chunk / 2));
          else if (deferred === 0 && chunk < START_CHUNK) chunk = Math.min(START_CHUNK, chunk + 10);
        }
      }));
    }

    try {
      while (live()) {
        await submitWaiting();
        if (!live()) break;

        // Rows that have been waiting too long are given up on.
        const now = Date.now();
        rows.filter((r) => r.status === "pending" && r.pendingSince && now - r.pendingSince > GIVE_UP_MS)
          .forEach((r) => { r.status = "error"; r.note = "Still being analysed after 15 minutes. Try again later"; });

        const pending = rows.filter((r) => r.status === "pending" && r.email);
        const waiting = rows.some((r) => r.status === "waiting" && r.email);
        if (pending.length === 0 && !waiting) break;
        touch();
        if (waiting) continue;

        // Follow up on domains still being analysed, one chunk at a time, not too fast.
        const chunks = Math.ceil(pending.length / START_CHUNK);
        await sleep(Math.max(FOLLOW_UP_MIN_MS, chunks * 700, pauseUntil - Date.now()), signal);
        for (let i = 0; i < pending.length && live(); i += START_CHUNK) {
          const wait = pauseUntil - Date.now();
          if (wait > 0) await sleep(wait, signal);
          if (!live()) break;
          await send(pending.slice(i, i + START_CHUNK), "peek");
        }
      }
    } finally {
      if (flags.authEnded) {
        run.state = "paused";
        run.pauseReason = "Your sign-in has ended. Sign in again in this browser, then press Resume.";
      } else if (signal.aborted) {
        run.state = "cancelled";
        rows.forEach((r) => { if (r.status === "checking") r.status = "waiting"; });
      } else {
        run.state = "done";
        run.finishedAt = Date.now();
      }
      abortRef.current = null;
      save();
      setVersion((v) => v + 1);
    }
  }, [save, touch]);

  const start = useCallback((fileName: string, entries: BulkInputEntry[]) => {
    if (runRef.current?.state === "running") return;
    const rows: BulkRow[] = entries.map((e) => {
      const base = { n: e.n, email: e.email, raw: e.raw, duplicateOf: e.duplicateOf, attempts: 0, deferrals: 0 };
      if (e.error) return { ...base, status: "invalid" as const, note: (MESSAGES as Record<string, string>)[e.error] ?? "Not a valid address" };
      if (e.duplicateOf !== null) return { ...base, status: "duplicate" as const };
      return { ...base, status: "waiting" as const };
    });
    runRef.current = { fileName, startedAt: Date.now(), state: "running", rows, savedLocally: false };
    setVersion((v) => v + 1);
    void execute();
  }, [execute]);

  const cancel = useCallback(() => { abortRef.current?.abort(); }, []);

  const resume = useCallback(() => {
    const run = runRef.current;
    if (!run || run.state === "running" || run.state === "done") return;
    run.rows.forEach((r) => { r.attempts = 0; r.deferrals = 0; });
    setVersion((v) => v + 1);
    void execute();
  }, [execute]);

  const clear = useCallback(() => {
    abortRef.current?.abort();
    runRef.current = null;
    try { localStorage.removeItem(storageKey); } catch { /* ignore */ }
    setVersion((v) => v + 1);
  }, [storageKey]);

  const value = useMemo<BulkContextValue>(
    () => ({ run: runRef.current, version, start, cancel, resume, clear }),
    [version, start, cancel, resume, clear],
  );

  return <BulkContext.Provider value={value}>{children}</BulkContext.Provider>;
}

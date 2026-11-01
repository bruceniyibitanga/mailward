"use client";
// Create, list and revoke API keys. A new key is shown exactly once.
import { useEffect, useState } from "react";

type Key = { hash: string; name: string; prefix: string; createdAt: string; revoked: boolean };

export default function Keys() {
  const [keys, setKeys] = useState<Key[] | null>(null);
  const [name, setName] = useState("");
  const [newKey, setNewKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [limitFor, setLimitFor] = useState<string | null>(null);
  const [limit, setLimit] = useState("");
  const [creating, setCreating] = useState(false);

  async function load() {
    const res = await fetch("/api/keys");
    if (!res.ok) return setError("Could not load keys");
    setKeys((await res.json()).keys);
  }

  useEffect(() => { load(); }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setCreating(true);
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) return setError("Could not create key");
      setNewKey((await res.json()).key);
      setCopied(false);
      setName("");
      load();
    } finally {
      setCreating(false);
    }
  }

  async function revoke(hash: string) {
    setConfirming(null);
    await fetch(`/api/keys/${hash}`, { method: "DELETE" });
    setNotice("Key revoked. Apps using it will stop working straight away.");
    load();
  }

  async function saveLimit(hash: string) {
    const value = Number(limit);
    if (!Number.isFinite(value) || value < 1) return setError("Enter a limit of at least 1 request per minute.");
    setError(null);
    const res = await fetch(`/api/keys/${hash}/limit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rateLimitPerMin: value }),
    });
    setLimitFor(null);
    setLimit("");
    setNotice(res.ok ? `Rate limit set to ${value.toLocaleString()} requests per minute.` : "Could not change the limit.");
  }

  async function copy() {
    if (!newKey) return;
    try { await navigator.clipboard.writeText(newKey); setCopied(true); } catch { /* clipboard blocked */ }
  }

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>API keys</h2>
          <p className="card-sub">Your apps send a key in the <code>x-api-key</code> header. Only a hash is stored.</p>
        </div>
      </div>
      <form className="row grow" onSubmit={create}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Key name, e.g. production" aria-label="Key name" required />
        <button disabled={creating}>{creating ? "Creating..." : "Create key"}</button>
      </form>
      {newKey && (
        <div className="newkey" role="status">
          <strong>Copy this key now. You won&apos;t be able to see it again.</strong>
          <code>{newKey}</code>
          <div className="row">
            <button className="secondary small" onClick={copy}>{copied ? "Copied ✓" : "Copy key"}</button>
            <button className="ghost small" onClick={() => setNewKey(null)}>Done</button>
          </div>
        </div>
      )}
      {error && <p className="error small" role="alert">{error}</p>}
      {notice && <p className="small muted" role="status">{notice}</p>}

      <div className="table-wrap" style={{ marginTop: 12 }}>
        {keys === null ? (
          <div style={{ display: "grid", gap: 10, padding: "12px 0" }}><div className="skeleton" /><div className="skeleton" style={{ width: "70%" }} /></div>
        ) : keys.length === 0 ? (
          <div className="empty"><strong>No API keys yet</strong>Create your first key above to start calling the API.</div>
        ) : (
          <table>
            <thead><tr><th>Name</th><th>Key</th><th>Created</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.hash}>
                  <td><strong>{k.name}</strong></td>
                  <td><code>{k.prefix}…</code></td>
                  <td className="muted">{new Date(k.createdAt).toLocaleDateString()}</td>
                  <td><span className={`badge ${k.revoked ? "neutral" : "good"}`}>{k.revoked ? "Revoked" : "Active"}</span></td>
                  <td className="actions">
                    {!k.revoked && limitFor === k.hash ? (
                      <span className="row" style={{ justifyContent: "flex-end", flexWrap: "nowrap" }}>
                        <input
                          type="number" min={1} value={limit} onChange={(e) => setLimit(e.target.value)}
                          placeholder="req / min" aria-label="Requests per minute" style={{ width: 110, padding: "6px 10px" }} autoFocus
                        />
                        <button className="small" onClick={() => saveLimit(k.hash)}>Save</button>
                        <button className="ghost small" onClick={() => setLimitFor(null)}>Cancel</button>
                      </span>
                    ) : !k.revoked && confirming === k.hash ? (
                      <>
                        <span className="small muted">Revoke this key?</span>
                        <button className="danger small" onClick={() => revoke(k.hash)}>Yes, revoke</button>
                        <button className="ghost small" onClick={() => setConfirming(null)}>Cancel</button>
                      </>
                    ) : !k.revoked ? (
                      <>
                        <button className="secondary small" onClick={() => { setLimitFor(k.hash); setConfirming(null); }}>Set limit</button>
                        <button className="ghost small" onClick={() => { setConfirming(k.hash); setLimitFor(null); }}>Revoke</button>
                      </>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

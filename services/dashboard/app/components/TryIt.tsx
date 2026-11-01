"use client";
// Type an email, see the verdict. State lives in ChecksProvider, so the result is still
// here after visiting another tab, and background checks keep updating.
import { useState } from "react";
import { useChecks } from "./ChecksProvider";
import { ResultCard } from "./ui";

export default function TryIt() {
  const { checks, submit, submitting } = useChecks();
  const [email, setEmail] = useState("");
  const latest = checks[0];

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    await submit(email);
    setEmail("");
  }

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>Check an email</h2>
          <p className="card-sub">Is this address from a disposable email provider?</p>
        </div>
      </div>
      <form className="row grow" onSubmit={onSubmit}>
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="someone@example.com"
          aria-label="Email address or domain"
          autoComplete="off"
          required
        />
        <button disabled={submitting}>{submitting ? <><span className="spinner" /> Checking</> : "Check"}</button>
      </form>
      {latest && <ResultCard check={latest} />}
    </section>
  );
}

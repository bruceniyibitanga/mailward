"use client";
// Top bar with the active page highlighted and a live count of checks still being analysed.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BULK_STORAGE_PREFIX, useBulk } from "./BulkProvider";
import { STORAGE_PREFIX, useChecks } from "./ChecksProvider";

const LINKS = [
  { href: "/", label: "Home" },
  { href: "/dashboard", label: "Dashboard" },
  { href: "/bulk", label: "Bulk check" },
  { href: "/ops", label: "Live ops" },
];

export default function Nav({ email }: { email: string | null }) {
  const pathname = usePathname();
  const { pendingCount } = useChecks();
  const { run } = useBulk();
  const bulkRunning = run?.state === "running";

  // Addresses are kept only in this browser, so signing out removes them too.
  function forgetLocalChecks() {
    try {
      Object.keys(localStorage)
        .filter((k) => k.startsWith(STORAGE_PREFIX) || k.startsWith(BULK_STORAGE_PREFIX))
        .forEach((k) => localStorage.removeItem(k));
    } catch { /* storage unavailable */ }
  }

  return (
    <header className="nav">
      <Link href="/" className="brand"><span className="brand-mark" aria-hidden>✓</span>Xenova Verify</Link>
      <nav className="nav-links" aria-label="Main">
        {LINKS.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            prefetch={false}
            className={`nav-link${pathname === l.href ? " active" : ""}`}
            aria-current={pathname === l.href ? "page" : undefined}
          >
            {l.label}
            {l.href === "/dashboard" && pendingCount > 0 && (
              <span className="count-pill" title="Checks being analysed in the background"><span className="spinner" />{pendingCount}</span>
            )}
            {l.href === "/bulk" && bulkRunning && (
              <span className="count-pill" title="A bulk check is running"><span className="spinner" />running</span>
            )}
          </Link>
        ))}
        {email ? (
          <>
            {/* Plain <a> on purpose: this is an API route, not a page */}
            <a className="nav-link" href="/api/auth/logout" onClick={forgetLocalChecks}>Sign out</a>
            <span className="nav-user">{email}</span>
          </>
        ) : (
          <a className="nav-link" href="/api/auth/login">Sign in</a>
        )}
      </nav>
    </header>
  );
}

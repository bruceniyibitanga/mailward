// The landing page: what the service does, how to call it, and the sign-in button.

import Link from "next/link";
import { getSession, isLoggedIn } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const session = await getSession();
  const { error } = await searchParams;
  const signedIn = isLoggedIn(session);

  return (
    <>
      <section className="hero">
        <h1>Stop fake sign-ups from <em>disposable emails</em></h1>
        <p>
          Xenova Verify tells you in milliseconds whether an email address belongs to a throwaway provider.
          Call the API at sign-up time and block or flag the account.
        </p>
        {error && <p className="error">Sign-in failed. Please try again.</p>}
        <div className="row">
          {signedIn ? (
            <Link className="button" href="/dashboard" prefetch={false}>Open dashboard</Link>
          ) : (
            <a className="button" href="/api/auth/login">Sign in to get started</a>
          )}
          <a className="button secondary" href="/v1/lists/latest">Download the domain list</a>
        </div>
      </section>

      <div className="steps">
        <div className="card step"><b>1</b><h3>Create an API key</h3><p>Sign in and create a key from the dashboard. It is shown once.</p></div>
        <div className="card step"><b>2</b><h3>Call the API</h3><p>Send the email at sign-up. Known domains answer instantly from cache.</p></div>
        <div className="card step"><b>3</b><h3>Act on the verdict</h3><p>Unknown domains are analysed in the background and answered on the next call.</p></div>
      </div>

      <section className="card">
        <div className="card-head"><h2>Example request</h2></div>
        <pre>{`curl -H "x-api-key: YOUR_KEY" \\
  "https://<this-site>/v1/check?email=random123@gmail.com"

{
  "domain": "gmail.com",
  "verdict": "legitimate",          // about the DOMAIN (a real provider)
  "mailbox": {                      // about the part before the @
    "status": "placeholder",
    "reasons": ["Looks like a placeholder or test name, not a real person."]
  },
  "recommendation": "review"        // allow | review | block
}`}</pre>
        <p className="muted small" style={{ margin: "12px 0 0" }}>
          A domain check can&apos;t prove a mailbox exists. Gmail, Yahoo and Outlook don&apos;t reveal that, so a clean
          address is reported as &quot;can&apos;t be confirmed&quot;. Send a confirmation email to be sure.
        </p>
      </section>
    </>
  );
}

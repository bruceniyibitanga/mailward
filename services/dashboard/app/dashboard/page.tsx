// The Dashboard page: check an address, see recent checks, manage API keys and view usage.
// Visitors who are not signed in are sent to sign in.

import { redirect } from "next/navigation";
import { getSession, isLoggedIn } from "@/lib/session";
import Keys from "../components/Keys";
import RecentChecks from "../components/RecentChecks";
import TryIt from "../components/TryIt";
import Usage from "../components/Usage";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const session = await getSession();
  if (!isLoggedIn(session)) redirect("/api/auth/login");

  return (
    <>
      <div className="page-head">
        <h1>Dashboard</h1>
        <p>Check addresses, manage API keys and watch your usage.</p>
      </div>
      <div className="stack">
        <div className="grid-2">
          <TryIt />
          <RecentChecks />
        </div>
        <Keys />
        <Usage />
      </div>
    </>
  );
}

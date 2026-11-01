// The Live ops page: workers, queue and traffic at a glance. Visitors who are not signed in are sent to sign in.

import { redirect } from "next/navigation";
import { getSession, isLoggedIn } from "@/lib/session";
import OpsPanel from "../components/OpsPanel";

export const dynamic = "force-dynamic";

export default async function OpsPage() {
  const session = await getSession();
  if (!isLoggedIn(session)) redirect("/api/auth/login");

  return (
    <>
      <div className="page-head">
        <h1>Live ops</h1>
        <p>Refreshes every 3 seconds. Keep this open while a load test runs.</p>
      </div>
      <OpsPanel />
    </>
  );
}

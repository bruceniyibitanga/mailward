import { redirect } from "next/navigation";
import { getSession, isLoggedIn } from "@/lib/session";
import BulkCheck from "../components/BulkCheck";

export const dynamic = "force-dynamic";

export default async function BulkPage() {
  const session = await getSession();
  if (!isLoggedIn(session)) redirect("/api/auth/login");

  return (
    <>
      <div className="page-head">
        <h1>Bulk check</h1>
        <p>Upload a CSV of email addresses and see which to allow, review or block.</p>
      </div>
      <BulkCheck />
    </>
  );
}

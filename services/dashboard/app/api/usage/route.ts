// GET: the last week's usage counts for the signed-in user's keys. Forwarded to /admin/usage.

import { callApi } from "@/lib/api";

export async function GET() {
  return callApi("/admin/usage?days=7");
}

// GET: the data behind the Live ops page. Forwarded to the API's private /admin/ops route.

import { callApi } from "@/lib/api";

export async function GET() {
  return callApi("/admin/ops");
}

// POST: check one email address or domain for the dashboard's check box. Forwarded to /admin/try.

import { callApi } from "@/lib/api";

export async function POST(request: Request) {
  return callApi("/admin/try", { method: "POST", body: await request.text() });
}

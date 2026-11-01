// GET: list the signed-in user's API keys. POST: create a key (its secret is shown once).
// Both are forwarded to the API's private /admin/keys route.

import { callApi } from "@/lib/api";

export async function GET() {
  return callApi("/admin/keys");
}

export async function POST(request: Request) {
  return callApi("/admin/keys", { method: "POST", body: await request.text() });
}

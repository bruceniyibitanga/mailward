// POST: change the rate limit of one API key. Forwarded to the API's private /admin/keys/:hash/limit route.

import { callApi } from "@/lib/api";

export async function POST(request: Request, { params }: { params: Promise<{ hash: string }> }) {
  const { hash } = await params;
  return callApi(`/admin/keys/${encodeURIComponent(hash)}/limit`, { method: "POST", body: await request.text() });
}

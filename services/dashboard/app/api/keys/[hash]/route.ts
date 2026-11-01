// DELETE: revoke one API key. Forwarded to the API's private /admin/keys/:hash route.

import { callApi } from "@/lib/api";

export async function DELETE(_request: Request, { params }: { params: Promise<{ hash: string }> }) {
  const { hash } = await params;
  return callApi(`/admin/keys/${encodeURIComponent(hash)}`, { method: "DELETE" });
}

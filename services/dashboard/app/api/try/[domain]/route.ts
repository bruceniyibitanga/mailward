// GET: the current job and verdict for one domain. The page polls this while a new domain is being
// analysed. Forwarded to the API's private /admin/domains/:domain route.

import { callApi } from "@/lib/api";

export async function GET(_request: Request, { params }: { params: Promise<{ domain: string }> }) {
  const { domain } = await params;
  return callApi(`/admin/domains/${encodeURIComponent(domain)}`);
}

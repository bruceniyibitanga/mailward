import { callApi } from "@/lib/api";

// Up to 100 addresses of at most 320 characters is about 35 KB, so anything much bigger is not
// from our page. Refuse it here instead of passing it on.
const MAX_BODY = 60_000;

export async function POST(request: Request) {
  const body = await request.text();
  if (body.length > MAX_BODY) return Response.json({ error: "too_large" }, { status: 413 });
  // A request can look up many domains, so it gets a longer limit than the 10 s default.
  return callApi("/admin/check/batch", { method: "POST", body }, 25_000);
}

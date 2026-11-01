// Calls the API service's private /admin endpoints on behalf of the signed-in user.
// API_INTERNAL_URL is the internal load balancer's address (reachable only
// inside the VPC; the Service Connect namespace was not permitted in this
// account). The browser never talks to it directly.
import { env } from "./config";
import { getSession, isLoggedIn } from "./session";

// timeoutMs: most calls are quick, so the default is short. The bulk check allows longer
// because one request can look up up to 100 addresses.
export async function callApi(path: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<Response> {
  const session = await getSession();
  if (!isLoggedIn(session)) {
    return Response.json({ error: "not_signed_in" }, { status: 401 });
  }

  try {
    const res = await fetch(`${env("API_INTERNAL_URL")}${path}`, {
      ...init,
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "content-type": "application/json",
        ...(init.headers ?? {}),
        authorization: `Bearer ${session.accessToken}`,
      },
    });
    const body = res.status === 204 ? null : await res.text();
    return new Response(body, {
      status: res.status,
      headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
    });
  } catch (err) {
    console.error(JSON.stringify({ level: "error", msg: "api call failed", path, err: (err as Error).message }));
    return Response.json({ error: "api_unreachable" }, { status: 502 });
  }
}

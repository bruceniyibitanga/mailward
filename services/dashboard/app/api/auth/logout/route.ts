// Clear our session cookie, then log out of Cognito too.
import { NextResponse, type NextRequest } from "next/server";
import { getIronSession } from "iron-session";
import { env, appUrl } from "@/lib/config";
import { sessionOptions, type SessionData } from "@/lib/session";

export async function GET(request: NextRequest) {
  const url = new URL("/logout", env("COGNITO_DOMAIN"));
  url.searchParams.set("client_id", env("COGNITO_CLIENT_ID"));
  url.searchParams.set("logout_uri", appUrl()); // must EXACTLY match a sign-out URL in the Cognito app client

  const response = NextResponse.redirect(url);
  const session = await getIronSession<SessionData>(request, response, sessionOptions());
  session.destroy();
  return response;
}

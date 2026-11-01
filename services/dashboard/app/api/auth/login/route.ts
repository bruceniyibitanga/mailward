// Step 1 of sign-in: send the user to the Cognito login page.
// The random "state" value protects against a forged login callback (CSRF).
import { NextResponse, type NextRequest } from "next/server";
import { getIronSession } from "iron-session";
import { env, appUrl } from "@/lib/config";
import { sessionOptions, type SessionData } from "@/lib/session";

export async function GET(request: NextRequest) {
  const state = crypto.randomUUID();

  const url = new URL("/oauth2/authorize", env("COGNITO_DOMAIN"));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", env("COGNITO_CLIENT_ID"));
  url.searchParams.set("redirect_uri", `${appUrl()}/api/auth/callback`);
  url.searchParams.set("scope", "openid email");
  url.searchParams.set("state", state);

  const response = NextResponse.redirect(url);
  const session = await getIronSession<SessionData>(request, response, sessionOptions());
  session.oauthState = state;
  await session.save();
  return response;
}

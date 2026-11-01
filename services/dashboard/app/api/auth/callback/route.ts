// Step 2 of sign-in: Cognito sends the user back here with a one-time code.
// We swap the code for tokens SERVER-SIDE using the client secret, so the
// secret and the tokens never reach the browser.
import { NextResponse, type NextRequest } from "next/server";
import { getIronSession } from "iron-session";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { env, appUrl } from "@/lib/config";
import { sessionOptions, type SessionData } from "@/lib/session";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");

  const response = NextResponse.redirect(`${appUrl()}/dashboard`);
  const session = await getIronSession<SessionData>(request, response, sessionOptions());

  if (!code || !state || state !== session.oauthState) {
    return NextResponse.redirect(`${appUrl()}/?error=login_failed`);
  }

  const clientId = env("COGNITO_CLIENT_ID");
  const basicAuth = Buffer.from(`${clientId}:${env("COGNITO_CLIENT_SECRET")}`).toString("base64");

  const tokenRes = await fetch(new URL("/oauth2/token", env("COGNITO_DOMAIN")), {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${basicAuth}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: `${appUrl()}/api/auth/callback`,
    }),
  });
  if (!tokenRes.ok) {
    console.error(JSON.stringify({ level: "error", msg: "token exchange failed", status: tokenRes.status }));
    return NextResponse.redirect(`${appUrl()}/?error=login_failed`);
  }
  const tokens = (await tokenRes.json()) as { id_token: string; access_token: string; expires_in: number };

  // Check the ID token really came from our user pool before trusting it.
  const verifier = CognitoJwtVerifier.create({
    userPoolId: env("COGNITO_USER_POOL_ID"),
    tokenUse: "id",
    clientId,
  });
  const idToken = await verifier.verify(tokens.id_token);

  session.sub = idToken.sub;
  session.email = typeof idToken.email === "string" ? idToken.email : undefined;
  session.accessToken = tokens.access_token;
  session.expiresAt = Date.now() + (tokens.expires_in - 60) * 1000;
  session.oauthState = undefined;
  await session.save();
  return response;
}

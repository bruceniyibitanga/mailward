// The session lives in an encrypted, httpOnly cookie.
// "httpOnly" means browser JavaScript can't read it, so even if someone
// injected a script into the page, they couldn't steal the access token.
import { getIronSession, type SessionOptions } from "iron-session";
import { cookies } from "next/headers";
import { env } from "./config";

export type SessionData = {
  sub?: string;
  email?: string;
  accessToken?: string;
  expiresAt?: number;
  oauthState?: string;
};

export function sessionOptions(): SessionOptions {
  return {
    password: env("SESSION_SECRET"), // at least 32 characters, from Secrets Manager
    cookieName: "xv_session",
    cookieOptions: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
    },
  };
}

// For pages and route handlers that only need to read the session.
export async function getSession() {
  const cookieStore = await cookies();
  return getIronSession<SessionData>(cookieStore, sessionOptions());
}

export function isLoggedIn(session: SessionData): boolean {
  return Boolean(session.accessToken && session.expiresAt && session.expiresAt > Date.now());
}

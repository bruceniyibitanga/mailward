// The frame shared by every page: the top bar, plus the providers that keep check results and bulk
// results while the user moves between tabs.

import type { Metadata } from "next";
import "./globals.css";
import { getSession, isLoggedIn } from "@/lib/session";
import { BulkProvider } from "./components/BulkProvider";
import { ChecksProvider } from "./components/ChecksProvider";
import Nav from "./components/Nav";

export const metadata: Metadata = {
  title: "Xenova Verify",
  description: "Disposable email detection API",
};

export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const session = await getSession();
  const email = isLoggedIn(session) ? (session.email ?? null) : null;

  return (
    <html lang="en">
      <body>
        {/* Mounted once for the whole app so check results survive switching tabs */}
        <ChecksProvider email={email ?? "anonymous"}>
          <BulkProvider email={email ?? "anonymous"}>
            <Nav email={email} />
            <main>{children}</main>
          </BulkProvider>
        </ChecksProvider>
      </body>
    </html>
  );
}

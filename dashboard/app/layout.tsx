import "./globals.css";
import type { Metadata } from "next";
import { Nav } from "../components/nav";
import { SearchPalette } from "../components/search-palette";
import { getSession } from "../lib/auth";

export const metadata: Metadata = {
  title: "Open Brain",
  description: "OB1 dashboard",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const authed = await getSession();
  return (
    <html lang="en">
      <body>
        {authed ? <Nav /> : null}
        <main className="max-w-5xl mx-auto px-4 py-6">{children}</main>
        {authed ? <SearchPalette /> : null}
      </body>
    </html>
  );
}

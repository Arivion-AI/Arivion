import type { Metadata } from "next";
import "./globals.css";
import { NetrunnersPrivyProvider } from "@/lib/netrunners/privy-auth";

export const metadata: Metadata = {
  title: "ARIVION // The Cross-Chain Agent",
  description:
    "One autonomous agent, two chains. Arivion trades seamlessly across Robinhood and Arbitrum as a single unified surface.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full bg-black">
      <body className="min-h-full bg-black">
        {/* §25 P1.3 — Privy at the edge. With NEXT_PUBLIC_PRIVY_APP_ID unset this renders children
            unchanged (no provider), so dev/CI is unaffected. */}
        <NetrunnersPrivyProvider>{children}</NetrunnersPrivyProvider>
      </body>
    </html>
  );
}

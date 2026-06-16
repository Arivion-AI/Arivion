import type { Metadata } from "next";
import "./globals.css";
import { NetrunnersWalletProvider } from "@/lib/netrunners/metamask-auth";

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
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (() => {
                const root = globalThis;
                try {
                  if (!root.crypto) {
                    Object.defineProperty(root, "crypto", { value: {}, configurable: true });
                  }
                  if (typeof root.crypto.randomUUID !== "function") {
                    const hex = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
                    Object.defineProperty(root.crypto, "randomUUID", {
                      configurable: true,
                      value: () => {
                        const bytes = new Uint8Array(16);
                        if (typeof root.crypto.getRandomValues === "function") {
                          root.crypto.getRandomValues(bytes);
                        } else {
                          for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
                        }
                        bytes[6] = (bytes[6] & 0x0f) | 0x40;
                        bytes[8] = (bytes[8] & 0x3f) | 0x80;
                        return (
                          hex[bytes[0]] + hex[bytes[1]] + hex[bytes[2]] + hex[bytes[3]] + "-" +
                          hex[bytes[4]] + hex[bytes[5]] + "-" +
                          hex[bytes[6]] + hex[bytes[7]] + "-" +
                          hex[bytes[8]] + hex[bytes[9]] + "-" +
                          hex[bytes[10]] + hex[bytes[11]] + hex[bytes[12]] + hex[bytes[13]] + hex[bytes[14]] + hex[bytes[15]]
                        );
                      },
                    });
                  }
                } catch {
                  /* Keep startup resilient if a browser blocks crypto mutation. */
                }
              })();
            `,
          }}
        />
      </head>
      <body className="min-h-full bg-black">
        {/* MetaMask SIWE at the edge: provides wallet auth state + the owner-token session. */}
        <NetrunnersWalletProvider>{children}</NetrunnersWalletProvider>
      </body>
    </html>
  );
}

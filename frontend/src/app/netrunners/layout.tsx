import { Archivo, Chakra_Petch, JetBrains_Mono } from "next/font/google";
import { PropsWithChildren } from "react";
import { NetrunnersShell } from "@/components/netrunners/NetrunnersShell";
import "./netrunners.css";

const chakraPetch = Chakra_Petch({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-display",
});

const archivo = Archivo({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800", "900"],
  variable: "--font-ui",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "700", "800"],
  variable: "--font-mono",
});

export default function NetrunnersLayout({ children }: PropsWithChildren) {
  return (
    <div className={`${chakraPetch.variable} ${archivo.variable} ${jetbrainsMono.variable}`}>
      <NetrunnersShell>{children}</NetrunnersShell>
    </div>
  );
}

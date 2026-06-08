import { Archivo, Chakra_Petch, Orbitron, Share_Tech_Mono } from "next/font/google";
import { DualityLanding } from "@/components/landing/DualityLanding";
import "@/components/landing/landing.css";

const chakraPetch = Chakra_Petch({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-display",
});

const orbitron = Orbitron({
  subsets: ["latin"],
  weight: ["500", "700", "800", "900"],
  variable: "--font-numeric",
});

const shareTechMono = Share_Tech_Mono({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-mono",
});

const archivo = Archivo({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-ui",
});

export default function Home() {
  return (
    <div
      className={`${chakraPetch.variable} ${orbitron.variable} ${shareTechMono.variable} ${archivo.variable}`}
    >
      <DualityLanding />
    </div>
  );
}

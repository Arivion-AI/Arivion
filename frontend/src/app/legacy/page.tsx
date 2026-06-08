"use client";

/**
 * Legacy landing page (interactive split-stage orb).
 * Preserved here after the landing was redesigned — the original components
 * (InteractiveBackground / InteractiveSplitStage / InteractiveOrb) are kept
 * intact and simply rendered from this route instead of "/".
 */

import { InteractiveBackground } from "@/components/InteractiveBackground";
import { InteractiveSplitStage } from "@/components/InteractiveSplitStage";

export default function LegacyHome() {
  return (
    <main className="relative min-h-screen overflow-hidden bg-black text-white">
      <InteractiveBackground />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(20,42,86,0.025),rgba(0,0,0,0)_68%,rgba(0,0,0,0.08)_98%)]" />
      <InteractiveSplitStage />
    </main>
  );
}

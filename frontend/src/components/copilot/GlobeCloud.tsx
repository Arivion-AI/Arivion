"use client";

import { useEffect, useRef } from "react";

// Nexa "data in motion" globe: a point cloud arranged on a sphere (fibonacci distribution), rotating
// slowly, drawn as depth-shaded squares — the subtle ambient state before the first prompt. Pure
// canvas + rAF, DPR-aware, cleans up on unmount. Respects prefers-reduced-motion.
export default function GlobeCloud({ count = 460 }: { count?: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    // Fibonacci sphere — even point distribution.
    const pts: { x: number; y: number; z: number; tw: number }[] = [];
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < count; i++) {
      const y = 1 - (i / (count - 1)) * 2;
      const r = Math.sqrt(1 - y * y);
      const t = golden * i;
      pts.push({ x: Math.cos(t) * r, y, z: Math.sin(t) * r, tw: Math.random() * Math.PI * 2 });
    }

    let raf = 0;
    let w = 0, h = 0, dpr = 1;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = rect.width; h = rect.height;
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    let frame = 0;
    const draw = () => {
      frame++;
      const ang = frame * 0.0016;
      const cx = w / 2, cy = h / 2;
      const radius = Math.min(w, h) * 0.4;
      const cos = Math.cos(ang), sin = Math.sin(ang);
      ctx.clearRect(0, 0, w, h);
      const halo = ctx.createRadialGradient(cx, cy, radius * 0.18, cx, cy, radius * 1.08);
      halo.addColorStop(0, "rgba(70,224,255,0.08)");
      halo.addColorStop(0.45, "rgba(255,90,31,0.045)");
      halo.addColorStop(1, "rgba(255,206,58,0)");
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(cx, cy, radius * 1.08, 0, Math.PI * 2);
      ctx.fill();
      // sort by depth so nearer squares draw over far ones
      const proj = pts.map((p) => {
        const x = p.x * cos - p.z * sin;
        const z = p.x * sin + p.z * cos;
        return { sx: cx + x * radius, sy: cy + p.y * radius, depth: z, tw: p.tw };
      }).sort((a, b) => a.depth - b.depth);
      for (const p of proj) {
        const d = (p.depth + 1) / 2; // 0 (far) .. 1 (near)
        const twinkle = reduce ? 1 : 0.78 + 0.22 * Math.sin(frame * 0.05 + p.tw);
        const size = (1 + d * 3.4) * twinkle;
        const alpha = (0.12 + d * 0.6) * twinkle;
        if (d > 0.72) {
          ctx.fillStyle = `rgba(255,206,58,${Math.min(0.92, alpha + 0.12).toFixed(3)})`;
        } else if (d > 0.46) {
          ctx.fillStyle = `rgba(255,90,31,${Math.min(0.82, alpha + 0.08).toFixed(3)})`;
        } else {
          ctx.fillStyle = `rgba(70,224,255,${Math.min(0.64, alpha + 0.06).toFixed(3)})`;
        }
        ctx.fillRect(p.sx - size / 2, p.sy - size / 2, size, size);
      }
      if (!reduce) raf = requestAnimationFrame(draw);
    };
    draw();
    if (reduce) draw();

    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [count]);

  return <canvas ref={ref} className="nx-globe-canvas" style={{ width: "100%", height: "100%", display: "block" }} aria-hidden />;
}

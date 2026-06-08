"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

// Shared Copilot UI primitives — themed cards, animated counters, toggles, meters, pills, toasts.
// All animation is CSS-driven (see copilot.css); these just wire state.

export function Card({ title, eye, accent, right, children, className = "" }: {
  title?: string; eye?: string; accent?: "orange" | "teal" | "violet"; right?: ReactNode; children: ReactNode; className?: string;
}) {
  return (
    <div className={`cp-card cp-enter ${accent ? `accent ${accent === "orange" ? "" : accent}` : ""} ${className}`}>
      {(title || eye || right) && (
        <div className="cp-card-h">
          <div>
            {eye && <div className="cp-eye">{eye}</div>}
            {title && <div className="cp-ttl">{title}</div>}
          </div>
          {right}
        </div>
      )}
      {children}
    </div>
  );
}

export function KV({ k, v, mono = true }: { k: string; v: ReactNode; mono?: boolean }) {
  return <div className="cp-kv"><span className="k">{k}</span><span className={`v ${mono ? "mono" : ""}`}>{v}</span></div>;
}

// Count-up animation for numbers (credits, budgets, KPIs).
export function useCountUp(target: number, ms = 700): number {
  const [val, setVal] = useState(0);
  const ref = useRef(0);
  useEffect(() => {
    const start = ref.current; const t0 = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / ms);
      const eased = 1 - Math.pow(1 - p, 3);
      const cur = start + (target - start) * eased;
      ref.current = cur; setVal(cur);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return val;
}

export function AnimatedUsd({ value, className = "" }: { value: number; className?: string }) {
  const v = useCountUp(value);
  return <span className={`cp-kpi ${className}`}>${v.toFixed(4)}</span>;
}

export function AnimatedInt({ value, className = "" }: { value: number; className?: string }) {
  const v = useCountUp(value);
  return <span className={`cp-kpi ${className}`}>{Math.round(v)}</span>;
}

export function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return <div className={`cp-toggle ${on ? "on" : ""}`} role="switch" aria-checked={on} onClick={onClick}><i /></div>;
}

export function Pill({ tone = "muted", children, glow }: { tone?: "teal" | "orange" | "red" | "violet" | "muted"; children: ReactNode; glow?: boolean }) {
  return <span className={`cp-pill ${tone} ${glow ? "cp-glow" : ""}`}>{children}</span>;
}

export function Meter({ pct }: { pct: number }) {
  const clamped = Math.max(0, Math.min(100, pct));
  const tone = clamped >= 90 ? "danger" : clamped >= 70 ? "warn" : "";
  return <div className="cp-meter"><i className={tone} style={{ width: `${clamped}%` }} /></div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="cp-empty">{children}</div>;
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>{Array.from({ length: rows }).map((_, i) => (
    <div key={i} className="cp-skeleton" style={{ width: `${90 - i * 12}%` }} />
  ))}</div>;
}

// Lightweight toast hook.
export function useToast(): [ReactNode, (msg: string) => void] {
  const [msg, setMsg] = useState<string | null>(null);
  const show = (m: string) => { setMsg(m); setTimeout(() => setMsg(null), 2600); };
  const node = msg ? <div className="cp-toast">{msg}</div> : null;
  return [node, show];
}

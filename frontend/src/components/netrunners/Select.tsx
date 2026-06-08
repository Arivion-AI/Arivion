"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

export type Option = { value: string; label: string; icon?: ReactNode; hint?: string };

type Props = {
  value: string;
  options: Option[];
  onChange: (value: string) => void;
  variant?: "dark" | "light";
  placeholder?: string;
  disabled?: boolean;
  fullWidth?: boolean;
};

/** Themed custom dropdown replacing the native <select>. Click-outside + Esc + keyboard nav. */
export function Select({ value, options, onChange, variant = "dark", placeholder = "Select…", disabled, fullWidth = true }: Props) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value);
  const light = variant === "light";

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
      else if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(options.length - 1, a + 1)); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
      else if (e.key === "Enter") { e.preventDefault(); const o = options[active]; if (o) { onChange(o.value); setOpen(false); } }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open, options, active, onChange]);

  const bg = light ? "#e7dcc6" : "var(--navy-2, #1b214b)";
  const border = light ? "#cfc4a8" : "var(--navy-line, #2a3060)";
  const fg = light ? "var(--ink, #1b1b1b)" : "var(--white, #eef)";

  return (
    <div ref={ref} style={{ position: "relative", width: fullWidth ? "100%" : "auto" }}>
      <button
        type="button" disabled={disabled} onClick={() => { setOpen((v) => !v); setActive(Math.max(0, options.findIndex((o) => o.value === value))); }}
        className="mono"
        style={{
          width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "9px 11px", borderRadius: 8,
          background: bg, border: `1px solid ${border}`, color: fg, cursor: disabled ? "not-allowed" : "pointer",
          fontSize: 12, opacity: disabled ? 0.5 : 1, textAlign: "left",
        }}
      >
        {selected?.icon}
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{selected?.label ?? placeholder}</span>
        <span style={{ color: light ? "var(--muted-ink,#6b6552)" : "var(--orange,#f97316)", fontSize: 10, transform: open ? "rotate(180deg)" : "none", transition: "transform .15s" }}>▾</span>
      </button>
      {open && (
        <div role="listbox" style={{
          position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, zIndex: 40, maxHeight: 260, overflowY: "auto",
          background: light ? "#ece2cd" : "#141a3a", border: `1px solid ${border}`, borderRadius: 8, boxShadow: "0 10px 30px rgba(0,0,0,.4)", padding: 4,
        }}>
          {options.map((o, i) => {
            const sel = o.value === value;
            return (
              <button key={o.value} type="button" role="option" aria-selected={sel}
                onMouseEnter={() => setActive(i)} onClick={() => { onChange(o.value); setOpen(false); }}
                className="mono"
                style={{
                  width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "8px 9px", borderRadius: 6, cursor: "pointer",
                  background: i === active ? (light ? "#ddd2b8" : "var(--navy-2,#1b214b)") : "transparent",
                  border: sel ? `1px solid ${light ? "var(--orange-deep,#c2410c)" : "var(--orange,#f97316)"}` : "1px solid transparent",
                  color: fg, fontSize: 12, textAlign: "left",
                }}>
                {o.icon}
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{o.label}</span>
                {o.hint && <span style={{ color: light ? "var(--muted-ink,#6b6552)" : "var(--muted,#8a90c0)", fontSize: 10 }}>{o.hint}</span>}
                {sel && <span style={{ color: light ? "var(--orange-deep,#c2410c)" : "var(--teal,#16e0b0)" }}>✓</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

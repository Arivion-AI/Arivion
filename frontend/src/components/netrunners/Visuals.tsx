import { ReactNode } from "react";

type AreaPoint = { x: number; y: number };

export function SparkAreaChart({
  points,
  height = 170,
  stroke = "var(--teal)",
}: {
  points: AreaPoint[];
  height?: number;
  stroke?: string;
}) {
  const width = 600;
  const normalized = points.length > 0 ? points : [{ x: 0, y: 120 }, { x: 100, y: 110 }, { x: 200, y: 115 }, { x: 300, y: 90 }, { x: 400, y: 75 }, { x: 500, y: 60 }, { x: 600, y: 42 }];
  const path = normalized.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
  const fillPath = `${path} L ${width},${height} L 0,${height} Z`;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="nt-area-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={stroke} stopOpacity="0.34" />
          <stop offset="1" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={path} fill="none" stroke={stroke} strokeWidth="2.5" />
      <path d={fillPath} fill="url(#nt-area-grad)" />
    </svg>
  );
}

export function SemiGauge({
  value,
  max,
  label,
  color = "var(--orange)",
}: {
  value: number;
  max: number;
  label: string;
  color?: string;
}) {
  const clamped = Math.min(Math.max(value, 0), max);
  const ratio = max <= 0 ? 0 : clamped / max;
  const start = { x: 18, y: 112 };
  const radius = 77;
  const sweep = Math.PI * (1 - ratio);
  const end = {
    x: 95 + radius * Math.cos(Math.PI - sweep),
    y: 112 - radius * Math.sin(Math.PI - sweep),
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
      <svg width="190" height="120" viewBox="0 0 190 120" aria-hidden="true">
        <path d="M18,112 A77,77 0 0 1 172,112" fill="none" stroke="#2a3060" strokeWidth="12" strokeLinecap="round" />
        <path
          d={`M${start.x},${start.y} A77,77 0 0 1 ${end.x},${end.y}`}
          fill="none"
          stroke={color}
          strokeWidth="12"
          strokeLinecap="round"
        />
        <circle cx={end.x} cy={end.y} r="4" fill="#fff" />
      </svg>
      <div className="mono" style={{ fontSize: "44px", fontWeight: 800, lineHeight: 1 }}>
        {Math.round(clamped)}
      </div>
      <div
        className="dsp"
        style={{
          color,
          fontSize: "12px",
          letterSpacing: "0.22em",
          textTransform: "uppercase",
          marginTop: "3px",
        }}
      >
        {label}
      </div>
    </div>
  );
}

export function HeatStrip({ cells }: { cells: string[] }) {
  return (
    <div className="nt-grid-4" style={{ gridTemplateColumns: "repeat(8, minmax(0, 1fr))", gap: "3px" }}>
      {cells.map((color, index) => (
        <span
          key={`${color}-${index}`}
          style={{
            aspectRatio: "1",
            borderRadius: "3px",
            background: color,
            display: "block",
          }}
        />
      ))}
    </div>
  );
}

export function SectionTitle({
  endpoint,
  title,
  right,
  dark = false,
}: {
  endpoint: string;
  title: string;
  right?: ReactNode;
  dark?: boolean;
}) {
  return (
    <div className="nt-section-h">
      <div>
        <div className={`nt-eyebrow ${dark ? "dk" : ""}`}>{endpoint}</div>
        <h3 className="nt-title">{title}</h3>
      </div>
      {right}
    </div>
  );
}

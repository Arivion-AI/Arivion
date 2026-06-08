import Link from "next/link";

export default function ChromeTradersPage() {
  return (
    <main
      style={{
        minHeight: "100vh",
        background:
          "radial-gradient(circle at 18% 20%, #103243 0%, #08131f 52%, #05070c 100%)",
        color: "#e5f6ff",
        padding: "32px",
        display: "grid",
        placeItems: "center",
      }}
    >
      <section
        style={{
          width: "min(920px, 100%)",
          border: "1px solid rgba(115, 210, 255, 0.28)",
          borderRadius: "20px",
          background: "rgba(8, 21, 32, 0.84)",
          boxShadow: "0 30px 90px rgba(0,0,0,0.5)",
          padding: "34px",
        }}
      >
        <p
          style={{
            fontFamily: "var(--font-mono, JetBrains Mono, monospace)",
            fontSize: "11px",
            letterSpacing: "0.2em",
            textTransform: "uppercase",
            color: "#75cbff",
          }}
        >
          DUALITY / CHROME TRADERS
        </p>
        <h1
          style={{
            marginTop: "8px",
            marginBottom: "14px",
            fontFamily: "var(--font-display, Chakra Petch, sans-serif)",
            fontSize: "46px",
            lineHeight: 0.95,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
          }}
        >
          Chrome Traders
        </h1>
        <p style={{ fontSize: "16px", maxWidth: "680px", color: "#a2d9f6", lineHeight: 1.6 }}>
          Netrunners is fully wired first as requested. This Chrome Traders route is ready for the next module and already linked from the landing split.
        </p>
        <div style={{ marginTop: "28px", display: "flex", gap: "12px", flexWrap: "wrap" }}>
          <Link
            href="/"
            style={{
              textDecoration: "none",
              borderRadius: "999px",
              border: "1px solid rgba(115, 210, 255, 0.35)",
              color: "#d4f4ff",
              padding: "11px 18px",
              textTransform: "uppercase",
              letterSpacing: "0.11em",
              fontSize: "12px",
              fontFamily: "var(--font-display, Chakra Petch, sans-serif)",
            }}
          >
            Back to Landing
          </Link>
          <Link
            href="/netrunners/dashboard"
            style={{
              textDecoration: "none",
              borderRadius: "999px",
              background: "#ef5a23",
              color: "#fff",
              padding: "11px 18px",
              textTransform: "uppercase",
              letterSpacing: "0.11em",
              fontSize: "12px",
              fontFamily: "var(--font-display, Chakra Petch, sans-serif)",
            }}
          >
            Open Netrunners
          </Link>
        </div>
      </section>
    </main>
  );
}

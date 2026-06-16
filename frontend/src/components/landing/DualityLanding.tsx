"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";

/**
 * ARIVION landing — industrial / techwear "caution" composition.
 * Top: framed hero (left spec/caution plate · right cyber hero).
 * Below: a scrolling pitch — problem, solution, products, the asset
 * universe + protocol stack, why-Arbitrum, architecture, roadmap, the ask.
 */
function formatClock() {
  return new Date().toLocaleTimeString("en-GB", { hour12: false });
}

/* ───────── Protocol emblems (inline, monochrome → currentColor) ───────── */
function Logo({ id }: { id: string }) {
  const c = "currentColor";
  switch (id) {
    case "arbitrum":
      return (
        <svg viewBox="0 0 32 32" aria-hidden="true">
          <circle cx="16" cy="16" r="14" fill="none" stroke={c} strokeWidth="1.6" />
          <path d="M16 7 L22.5 24 L19 24 L16 15 L13 24 L9.5 24 Z" fill={c} />
          <path d="M16.4 11.5 L19.5 19.5 L17.6 19.5 Z" fill="none" stroke={c} strokeWidth="1.1" opacity="0.6" />
        </svg>
      );
    case "gmx":
      return (
        <svg viewBox="0 0 32 32" aria-hidden="true">
          <g stroke={c} strokeWidth="1.8" fill="none" strokeLinecap="round">
            <line x1="8" y1="6" x2="8" y2="26" />
            <rect x="5.5" y="11" width="5" height="9" fill={c} stroke="none" />
            <line x1="16" y1="4" x2="16" y2="28" />
            <rect x="13.5" y="9" width="5" height="13" fill={c} stroke="none" />
            <line x1="24" y1="8" x2="24" y2="24" />
            <rect x="21.5" y="14" width="5" height="6" fill={c} stroke="none" />
          </g>
        </svg>
      );
    case "uniswap":
      return (
        <svg viewBox="0 0 32 32" aria-hidden="true">
          <circle cx="16" cy="16" r="13.5" fill="none" stroke={c} strokeWidth="1.6" />
          <path d="M11 20 a7 7 0 0 1 10-10" fill="none" stroke={c} strokeWidth="2.2" strokeLinecap="round" />
          <path d="M21 12 a7 7 0 0 1 -10 10" fill="none" stroke={c} strokeWidth="2.2" strokeLinecap="round" />
          <circle cx="21" cy="11" r="1.7" fill={c} />
          <circle cx="11" cy="21" r="1.7" fill={c} />
        </svg>
      );
    case "robinhood":
      return (
        <svg viewBox="0 0 32 32" aria-hidden="true">
          <path d="M16 3 C9 8 9 20 16 29 C23 20 23 8 16 3 Z" fill="none" stroke={c} strokeWidth="1.6" />
          <line x1="16" y1="6" x2="16" y2="27" stroke={c} strokeWidth="1.4" />
          <g stroke={c} strokeWidth="1.2">
            <line x1="16" y1="11" x2="11.5" y2="13.5" /><line x1="16" y1="11" x2="20.5" y2="13.5" />
            <line x1="16" y1="16" x2="11" y2="19" /><line x1="16" y1="16" x2="21" y2="19" />
          </g>
        </svg>
      );
    case "dune":
      return (
        <svg viewBox="0 0 32 32" aria-hidden="true">
          <circle cx="22" cy="9" r="3" fill={c} />
          <path d="M2 25 C8 16 12 21 18 17 C23 14 27 18 30 14 L30 27 L2 27 Z" fill={c} opacity="0.85" />
          <path d="M2 27 C7 22 12 25 17 22 C23 19 27 23 30 20" fill="none" stroke={c} strokeWidth="1.4" opacity="0.5" />
        </svg>
      );
    case "chainlink":
      return (
        <svg viewBox="0 0 32 32" aria-hidden="true">
          <polygon points="16,3 27,9.5 27,22.5 16,29 5,22.5 5,9.5" fill="none" stroke={c} strokeWidth="1.6" />
          <g fill="none" stroke={c} strokeWidth="2">
            <rect x="11.2" y="11.2" width="4.2" height="6.2" rx="2.1" transform="rotate(-30 13.3 14.3)" />
            <rect x="16.6" y="14.6" width="4.2" height="6.2" rx="2.1" transform="rotate(-30 18.7 17.7)" />
          </g>
        </svg>
      );
    case "arivion":
      return (
        <svg viewBox="0 0 32 32" aria-hidden="true">
          <circle cx="16" cy="16" r="13.5" fill="none" stroke={c} strokeWidth="1.4" />
          <circle cx="16" cy="16" r="4.5" fill="none" stroke={c} strokeWidth="1.8" />
          <circle cx="16" cy="16" r="1.4" fill={c} />
          <g stroke={c} strokeWidth="1.4">
            <line x1="16" y1="2" x2="16" y2="8" /><line x1="16" y1="24" x2="16" y2="30" />
            <line x1="2" y1="16" x2="8" y2="16" /><line x1="24" y1="16" x2="30" y2="16" />
          </g>
        </svg>
      );
    default:
      return null;
  }
}

type Tone = "accent" | "cyan" | "gold";

const PROBLEM = [
  "Retail can't access institutional-grade backtesting, risk modeling, or execution.",
  "Off-chain backtests are unverifiable — survivorship bias, lookahead, fantasy fills.",
  "Strategy tooling is fragmented per asset class — crypto, perps, LPs, equities.",
  "No trust layer: you can't prove a result was real before risking capital.",
];

const FLOW = ["Research", "Backtest", "Optimize", "Paper", "Live"];

const WHY_NOW = [
  ["On-chain execution", "Verifiable fills, transparent fees, no hidden routing."],
  ["DeFi maturity", "GMX v2 + Uniswap v3 on Arbitrum give real depth and real data."],
  ["Tokenized equities", "TradFi assets move on-chain — quant tooling has to follow."],
  ["AI copilots", "Quant made approachable to non-quants, without dumbing down rigor."],
];

const PRODUCTS: { tag: string; tone: Tone; title: string; lead: string; points: string[] }[] = [
  {
    tag: "PRODUCT // 01", tone: "accent", title: "Quant Lab", lead: "Backtest on real candles. Trust the result.",
    points: [
      "Strategy library — trend, market-making, grids, funding MR, TWAP — on real GMX/market data.",
      "Execution realism: venue-exact fees, fill models, slippage, no-lookahead, deterministic runs.",
      "Detailed reports: equity curve, per-trade PnL, Sharpe / Sortino / Calmar, win rate, fees.",
      "Parameter optimizer (sweeps) + portfolio engine across legs.",
    ],
  },
  {
    tag: "PRODUCT // 02", tone: "cyan", title: "Bot OS", lead: "15 configurable strategies, risk-gated before they trade.",
    points: [
      "Grids, DCA, martingale, funding arb, rebalancer, cross-asset allocator, execution algos.",
      "Risk Cockpit: risk score, hard blocks, liquidation / margin, stress modules.",
      "Fully custom params with structured JSON config and token pickers.",
      "Compatibility gating: nothing reaches GMX live without passing the adapter/risk gate.",
    ],
  },
  {
    tag: "PRODUCT // 03", tone: "gold", title: "Arivion Copilot", lead: "An AI quant analyst that's honest about what it knows.",
    points: [
      "Multi-step agent: scans regimes, builds & backtests bots, explains, proposes changes.",
      "Every step emits a Truth Card (coverage, fill model, verified?) and a Cost Card.",
      "Human-in-the-loop autonomy levels — approve vs. auto.",
      "Turns “I have an idea” into a verified, deployable strategy in minutes.",
    ],
  },
];

const ASSETS: { logo: string; name: string; role: string; tone: Tone }[] = [
  { logo: "gmx", name: "Perps", role: "GMX v2 on Arbitrum", tone: "accent" },
  { logo: "uniswap", name: "DEX Liquidity", role: "Uniswap v3 LP analysis & strategies", tone: "cyan" },
  { logo: "robinhood", name: "Tokenized Equities", role: "Robinhood-chain equity sleeve", tone: "gold" },
  { logo: "chainlink", name: "Spot & Cross-Asset", role: "Unified backtesting & allocation", tone: "accent" },
];

const STACK = [
  { logo: "arbitrum", name: "Arbitrum", role: "Settlement L2" },
  { logo: "gmx", name: "GMX v2", role: "Perp execution" },
  { logo: "uniswap", name: "Uniswap v3", role: "LP intelligence" },
  { logo: "chainlink", name: "Chainlink", role: "Price oracles" },
  { logo: "dune", name: "Dune", role: "Analytics & provenance" },
  { logo: "robinhood", name: "Robinhood", role: "Tokenized equities" },
  { logo: "arivion", name: "Arivion", role: "Orchestration layer" },
];

const ARBITRUM_PTS = [
  ["GMX v2, deep", "Live ticket prep, express orders, USDC collateral."],
  ["Uniswap v3 LPs", "LP intelligence on Arbitrum pools."],
  ["Testnet-first", "Arbitrum Sepolia sandbox; mainnet-gated execution."],
  ["Top-of-funnel", "An approachable, AI-guided front door to Arbitrum DeFi."],
];

const ARCH = [
  ["Engine", "Next.js console · Python quant-core · agent / MCP services · Timescale + Redis."],
  ["Data", "GMX markets, DEX pools, Dune analytics, Chainlink-compatible stock oracles."],
  ["Execution", "On-chain path to GMX; provenance + coverage proofs on every dataset."],
  ["Safety", "Testnet sandboxes, mainnet gating, deterministic replays."],
];

const ROADMAP: { when: string; tone: Tone; body: string }[] = [
  { when: "NOW", tone: "accent", body: "GMX/Uniswap backtesting + paper + gated live; testnet on Arbitrum Sepolia." },
  { when: "NEXT", tone: "cyan", body: "Mainnet GMX execution adapter, expanded LP strategies, more tokenized assets." },
  { when: "THEN", tone: "gold", body: "Strategy marketplace, shared verified playbooks, on-chain performance attestations." },
  { when: "VISION", tone: "accent", body: "The verifiable quant layer for all of Arbitrum DeFi." },
];

const ASK = [
  ["Funding", "Milestone-based grant to ship mainnet GMX execution + audits."],
  ["Ecosystem", "GMX / Uniswap intros, co-marketing, hackathon & ecosystem placement."],
  ["Technical", "RPC / infra credits, data-partner intros (Dune, oracles)."],
  ["Commitment", "Measurable volume, users & strategies on Arbitrum within the grant window."],
];

function SectionHead({ index, eyebrow, title, tone = "accent" }: { index: string; eyebrow: string; title: ReactNode; tone?: Tone }) {
  return (
    <div className={`arv-sec-head tone-${tone}`}>
      <span className="arv-sec-index">{index}</span>
      <div>
        <span className="arv-sec-eyebrow">{eyebrow}</span>
        <h2 className="arv-sec-title">{title}</h2>
      </div>
    </div>
  );
}

export function DualityLanding() {
  const router = useRouter();
  const [clock, setClock] = useState("00:00:00");

  useEffect(() => {
    setClock(formatClock());
    const id = setInterval(() => setClock(formatClock()), 1000);
    return () => clearInterval(id);
  }, []);

  // Scroll-reveal: stagger sections in as they enter the viewport.
  useEffect(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>(".arv-reveal"));
    if (!("IntersectionObserver" in window)) { els.forEach((el) => el.classList.add("in")); return; }
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
    }, { threshold: 0.16, rootMargin: "0px 0px -8% 0px" });
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  return (
    <div className="arv">
      <div className="arv-frame">
        {/* ───────── Top bar ───────── */}
        <header className="arv-topbar">
          <button className="arv-menu" aria-label="Menu">
            <span />
            <span />
            <span />
          </button>
          <div className="arv-topbar-center">
            <span className="tick">✳</span>
            <span>[ std.protocol ]</span>
            <span className="arv-clock">{clock}</span>
            <span className="tick">◇</span>
          </div>
          <div className="arv-brand">
            ARV<b>{"/"}</b><b>{"/"}</b>
          </div>
        </header>

        {/* ───────── Body ───────── */}
        <div className="arv-body">
          {/* ===== LEFT — caution plate ===== */}
          <section className="arv-left">
            <div className="arv-vmark">ARIVION</div>

            <div className="arv-left-main">
              <div className="arv-chevrons">
                <div className="arv-chev" />
                <div className="arv-chev" />
                <div className="arv-chev dotted">
                  <i />
                  <i />
                  <i />
                </div>
                <div className="arv-chev" />
                <div className="arv-chev" />
              </div>

              <div className="arv-sector">
                0<b>3</b>
              </div>
              <div className="arv-rule" />

              <div className="arv-caution">
                <h2 className="area">
                  SECTOR <b>{"/"}{"/"} 02-A</b>
                </h2>
                <h2 className="word">CAUTION</h2>
              </div>

              <div className="arv-hazard" />

              <div className="arv-left-foot">
                <span className="arv-cog" />
                <span>ARV-OS {"/"}{"/"} BUILD 1.1 — REV 02</span>
              </div>
            </div>
          </section>

          {/* ===== RIGHT — hero ===== */}
          <section className="arv-right">
            <div className="arv-hero-bg" />
            <div className="arv-core" />

            <span className="arv-hud tl">[ engine.feed ] arv-quant-os</span>
            <span className="arv-hud tr">
              arbitrum one / l2
              <br />
              uplink · stable
            </span>

            <div className="arv-display">
              <span className="arv-eyebrow">On-chain quant intelligence</span>
              <div className="arv-huge">EVERY</div>
              <div className="arv-sub-d">ASSET<span className="sym">⚛</span></div>
            </div>

            {/* orange spec-label card */}
            <aside className="arv-label">
              <div className="row">
                <span className="big">ARIVION OS</span>
                <span className="big" style={{ fontStyle: "italic" }}>
                  ARV
                </span>
              </div>
              <div className="small">QUANT ENGINE · Cα 21-01</div>
              <div className="hr" />
              <div className="dest">STRATEGY : LIVE</div>
              <div className="serial">
                <span className="small">SERIAL NUMBER</span>
                <b>54</b>
              </div>
              <div className="small">002A0BAR0601V51</div>
              <div className="barcode" />
              <span className="tag">ARV-08</span>
            </aside>
          </section>
        </div>

      </div>

      {/* ════════════════════ SCROLLING PITCH ════════════════════ */}
      <main className="arv-sections">
        {/* tagline band */}
        <section className="arv-band arv-reveal">
          <span className="arv-band-tick">✳</span>
          <p className="arv-band-text">
            Quant intelligence for <em>every possible asset</em> — on-chain, on Arbitrum.
          </p>
          <span className="arv-band-meta">SUBMITTED // ARBITRUM ECOSYSTEM</span>
        </section>

        {/* PROBLEM */}
        <section className="arv-section arv-reveal">
          <SectionHead index="01" eyebrow="The problem" title={<>Quant trading is powerful, gated, and <b>dishonest off-chain.</b></>} />
          <ul className="arv-list">
            {PROBLEM.map((p, i) => (
              <li key={i}><span className="arv-li-no">{String(i + 1).padStart(2, "0")}</span>{p}</li>
            ))}
          </ul>
        </section>

        {/* SOLUTION + flow */}
        <section className="arv-section arv-reveal">
          <SectionHead index="02" eyebrow="The solution" tone="cyan" title={<>One quant engine for every asset, with <b className="cy">honesty built in.</b></>} />
          <div className="arv-flow">
            {FLOW.map((step, i) => (
              <div className="arv-flow-step" key={step}>
                <span className="arv-flow-no">{String(i + 1).padStart(2, "0")}</span>
                <span className="arv-flow-name">{step}</span>
                {i < FLOW.length - 1 && <span className="arv-flow-arrow">→</span>}
              </div>
            ))}
          </div>
          <div className="arv-cards three">
            <div className="arv-card"><h4>Single console</h4><p>The same engine that backtests broadcasts the live order — no tool-switching, no drift.</p></div>
            <div className="arv-card"><h4>Truth Cards</h4><p>Every result ships fill model, coverage, no-lookahead and a result tier.</p></div>
            <div className="arv-card"><h4>Native to Arbitrum</h4><p>GMX v2 perps, Uniswap v3 LPs and tokenized stocks, first-class.</p></div>
          </div>
        </section>

        {/* WHY NOW */}
        <section className="arv-section arv-reveal">
          <SectionHead index="03" eyebrow="Why on-chain · why now" tone="gold" title={<>The <b className="gd">honest-quant</b> thesis.</>} />
          <div className="arv-kv-grid">
            {WHY_NOW.map(([k, v]) => (
              <div className="arv-kv" key={k}><h4>{k}</h4><p>{v}</p></div>
            ))}
          </div>
        </section>

        {/* PRODUCTS */}
        <section className="arv-section arv-reveal">
          <SectionHead index="04" eyebrow="The product" title={<>Three surfaces, <b>one engine.</b></>} />
          <div className="arv-products">
            {PRODUCTS.map((p) => (
              <article className={`arv-product tone-${p.tone}`} key={p.title}>
                <span className="arv-product-tag">{p.tag}</span>
                <h3>{p.title}</h3>
                <p className="arv-product-lead">{p.lead}</p>
                <ul>{p.points.map((pt, i) => <li key={i}>{pt}</li>)}</ul>
              </article>
            ))}
          </div>
        </section>

        {/* EVERY ASSET */}
        <section className="arv-section arv-reveal">
          <SectionHead index="05" eyebrow="Every possible asset" tone="cyan" title={<>If it trades, <b className="cy">Arivion quants it.</b></>} />
          <div className="arv-assets">
            {ASSETS.map((a) => (
              <div className={`arv-asset tone-${a.tone}`} key={a.name}>
                <span className="arv-asset-logo"><Logo id={a.logo} /></span>
                <h4>{a.name}</h4>
                <p>{a.role}</p>
              </div>
            ))}
          </div>
        </section>

        {/* WHY ARBITRUM */}
        <section className="arv-section arv-reveal">
          <SectionHead index="06" eyebrow="Why Arbitrum" title={<>Built natively on, and <b>driving volume to,</b> Arbitrum.</>} />
          <div className="arv-kv-grid">
            {ARBITRUM_PTS.map(([k, v]) => (
              <div className="arv-kv" key={k}><h4>{k}</h4><p>{v}</p></div>
            ))}
          </div>
        </section>

        {/* ARCHITECTURE */}
        <section className="arv-section arv-reveal">
          <SectionHead index="07" eyebrow="Architecture" tone="gold" title={<>Honest by design, <b className="gd">on-chain by default.</b></>} />
          <div className="arv-kv-grid">
            {ARCH.map(([k, v]) => (
              <div className="arv-kv" key={k}><h4>{k}</h4><p>{v}</p></div>
            ))}
          </div>
        </section>

        {/* PROTOCOL STACK / logo wall */}
        <section className="arv-section arv-reveal">
          <SectionHead index="08" eyebrow="The stack" tone="cyan" title={<>Every protocol, <b className="cy">one surface.</b></>} />
          <div className="arv-logos">
            {STACK.map((s) => (
              <div className="arv-logo" key={s.name}>
                <span className="arv-logo-mark"><Logo id={s.logo} /></span>
                <span className="arv-logo-name">{s.name}</span>
                <span className="arv-logo-role">{s.role}</span>
              </div>
            ))}
          </div>
        </section>

        {/* TRACTION */}
        <section className="arv-section arv-reveal">
          <SectionHead index="09" eyebrow="Traction & status" title={<>The product is <b>live, end-to-end.</b></>} />
          <div className="arv-stats">
            <div className="arv-stat"><b>15</b><span>Bot OS templates</span></div>
            <div className="arv-stat"><b>5</b><span>strategy classes</span></div>
            <div className="arv-stat"><b>7</b><span>protocol integrations</span></div>
            <div className="arv-stat cy"><b>100%</b><span>on-chain-verifiable runs</span></div>
          </div>
          <p className="arv-foot-note">Quant Lab · Bot OS · Arivion copilot — live with GMX v2, Uniswap v3, Dune & tokenized stocks. <em>[ insert users · backtests run · testnet volume ]</em></p>
        </section>

        {/* ROADMAP */}
        <section className="arv-section arv-reveal">
          <SectionHead index="10" eyebrow="Roadmap" tone="gold" title={<>From testnet to <b className="gd">ecosystem primitive.</b></>} />
          <div className="arv-timeline">
            {ROADMAP.map((r) => (
              <div className={`arv-tl tone-${r.tone}`} key={r.when}>
                <span className="arv-tl-when">{r.when}</span>
                <span className="arv-tl-dot" />
                <p>{r.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* THE ASK */}
        <section className="arv-section arv-reveal">
          <SectionHead index="11" eyebrow="The ask" tone="accent" title={<>What we want from <b>Arbitrum.</b></>} />
          <div className="arv-cards two">
            {ASK.map(([k, v]) => (
              <div className="arv-card hl" key={k}><h4>{k}</h4><p>{v}</p></div>
            ))}
          </div>
        </section>

        {/* CLOSE */}
        <section className="arv-close arv-reveal">
          <div className="arv-hazard" />
          <p className="arv-close-line">
            Arivion makes Arbitrum the home of <em>honest, AI-driven quant trading</em> — for every possible asset.
          </p>
          <div className="arv-close-cta">
            <button className="arv-btn accent" onClick={() => router.push("/chrome-traders")}>
              ENTER THE CONSOLE <span className="arrow">→</span>
            </button>
            <button className="arv-btn ghost" onClick={() => router.push("/netrunners")}>
              EXPLORE THE LAB
            </button>
          </div>
          <div className="arv-close-foot">
            <span className="arv-cog" />
            <span>ARV-OS // BUILD 1.1 — REV 02 · contact · demo · deck</span>
          </div>
        </section>
      </main>
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * ARIVION landing — industrial / techwear "caution" composition.
 * Left: spec + caution plate. Right: cyber hero with display numerals and an
 * orange spec-label. Bottom: the two chain entry points (Robinhood / Arbitrum)
 * the agent moves across seamlessly.
 */
function formatClock() {
  return new Date().toLocaleTimeString("en-GB", { hour12: false });
}

export function DualityLanding() {
  const router = useRouter();
  const [clock, setClock] = useState("00:00:00");

  useEffect(() => {
    setClock(formatClock());
    const id = setInterval(() => setClock(formatClock()), 1000);
    return () => clearInterval(id);
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

            <span className="arv-hud tl">[ signal.feed ] worldwide-sx</span>
            <span className="arv-hud tr">
              lat 00.00 / lon 00.00
              <br />
              uplink · stable
            </span>

            <div className="arv-display">
              <span className="arv-eyebrow">The cross-chain agent</span>
              <div className="arv-huge">
                2026
                <span className="sym">⚛</span>
              </div>
              <div className="arv-sub-d">ALPHA</div>
            </div>

            {/* orange spec-label card */}
            <aside className="arv-label">
              <div className="row">
                <span className="big">WORLDWIDE (SX)</span>
                <span className="big" style={{ fontStyle: "italic" }}>
                  ARV
                </span>
              </div>
              <div className="small">DEPARTMENT 04 · Cα 21-01</div>
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

        {/* ───────── Faction CTAs ───────── */}
        <div className="arv-factions">
          <button
            className="arv-faction arv-faction--gold"
            onClick={() => router.push("/netrunners")}
          >
            <span className="idx">
              CHAIN <span className="idx-accent">/ 01</span>
            </span>
            <span className="name">ROBINHOOD</span>
            <span className="go">
              TRADE ON ROBINHOOD <span className="arrow">→</span>
            </span>
          </button>

          <button
            className="arv-faction arv-faction--cyan"
            onClick={() => router.push("/chrome-traders")}
          >
            <span className="idx">
              CHAIN <span className="idx-accent">/ 02</span>
            </span>
            <span className="name">ARBITRUM</span>
            <span className="go">
              TRADE ON ARBITRUM <span className="arrow">→</span>
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Vector2 } from "three";
import { useRouter } from "next/navigation";
import { InteractiveOrb } from "@/components/InteractiveOrb";

type ActiveSide = null | "left" | "right";

export function InteractiveSplitStage() {
  const router = useRouter();
  const stageRef = useRef<HTMLDivElement>(null);
  const target = useRef({ x: 50, y: 50, side: 0, hover: 0 });
  const current = useRef({ x: 50, y: 50, side: 0, hover: 0 });
  const orbSideRef = useRef(0);
  const orbMouseRef = useRef(new Vector2(0, 0));
  const orbHoverRef = useRef(0);
  const [activeSide, setActiveSide] = useState<ActiveSide>(null);

  /* Click handler at the SECTION level — determines side by mouse X position.
     This way the halves don't need pointer-events and don't block the orb. */
  const handleSectionClick = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      if (!stageRef.current) return;
      const rect = stageRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const centerX = rect.width / 2;
      const orbRadius = rect.width * 0.14; // don't trigger on orb center zone

      if (Math.abs(x - centerX) < orbRadius) return; // click was on the orb

      const side: "left" | "right" = x < centerX ? "left" : "right";
      setActiveSide((prev) => (prev === side ? null : side));
    },
    []
  );

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    let frame = 0;
    let last = performance.now();
    // Cache stage rect — getBoundingClientRect() on every pointermove forces
    // synchronous layout, and since the rAF tick mutates CSS variables on the
    // stage every frame, that layout work compounds and produces visible jitter
    // after sustained interaction.
    let rect = stage.getBoundingClientRect();
    const resizeObserver = new ResizeObserver(() => {
      rect = stage.getBoundingClientRect();
    });
    resizeObserver.observe(stage);
    const onScroll = () => {
      rect = stage.getBoundingClientRect();
    };
    window.addEventListener("scroll", onScroll, { passive: true });

    // Track last-written CSS values so we can skip identical writes (each
    // setProperty invalidates style, even when the value is the same string).
    let lastSplitX = -1;
    let lastSplitY = -1;
    let lastLeft = -1;
    let lastRight = -1;

    const move = (event: PointerEvent) => {
      const x = ((event.clientX - rect.left) / rect.width) * 100;
      const y = ((event.clientY - rect.top) / rect.height) * 100;
      target.current.x = Math.max(0, Math.min(100, x));
      target.current.y = Math.max(0, Math.min(100, y));
      const offset = x - 50;
      const sign = Math.sign(offset);
      const mag = Math.max(0, Math.abs(offset) - 8) / 22;
      target.current.side = sign * Math.max(0, Math.min(1, mag));
      target.current.hover = 1;
    };

    const leave = () => {
      target.current.side = 0;
      target.current.x = 50;
      target.current.y = 50;
      target.current.hover = 0;
    };

    const tick = (now: number) => {
      const delta = Math.min((now - last) / 1000, 0.05);
      last = now;
      const ease = 1 - Math.exp(-delta * 6.5);
      const sideEase = 1 - Math.exp(-delta * 4.2);

      current.current.x += (target.current.x - current.current.x) * ease;
      current.current.y += (target.current.y - current.current.y) * ease;
      current.current.side +=
        (target.current.side - current.current.side) * sideEase;
      current.current.hover +=
        (target.current.hover - current.current.hover) * sideEase;

      const splitX = Math.round(current.current.x * 10) / 10;
      const splitY = Math.round(current.current.y * 10) / 10;
      const leftI = Math.max(0, -current.current.side);
      const rightI = Math.max(0, current.current.side);
      const leftQuant = Math.round(leftI * 1000) / 1000;
      const rightQuant = Math.round(rightI * 1000) / 1000;

      const style = stage.style;
      if (splitX !== lastSplitX) {
        style.setProperty("--split-x", `${splitX}%`);
        lastSplitX = splitX;
      }
      if (splitY !== lastSplitY) {
        style.setProperty("--split-y", `${splitY}%`);
        lastSplitY = splitY;
      }
      if (leftQuant !== lastLeft) {
        style.setProperty("--left-intensity", leftQuant.toFixed(3));
        lastLeft = leftQuant;
      }
      if (rightQuant !== lastRight) {
        style.setProperty("--right-intensity", rightQuant.toFixed(3));
        lastRight = rightQuant;
      }

      orbSideRef.current = current.current.side;
      orbMouseRef.current.set(
        (current.current.x - 50) / 50,
        -(current.current.y - 50) / 50,
      );
      orbHoverRef.current = current.current.hover;

      frame = requestAnimationFrame(tick);
    };

    stage.addEventListener("pointermove", move, { passive: true });
    stage.addEventListener("pointerleave", leave);
    frame = requestAnimationFrame(tick);

    return () => {
      stage.removeEventListener("pointermove", move);
      stage.removeEventListener("pointerleave", leave);
      window.removeEventListener("scroll", onScroll);
      resizeObserver.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);

  const isIdle = activeSide === null;
  const leftActive = activeSide === "left";
  const rightActive = activeSide === "right";

  return (
    <section
      ref={stageRef}
      className="duality-split-stage relative z-10 min-h-screen"
      onClick={handleSectionClick}
    >
      {/* ─── Hero Titles ─── */}
      <div className={`hero-titles ${isIdle ? "" : "is-hidden"}`}>
        <h1 className="hero-title-main">DUALITY</h1>
        <h2 className="hero-subtitle">CHOOSE YOUR PATH</h2>
        <p className="hero-tagline">
          Two factions. One market. Infinite edge.
        </p>
      </div>

      {/* ─── Background halves (visual only, NO pointer-events) ─── */}
      <div
        className={`duality-half duality-half-left ${
          rightActive ? "side-dimmed" : ""
        }`}
      />
      <div
        className={`duality-half duality-half-right ${
          leftActive ? "side-dimmed" : ""
        }`}
      />

      {/* ─── Orb (on top, fully interactive) ─── */}
      <div className="duality-orb-slot">
        <InteractiveOrb
          className="h-full w-full"
          sideRef={orbSideRef}
          mouseRef={orbMouseRef}
          hoverRef={orbHoverRef}
        />
      </div>

      {/* ─── Left: Title + Content ─── */}
      <div className="faction-panel faction-panel-left">
        <h2
          className={`faction-title faction-title-gold ${
            isIdle ? "idle-glow" : ""
          } ${leftActive ? "active-glow" : ""} ${
            leftActive ? "title-activated" : ""
          }`}
        >
          NETRUNNERS
        </h2>

        <div
          className={`faction-content ${leftActive ? "is-visible" : ""}`}
        >
          <span className="faction-label text-yellow-500/80">
            BUILD THE EDGE
          </span>
          <h3 className="faction-heading">
            The architects of autonomous quant models.
          </h3>
          <p className="faction-desc">
            Deploy, train, and refine trading intelligence that adapts to live
            market conditions. Netrunners build the strategies that power
            Duality&apos;s signal economy.
          </p>
          <ul className="faction-list">
            {[
              "Build quant models",
              "Backtest strategies",
              "Improve with live data",
              "Earn from trader usage",
            ].map((item, i) => (
              <li
                key={item}
                className="faction-list-item"
                style={{ transitionDelay: `${0.35 + i * 0.06}s` }}
              >
                <div className="faction-dot faction-dot-gold" />
                {item}
              </li>
            ))}
          </ul>
          <div className="mt-6 group relative inline-flex flex-col items-start">
            <button
              className="faction-btn faction-btn-gold"
              onClick={(event) => {
                event.stopPropagation();
                router.push("/netrunners");
              }}
            >
              ENTER AS NETRUNNER
            </button>
            <div className="faction-btn-hover text-yellow-500/60 left-0">
              Code the signal. Shape the market.
            </div>
          </div>
        </div>
      </div>

      {/* ─── Right: Title + Content ─── */}
      <div className="faction-panel faction-panel-right">
        <h2
          className={`faction-title faction-title-cyan ${
            isIdle ? "idle-glow" : ""
          } ${rightActive ? "active-glow" : ""} ${
            rightActive ? "title-activated" : ""
          }`}
        >
          CHROME
          <br />
          TRADERS
        </h2>

        <div
          className={`faction-content ${rightActive ? "is-visible" : ""}`}
        >
          <span className="faction-label text-cyan-400/80">RIDE THE EDGE</span>
          <h3 className="faction-heading">
            The operators who use battle-tested market intelligence.
          </h3>
          <p className="faction-desc">
            Discover high-performing models, follow trusted signals, and execute
            strategies built by elite Netrunners across the Duality network.
          </p>
          <ul className="faction-list faction-list-right">
            {[
              "Explore trading models",
              "Use live market signals",
              "Track performance",
              "Execute with confidence",
            ].map((item, i) => (
              <li
                key={item}
                className="faction-list-item"
                style={{ transitionDelay: `${0.35 + i * 0.06}s` }}
              >
                {item}
                <div className="faction-dot faction-dot-cyan" />
              </li>
            ))}
          </ul>
          <div className="mt-6 group relative inline-flex flex-col items-end self-end">
            <button
              className="faction-btn faction-btn-cyan"
              onClick={(event) => {
                event.stopPropagation();
                router.push("/chrome-traders");
              }}
            >
              ENTER AS TRADER
            </button>
            <div className="faction-btn-hover text-cyan-400/60 right-0">
              Follow the signal. Hunt the alpha.
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

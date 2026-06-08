"use client";

import Image from "next/image";
import { useEffect, useRef } from "react";

export function InteractiveBackground() {
  const torchRef = useRef<HTMLDivElement>(null);
  const target = useRef({ x: 50, y: 50, active: 0 });
  const current = useRef({ x: 50, y: 50, active: 0 });

  useEffect(() => {
    let frame = 0;
    let last = performance.now();

    const move = (event: PointerEvent) => {
      target.current.x = (event.clientX / window.innerWidth) * 100;
      target.current.y = (event.clientY / window.innerHeight) * 100;

      const edgePadding = 56;
      const isNearViewportEdge =
        event.clientX < edgePadding ||
        event.clientY < edgePadding ||
        window.innerWidth - event.clientX < edgePadding ||
        window.innerHeight - event.clientY < edgePadding;

      target.current.active = isNearViewportEdge ? 0 : 1;
    };

    const leave = () => {
      target.current.active = 0;
    };

    const tick = (now: number) => {
      const delta = Math.min((now - last) / 1000, 0.05);
      last = now;
      const ease = 1 - Math.exp(-delta * 7.5);
      const activeEase = 1 - Math.exp(-delta * 3.2);

      current.current.x += (target.current.x - current.current.x) * ease;
      current.current.y += (target.current.y - current.current.y) * ease;
      current.current.active += (target.current.active - current.current.active) * activeEase;

      if (torchRef.current) {
        torchRef.current.style.setProperty("--torch-x", `${current.current.x}%`);
        torchRef.current.style.setProperty("--torch-y", `${current.current.y}%`);
        torchRef.current.style.setProperty("--torch-opacity", current.current.active.toFixed(3));
      }

      frame = requestAnimationFrame(tick);
    };

    window.addEventListener("pointermove", move, { passive: true });
    window.addEventListener("pointerleave", leave);
    window.addEventListener("blur", leave);
    frame = requestAnimationFrame(tick);

    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerleave", leave);
      window.removeEventListener("blur", leave);
      cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      <Image
        aria-hidden="true"
        className="duality-background-base object-cover"
        src="/duality-background.svg"
        alt=""
        fill
        priority
      />
      <div ref={torchRef} className="duality-background-torch absolute inset-0">
        <Image
          aria-hidden="true"
          className="object-cover"
          src="/duality-background.svg"
          alt=""
          fill
          priority
        />
      </div>
    </div>
  );
}

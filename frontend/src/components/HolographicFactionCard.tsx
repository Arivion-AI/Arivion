"use client";

import HolographicSticker from "holographic-sticker";

type HolographicFactionCardProps = {
  title: string;
  variant: "netrunners" | "chrome";
};

const cardConfig = {
  netrunners: {
    image: "/netrunners-card.svg",
    accent: "#54efff",
    code: "NTR-08",
  },
  chrome: {
    image: "/chrome-traders-card.svg",
    accent: "#b784ff",
    code: "CHR-17",
  },
} as const;

export function HolographicFactionCard({ title, variant }: HolographicFactionCardProps) {
  const config = cardConfig[variant];

  return (
    <div className="duality-sticker">
      <HolographicSticker.Root>
        <HolographicSticker.Scene>
          <HolographicSticker.Card className="duality-card-frame" aspectRatio={0.82}>
            <span className="duality-edge-glow duality-edge-glow-top" />
            <span className="duality-edge-glow duality-edge-glow-right" />
            <span className="duality-edge-glow duality-edge-glow-bottom" />
            <span className="duality-edge-glow duality-edge-glow-left" />
            <HolographicSticker.ImageLayer src={config.image} alt={`${title} card background`} parallax />

            <HolographicSticker.Pattern
              textureUrl="https://assets.codepen.io/605876/figma-texture.png"
              opacity={0.32}
              mixBlendMode="hard-light"
              textureSize="5cqi"
            >
              <HolographicSticker.Refraction intensity={0.85} />
            </HolographicSticker.Pattern>

            <HolographicSticker.Watermark imageUrl="/duality-watermark.svg" opacity={0.34}>
              <HolographicSticker.Refraction intensity={0.65} />
            </HolographicSticker.Watermark>

            <HolographicSticker.Content className="duality-card-reveal">
              <div className="absolute inset-0 z-20 [clip-path:inset(0_0_0_0)] [filter:url(#hologram-lighting)]">
                <div className="absolute left-[7cqi] top-[7cqi] z-50 text-[2.1cqi] uppercase tracking-[0.34em] text-white/60">
                  {config.code}
                </div>

                <div className="absolute bottom-[16cqi] left-[7cqi] right-[7cqi] z-50">
                  <div
                    className="text-[9.4cqi] font-normal uppercase leading-[0.9] tracking-[-0.04em] text-white drop-shadow-[0_0_18px_rgba(255,255,255,0.38)] [filter:url(#hologram-sticker)]"
                    style={{ color: config.accent }}
                  >
                    {title}
                  </div>
                </div>

                <div className="absolute bottom-[5cqi] left-1/2 z-50 flex -translate-x-1/2 items-center gap-[1.8cqi] whitespace-nowrap text-[1.45cqi] uppercase tracking-[0.28em] text-white/70">
                  <span>DUALITY</span>
                  <span className="h-[1px] w-[7cqi] bg-white/45" />
                  <span>2026</span>
                </div>
              </div>
            </HolographicSticker.Content>

            <HolographicSticker.Spotlight intensity={0.58} />
            <HolographicSticker.Glare />
          </HolographicSticker.Card>
        </HolographicSticker.Scene>

        <svg className="sr-only" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <filter id="hologram-lighting">
              <feGaussianBlur in="SourceAlpha" stdDeviation="2" result="blur" />
              <feSpecularLighting
                result="lighting"
                in="blur"
                surfaceScale="7"
                specularConstant="8"
                specularExponent="90"
                lightingColor="hsl(0 0% 8%)"
              >
                <fePointLight x="50" y="50" z="260" />
              </feSpecularLighting>
              <feComposite in="lighting" in2="SourceAlpha" operator="in" result="composite" />
              <feComposite
                in="SourceGraphic"
                in2="composite"
                operator="arithmetic"
                k1="0"
                k2="1"
                k3="1"
                k4="0"
                result="litPaint"
              />
            </filter>
            <filter id="hologram-sticker">
              <feMorphology in="SourceAlpha" result="dilate" operator="dilate" radius="1.35" />
              <feFlood floodColor="hsl(0 0% 100%)" result="outlinecolor" />
              <feComposite in="outlinecolor" in2="dilate" operator="in" result="outlineflat" />
              <feMerge result="merged">
                <feMergeNode in="outlineflat" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
        </svg>
      </HolographicSticker.Root>
    </div>
  );
}

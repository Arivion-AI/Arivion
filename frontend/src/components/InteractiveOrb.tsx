"use client";

import { Bloom, EffectComposer } from "@react-three/postprocessing";
import { Canvas, useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import {
  AdditiveBlending,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  ShaderMaterial,
  Vector2,
} from "three";

type InteractiveOrbProps = {
  className?: string;
  sideRef?: React.MutableRefObject<number>;
  mouseRef?: React.MutableRefObject<Vector2>;
  hoverRef?: React.MutableRefObject<number>;
};

const ribbonVertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uHover;
  uniform vec2 uMouse;
  uniform float uIntensity;
  uniform float uSide;

  attribute float aT;
  attribute float aSide;
  attribute float aBand;

  varying float vEdge;
  varying float vT;
  varying float vBand;
  varying float vPulse;
  varying float vSideAlign;

  const float PI = 3.141592653589793;

  vec3 ribbonPath(float t, float band, float time) {
    float angle = t * PI * 2.0;
    float phase = band * 2.214;
    float drift = time * (0.18 + band * 0.025);
    float breathing = sin(angle * 3.0 + time * 1.35 + phase) * 0.12;
    breathing += sin(angle * 5.0 - time * 0.82 + phase * 1.7) * 0.055;

    float radius = 0.66 + breathing + uHover * 0.045;
    float twist = angle + phase + drift;
    float y = sin(angle * 2.0 + phase + time * 0.44) * 0.19;
    y += cos(angle * 3.0 - time * 0.28 + phase) * 0.07;

    return vec3(cos(twist) * radius, y, sin(twist) * radius);
  }

  void main() {
    vec3 p = ribbonPath(aT, aBand, uTime);
    vec3 nextP = ribbonPath(aT + 0.004, aBand, uTime);
    vec3 tangent = normalize(nextP - p);
    vec3 radial = normalize(p + vec3(0.0, 0.08, 0.0));
    vec3 normal = normalize(cross(tangent, radial));

    float sideMag = abs(uSide);
    float ribbonWidth = 0.052 + 0.018 * sin(aT * PI * 8.0 + aBand * 1.8 + uTime * 1.15);
    ribbonWidth *= 1.0 + uHover * 0.22 + sideMag * 0.22;

    float wave = sin(aT * PI * 18.0 + uTime * (1.4 + uHover * 0.6 + sideMag * 0.5) + aBand * 3.0);
    p += normal * aSide * ribbonWidth;
    p += radial * wave * (0.018 + uHover * 0.012 + sideMag * 0.014);

    // Side-bias: crowd ribbon points toward the active side. Points whose
    // x-direction already aligns with uSide get pushed outward; opposite side
    // gets pulled inward. Produces an asymmetric, side-skewed orb.
    float align = dot(normalize(p.xz), vec2(sign(uSide), 0.0));
    float crowd = align * sideMag;
    p.xz *= 1.0 + crowd * 0.22;
    p.x += uSide * 0.08;

    // Whole-orb drift toward stage cursor.
    vec3 mouseRay = normalize(vec3(uMouse.x * 0.85, uMouse.y * 0.85, 0.58));
    float cursorAffinity = pow(max(dot(normalize(p), mouseRay), 0.0), 3.0);
    p += mouseRay * cursorAffinity * uHover * 0.05;
    // Safety scale — keep the maximum geometry extent inside the canvas/soft-mask
    // radius. Loosened so the ribbons spread out further across the orb area.
    p *= 0.86;

    vEdge = 1.0 - abs(aSide);
    vT = aT;
    vBand = aBand;
    vPulse = cursorAffinity;
    vSideAlign = max(align, 0.0);

    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const ribbonFragmentShader = /* glsl */ `
  uniform float uTime;
  uniform float uHover;
  uniform float uIntensity;
  uniform float uSide;

  varying float vEdge;
  varying float vT;
  varying float vBand;
  varying float vPulse;
  varying float vSideAlign;

  void main() {
    vec3 blue = vec3(0.025, 0.32, 1.0);
    vec3 cyan = vec3(0.22, 0.94, 1.0);
    vec3 violet = vec3(0.58, 0.16, 1.0);
    vec3 white = vec3(0.94, 0.98, 1.0);
    vec3 gold = vec3(1.0, 0.78, 0.18);
    vec3 chrome = vec3(0.82, 0.93, 1.0);

    float flow = 0.5 + 0.5 * sin(vT * 18.0 - uTime * 2.25 + vBand * 2.7);
    float flare = pow(max(flow, 0.0), 5.0);
    vec3 color = mix(blue, violet, smoothstep(0.1, 0.95, flow));
    color = mix(color, cyan, 0.26 + vPulse * 0.35);

    float sideMag = abs(uSide);
    float goldMix = clamp(-uSide, 0.0, 1.0);
    float chromeMix = clamp(uSide, 0.0, 1.0);
    // Stronger tint where ribbons crowd to the active side.
    float tintBoost = mix(0.55, 1.0, vSideAlign);
    color = mix(color, gold, goldMix * 0.75 * tintBoost);
    color = mix(color, chrome, chromeMix * 0.6 * tintBoost);

    // White flare and alpha boost from side activation removed — the gold/chrome
    // tint already conveys the active state without the halo washing everything out.
    float sideAtten = 1.0 - sideMag * 0.55;
    color += white * flare * (0.22 + uHover * 0.06) * sideAtten;

    float edge = smoothstep(0.0, 0.82, vEdge);
    float alpha = edge * (0.15 + uIntensity * 0.16 + flare * 0.06);
    alpha *= (0.72 + uHover * 0.05) * sideAtten;

    gl_FragColor = vec4(color * (0.82 + uIntensity * 0.38) * sideAtten, alpha);
  }
`;

const particleVertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uHover;
  uniform vec2 uMouse;
  uniform float uIntensity;

  attribute float aT;
  attribute float aBand;
  attribute float aRadius;
  attribute float aSeed;

  varying float vLife;
  varying float vBand;

  const float PI = 3.141592653589793;

  vec3 haloPath(float t, float band, float time) {
    float angle = t * PI * 2.0;
    float phase = band * 1.93;
    float r = 0.44 + aRadius * 0.42;
    float x = cos(angle + phase + time * 0.24) * r;
    float z = sin(angle + phase + time * 0.24) * r;
    float y = sin(angle * 2.0 + phase + time * 0.55) * (0.13 + aRadius * 0.12);
    return vec3(x, y, z);
  }

  void main() {
    float localT = fract(aT + uTime * (0.018 + aSeed * 0.006));
    vec3 p = haloPath(localT, aBand, uTime);

    float shimmer = sin(localT * PI * 14.0 + aSeed * 8.0 + uTime * 1.9);
    p += normalize(p + vec3(0.001)) * shimmer * (0.035 + uHover * 0.012);

    vec3 mouseRay = normalize(vec3(uMouse.x * 0.85, uMouse.y * 0.85, 0.62));
    float pull = pow(max(dot(normalize(p), mouseRay), 0.0), 4.0) * uHover;
    p += mouseRay * pull * 0.045;
    p *= 0.88;

    vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    gl_PointSize = (7.0 + uHover * 1.4 + aSeed * 4.0) * (1.0 / -mvPosition.z);

    vLife = 0.46 + 0.54 * shimmer;
    vBand = aBand;
  }
`;

const particleFragmentShader = /* glsl */ `
  uniform float uHover;
  uniform float uIntensity;
  uniform float uSide;

  varying float vLife;
  varying float vBand;

  void main() {
    vec2 center = gl_PointCoord - vec2(0.5);
    float d = length(center);
    float alpha = smoothstep(0.5, 0.0, d) * 0.22 * (0.65 + uIntensity * 0.48);
    alpha *= 0.55 + vLife * 0.45 + uHover * 0.08;

    vec3 blue = vec3(0.05, 0.42, 1.0);
    vec3 cyan = vec3(0.30, 0.95, 1.0);
    vec3 violet = vec3(0.72, 0.16, 1.0);
    vec3 gold = vec3(1.0, 0.80, 0.22);
    vec3 chrome = vec3(0.84, 0.94, 1.0);

    vec3 color = mix(blue, violet, fract(vBand * 0.31));
    color = mix(color, cyan, vLife * 0.35);

    float goldMix = clamp(-uSide, 0.0, 1.0);
    float chromeMix = clamp(uSide, 0.0, 1.0);
    color = mix(color, gold, goldMix * 0.7);
    color = mix(color, chrome, chromeMix * 0.55);

    gl_FragColor = vec4(color * (0.88 + uIntensity * 0.34), alpha);
  }
`;

const coreVertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uHover;

  varying vec3 vNormal;
  varying vec3 vPosition;

  void main() {
    vec3 p = position;
    float pulse = sin(uTime * 2.2 + position.y * 5.0) * 0.018;
    p += normal * (pulse + uHover * 0.012);

    vNormal = normalize(normalMatrix * normal);
    vPosition = p;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const coreFragmentShader = /* glsl */ `
  uniform float uTime;
  uniform float uHover;
  uniform float uIntensity;
  uniform float uSide;

  varying vec3 vNormal;
  varying vec3 vPosition;

  void main() {
    float fresnel = pow(1.0 - abs(dot(vNormal, vec3(0.0, 0.0, 1.0))), 2.15);
    float pulse = 0.5 + 0.5 * sin(uTime * 3.0 + vPosition.y * 9.0);

    vec3 core = mix(vec3(0.08, 0.48, 1.0), vec3(0.72, 0.2, 1.0), pulse);
    core = mix(core, vec3(0.92, 0.98, 1.0), fresnel * 0.48 + uHover * 0.04);

    float goldMix = clamp(-uSide, 0.0, 1.0);
    float chromeMix = clamp(uSide, 0.0, 1.0);
    core = mix(core, vec3(1.0, 0.80, 0.22), goldMix * 0.65);
    core = mix(core, vec3(0.84, 0.94, 1.0), chromeMix * 0.55);

    float alpha = 0.28 + fresnel * 0.28 + uHover * 0.04;
    gl_FragColor = vec4(core * (1.0 + uIntensity * 0.42), alpha);
  }
`;

const glowFragmentShader = /* glsl */ `
  uniform float uTime;
  uniform float uHover;
  uniform float uIntensity;
  uniform float uSide;

  varying vec3 vNormal;
  varying vec3 vPosition;

  void main() {
    float fresnel = pow(1.0 - abs(dot(vNormal, vec3(0.0, 0.0, 1.0))), 3.35);
    float pulse = 0.5 + 0.5 * sin(uTime * 2.0 + vPosition.y * 7.0);

    vec3 blue = vec3(0.05, 0.38, 1.0);
    vec3 violet = vec3(0.65, 0.17, 1.0);
    vec3 color = mix(blue, violet, pulse);
    color += vec3(0.78, 0.95, 1.0) * fresnel * (0.44 + uHover * 0.08);

    float goldMix = clamp(-uSide, 0.0, 1.0);
    float chromeMix = clamp(uSide, 0.0, 1.0);
    color = mix(color, vec3(1.0, 0.78, 0.18), goldMix * 0.7);
    color = mix(color, vec3(0.82, 0.93, 1.0), chromeMix * 0.6);

    // Fresnel-gated alpha only — no constant baseline (that was filling the
    // canvas rect with a faint glow that bloomed into a visible box).
    // When a side is active, attenuate the outer glow heavily so the
    // ribbons read clearly instead of being washed out by halo bloom.
    float sideMag = abs(uSide);
    float sideAtten = 1.0 - sideMag * 0.85;
    float alpha = fresnel * (0.1 + uIntensity * 0.05 + uHover * 0.012) * sideAtten;
    gl_FragColor = vec4(color * (0.85 + uIntensity * 0.3) * sideAtten, alpha);
  }
`;

type OrbUniforms = {
  uTime: { value: number };
  uHover: { value: number };
  uMouse: { value: Vector2 };
  uIntensity: { value: number };
  uSide: { value: number };
};

function createUniforms(): OrbUniforms {
  return {
    uTime: { value: 0 },
    uHover: { value: 0 },
    uMouse: { value: new Vector2(0, 0) },
    uIntensity: { value: 0.78 },
    uSide: { value: 0 },
  };
}

type OrbSceneProps = {
  hoverTarget: React.MutableRefObject<number>;
  mouseTarget: React.MutableRefObject<Vector2>;
  sideTarget: React.MutableRefObject<number>;
};

function buildRibbonGeometry(bands = 5, segments = 220, widthSegments = 6) {
  const geometry = new BufferGeometry();
  const positions: number[] = [];
  const tValues: number[] = [];
  const sides: number[] = [];
  const bandValues: number[] = [];
  const indices: number[] = [];

  for (let band = 0; band < bands; band += 1) {
    const bandBase = (band / bands) * 5.0;
    const vertexOffset = positions.length / 3;

    for (let i = 0; i <= segments; i += 1) {
      const t = i / segments;

      for (let j = 0; j <= widthSegments; j += 1) {
        const side = (j / widthSegments) * 2 - 1;
        positions.push(0, 0, 0);
        tValues.push(t);
        sides.push(side);
        bandValues.push(bandBase);
      }
    }

    for (let i = 0; i < segments; i += 1) {
      for (let j = 0; j < widthSegments; j += 1) {
        const a = vertexOffset + i * (widthSegments + 1) + j;
        const b = a + widthSegments + 1;
        indices.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
  }

  geometry.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute("aT", new BufferAttribute(new Float32Array(tValues), 1));
  geometry.setAttribute("aSide", new BufferAttribute(new Float32Array(sides), 1));
  geometry.setAttribute("aBand", new BufferAttribute(new Float32Array(bandValues), 1));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();

  return geometry;
}

function buildParticleGeometry(count = 1300) {
  const geometry = new BufferGeometry();
  const positions = new Float32Array(count * 3);
  const tValues = new Float32Array(count);
  const bands = new Float32Array(count);
  const radii = new Float32Array(count);
  const seeds = new Float32Array(count);

  for (let i = 0; i < count; i += 1) {
    positions[i * 3] = 0;
    positions[i * 3 + 1] = 0;
    positions[i * 3 + 2] = 0;
    tValues[i] = Math.random();
    bands[i] = Math.random() * 5.0;
    radii[i] = Math.pow(Math.random(), 1.6);
    seeds[i] = Math.random();
  }

  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.setAttribute("aT", new BufferAttribute(tValues, 1));
  geometry.setAttribute("aBand", new BufferAttribute(bands, 1));
  geometry.setAttribute("aRadius", new BufferAttribute(radii, 1));
  geometry.setAttribute("aSeed", new BufferAttribute(seeds, 1));

  return geometry;
}

function OrbScene({ hoverTarget, mouseTarget, sideTarget }: OrbSceneProps) {
  const smoothedHover = useRef(0);
  const smoothedMouse = useRef(new Vector2(0, 0));
  const smoothedSide = useRef(0);
  const clockTime = useRef(0);
  const ribbonMaterial = useRef<ShaderMaterial>(null);
  const particleMaterial = useRef<ShaderMaterial>(null);
  const coreMaterial = useRef<ShaderMaterial>(null);
  const glowMaterial = useRef<ShaderMaterial>(null);
  const groupRef = useRef<Group>(null);

  const ribbonGeometry = useMemo(() => buildRibbonGeometry(), []);
  const particleGeometry = useMemo(() => buildParticleGeometry(), []);
  const ribbonUniforms = useMemo(() => createUniforms(), []);
  const particleUniforms = useMemo(() => createUniforms(), []);
  const coreUniforms = useMemo(() => createUniforms(), []);
  const glowUniforms = useMemo(() => createUniforms(), []);

  useFrame((_state, delta) => {
    // Clamp delta — when the tab is backgrounded or the browser hitches,
    // a single useFrame can fire with a multi-second delta. That jumps the
    // shader clock forward and shoves the easing past its target, which the
    // smoothing then has to chase back — visible as a one-off jitter/flash.
    const dt = Math.min(delta, 0.05);
    const hoverEase = 1 - Math.exp(-dt * 3.2);
    const mouseEase = 1 - Math.exp(-dt * 2.4);
    const sideEase = 1 - Math.exp(-dt * 3.6);

    smoothedHover.current += (hoverTarget.current - smoothedHover.current) * hoverEase;
    smoothedMouse.current.lerp(mouseTarget.current, mouseEase);
    smoothedSide.current += (sideTarget.current - smoothedSide.current) * sideEase;

    clockTime.current += dt * (0.58 + smoothedHover.current * 0.62);

    for (const material of [
      ribbonMaterial.current,
      particleMaterial.current,
      coreMaterial.current,
      glowMaterial.current,
    ]) {
      if (!material) {
        continue;
      }

      const uniforms = material.uniforms as OrbUniforms;
      uniforms.uTime.value = clockTime.current;
      uniforms.uHover.value = smoothedHover.current;
      uniforms.uIntensity.value = 0.72 + smoothedHover.current * 0.12;
      uniforms.uMouse.value.copy(smoothedMouse.current);
      uniforms.uSide.value = smoothedSide.current;
    }

    if (groupRef.current) {
      // Subtle whole-orb drift toward the cursor across the entire stage.
      // Kept small so the orb stays inside the canvas mask even at full reach.
      groupRef.current.position.x = smoothedMouse.current.x * 0.14;
      groupRef.current.position.y = smoothedMouse.current.y * 0.09;
      groupRef.current.rotation.y =
        -0.38 + smoothedMouse.current.x * 0.14 + smoothedSide.current * 0.1;
      groupRef.current.rotation.x = 0.28 - smoothedMouse.current.y * 0.08;
    }
  });

  return (
    <group ref={groupRef} rotation={[0.28, -0.38, 0.12]} scale={1.02}>
      <points geometry={particleGeometry}>
        <shaderMaterial
          ref={particleMaterial}
          uniforms={particleUniforms}
          vertexShader={particleVertexShader}
          fragmentShader={particleFragmentShader}
          transparent
          depthWrite={false}
          blending={AdditiveBlending}
        />
      </points>
      <mesh geometry={ribbonGeometry}>
        <shaderMaterial
          ref={ribbonMaterial}
          uniforms={ribbonUniforms}
          vertexShader={ribbonVertexShader}
          fragmentShader={ribbonFragmentShader}
          transparent
          depthWrite={false}
          blending={AdditiveBlending}
          side={DoubleSide}
        />
      </mesh>
      <mesh scale={0.52}>
        <sphereGeometry args={[0.5, 48, 48]} />
        <shaderMaterial
          ref={glowMaterial}
          uniforms={glowUniforms}
          vertexShader={coreVertexShader}
          fragmentShader={glowFragmentShader}
          transparent
          depthWrite={false}
          blending={AdditiveBlending}
          side={BackSide}
        />
      </mesh>
      <mesh scale={0.34}>
        <sphereGeometry args={[0.5, 48, 48]} />
        <shaderMaterial
          ref={coreMaterial}
          uniforms={coreUniforms}
          vertexShader={coreVertexShader}
          fragmentShader={coreFragmentShader}
          transparent
          depthWrite={false}
          side={DoubleSide}
        />
      </mesh>
    </group>
  );
}

export function InteractiveOrb({
  className = "h-screen w-screen",
  sideRef,
  mouseRef,
  hoverRef,
}: InteractiveOrbProps) {
  const localHoverRef = useRef(0);
  const localMouseRef = useRef(new Vector2(0, 0));
  const localSideRef = useRef(0);
  // When the stage provides refs, use them so the orb reacts to cursor across
  // the whole stage. Otherwise fall back to local pointer events on the slot.
  const hoverTarget = hoverRef ?? localHoverRef;
  const mouseTarget = mouseRef ?? localMouseRef;
  const sideTarget = sideRef ?? localSideRef;
  const usesExternal = !!(hoverRef && mouseRef);

  return (
    <div
      className={className}
      onPointerMove={(event) => {
        if (usesExternal) return;
        const rect = event.currentTarget.getBoundingClientRect();
        const x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        const y = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
        const distance = Math.hypot(x, y);
        const nearCenter = Math.max(0, 1 - distance / 0.72);

        mouseTarget.current.set(x * 0.55, y * 0.55);
        hoverTarget.current = nearCenter * nearCenter;
      }}
      onPointerLeave={() => {
        if (usesExternal) return;
        hoverTarget.current = 0;
        mouseTarget.current.set(0, 0);
      }}
    >
      <Canvas
        camera={{ position: [0, 0, 3.15], fov: 42 }}
        dpr={[1, 1.75]}
        gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
        style={{ background: "transparent" }}
        onCreated={({ gl: renderer }) => {
          renderer.setClearColor(0x000000, 0);
        }}
      >
        <ambientLight intensity={0.18} />
        <pointLight position={[1.2, 1.4, 2.2]} intensity={2.2} color="#6ee7ff" />
        <pointLight position={[-1.4, -0.8, 1.8]} intensity={1.2} color="#a855f7" />
        <OrbScene hoverTarget={hoverTarget} mouseTarget={mouseTarget} sideTarget={sideTarget} />
        <EffectComposer multisampling={0}>
          <Bloom intensity={0.28} luminanceThreshold={0.45} luminanceSmoothing={0.65} mipmapBlur />
        </EffectComposer>
      </Canvas>
    </div>
  );
}

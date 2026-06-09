import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./../config.js";
import { GatewayError } from "./types.js";

// BYOK key handling (Phase 12). In v1 BYOK is feature-flagged OFF; this module exists so the gateway
// has a single, safe home for key fingerprinting and the provider allowlist. No raw key is ever
// logged or returned (corrections #5, #6).

// Allowlisted provider registry (correction #6). Custom OpenAI-compatible base URLs are DISABLED in
// v1 until SSRF protection + egress allowlisting exist — only these provider ids are permitted.
export const PROVIDER_REGISTRY: Record<string, { label: string; managed: boolean }> = {
  mock: { label: "Mock (deterministic, local/test only)", managed: true },
  openai: { label: "OpenAI", managed: true },
  anthropic: { label: "Anthropic", managed: true },
};

export function assertAllowlistedProvider(provider: string): void {
  if (!PROVIDER_REGISTRY[provider]) {
    throw new GatewayError("PROVIDER_NOT_ALLOWLISTED", `provider '${provider}' is not in the registry`, 400);
  }
}

// HMAC fingerprint (correction #5): HMAC_SHA256(secret, provider + ":" + raw_key). NOT raw SHA256.
// Used to detect duplicate keys and to reference a key without ever storing/logging the raw value.
export function keyFingerprint(provider: string, rawKey: string): string {
  if (!config.keyFingerprintSecret) {
    throw new GatewayError("KEY_FINGERPRINT_SECRET_MISSING", "COPILOT_KEY_FINGERPRINT_SECRET is not set", 500);
  }
  return createHmac("sha256", config.keyFingerprintSecret).update(`${provider}:${rawKey}`).digest("hex");
}

export function fingerprintsEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

// Hard gate for any BYOK code path. Throws unless BYOK is enabled AND (in prod) KMS is configured.
export function assertByokEnabled(): void {
  if (!config.byokEnabled) {
    throw new GatewayError("BYOK_DISABLED", "BYOK is disabled in this deployment (managed credits only)", 403);
  }
  if (config.isProd && !config.kmsKeyId) {
    throw new GatewayError("BYOK_KMS_REQUIRED", "BYOK requires KMS in production", 500);
  }
}

import { config } from "../config.js";
import { PROVIDER_REGISTRY } from "./keyVault.js";

// Lightweight provider availability/health. "configured" means we have what we need to call it in
// managed mode (a key, or none required for mock). This drives catalog availability + the agent
// health route. It does NOT make network calls (no cost, no rate-limit exposure).

export interface ProviderHealth {
  provider: string;
  label: string;
  configured: boolean;
}

export function providerHealth(): ProviderHealth[] {
  return Object.entries(PROVIDER_REGISTRY).map(([provider, meta]) => ({
    provider,
    label: meta.label,
    configured: isConfigured(provider),
  }));
}

export function isConfigured(provider: string): boolean {
  switch (provider) {
    case "mock":
      return true;
    case "openai":
      return Boolean(config.openaiApiKey || config.litellmProxyUrl);
    case "anthropic":
      return Boolean(config.anthropicApiKey || config.litellmProxyUrl);
    default:
      return false;
  }
}

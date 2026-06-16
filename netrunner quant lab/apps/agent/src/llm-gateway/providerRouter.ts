import { config } from "../config.js";
import { GatewayError, type ChatMessage, type ProviderResponse, type ToolSpec } from "./types.js";
import { estimateTokensFromMessages } from "./creditMeter.js";

// Provider adapters. They ONLY call a model and normalize usage — they never touch credits
// (correction #1: credit logic lives only in the gateway). Adding a provider here is the ONLY way
// to make a new model callable; nothing else in the system may call a provider SDK directly.
//
// NOTE (correction #8): the Venice AI/Anthropic request/response shapes below should be re-verified
// against current official docs before production billing. The 'mock' provider is fully
// deterministic and is what the test suite exercises (no network, no API key).

export interface ProviderCallArgs {
  provider: string;
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  maxTokens: number;
  metadata?: Record<string, unknown>;
}

// Thrown to signal the gateway should bill ESTIMATED metering (usage unknown). Carries no usage.
export class ProviderTimeoutError extends GatewayError {
  constructor(message?: string) {
    super("PROVIDER_TIMEOUT", message ?? "provider timed out before reporting usage", 504);
  }
}

export async function execute(args: ProviderCallArgs): Promise<ProviderResponse> {
  switch (args.provider) {
    case "mock":
      return executeMock(args);
    case "anthropic":
      return executeAnthropic(args);
    case "venice":
      return executeVenice(args);
    default:
      throw new GatewayError("PROVIDER_NOT_SUPPORTED", `no adapter for provider '${args.provider}'`, 400);
  }
}

// --- Mock (deterministic) --------------------------------------------------------------------
// Test hooks via metadata.mock: { error?: true, timeout?: true, outputTokens?, content? }.
function executeMock(args: ProviderCallArgs): ProviderResponse {
  const hook = (args.metadata?.mock ?? {}) as {
    error?: boolean;
    timeout?: boolean;
    outputTokens?: number;
    content?: string;
  };
  if (hook.error) throw new GatewayError("PROVIDER_ERROR", "mock provider error (pre-token)", 502);
  if (hook.timeout) throw new ProviderTimeoutError("mock timeout");

  const lastUser = [...args.messages].reverse().find((m) => m.role === "user");
  const content = hook.content ?? `echo: ${lastUser?.content ?? ""}`;
  const inputTokens = estimateTokensFromMessages(args.messages);
  const outputTokens = Math.min(hook.outputTokens ?? Math.ceil(content.length / 4), args.maxTokens);
  return {
    content,
    usage: {
      input_tokens: inputTokens,
      cached_input_tokens: 0,
      output_tokens: outputTokens,
      reasoning_tokens: 0,
      tool_call_count: 0,
      provider_request_id: "mock-" + Math.abs(hashString(content)).toString(16),
      latency_ms: 1,
    },
  };
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

// --- Venice AI (chat completions) ------------------------------------------------------------
// veniceBaseUrl ALREADY ends in /api/v1, so call `${base}/chat/completions` with no extra /v1.
// Only models whose /models capabilities report supportsFunctionCalling=true will honor `tools`.
async function executeVenice(args: ProviderCallArgs): Promise<ProviderResponse> {
  if (!config.veniceApiKey) throw new GatewayError("PROVIDER_NOT_CONFIGURED", "VENICE_API_KEY not set", 503);
  const base = config.veniceBaseUrl;
  const started = Date.now();
  let resp: Response;
  try {
    resp = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.veniceApiKey}` },
      body: JSON.stringify({
        model: args.model,
        messages: args.messages.map((m) => {
          if (m.role === "assistant" && m.tool_calls?.length) {
            return { role: "assistant", content: m.content || null, tool_calls: m.tool_calls.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: t.arguments } })) };
          }
          if (m.role === "tool") return { role: "tool", tool_call_id: m.tool_call_id, content: m.content };
          return { role: m.role, content: m.content, name: m.name };
        }),
        max_tokens: args.maxTokens,
        // The Copilot supplies its own system prompt; suppress Venice's default injected prompt so we
        // don't pay for ~1.6k tokens of unused preamble on every call.
        venice_parameters: { include_venice_system_prompt: false },
        ...(args.tools?.length
          ? { tools: args.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters ?? {} } })) }
          : {}),
      }),
    });
  } catch (e) {
    throw new ProviderTimeoutError((e as Error).message);
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new GatewayError("PROVIDER_ERROR", `venice ${resp.status}: ${body.slice(0, 200)}`, 502);
  }
  const json = (await resp.json()) as any;
  const choice = json.choices?.[0]?.message ?? {};
  const u = json.usage ?? {};
  return {
    content: typeof choice.content === "string" ? choice.content : "",
    toolCalls: (choice.tool_calls ?? []).map((tc: any) => ({
      id: tc.id, name: tc.function?.name, arguments: tc.function?.arguments ?? "{}",
    })),
    usage: {
      input_tokens: Number(u.prompt_tokens ?? 0),
      cached_input_tokens: Number(u.prompt_tokens_details?.cached_tokens ?? 0),
      output_tokens: Number(u.completion_tokens ?? 0),
      reasoning_tokens: Number(u.completion_tokens_details?.reasoning_tokens ?? 0),
      tool_call_count: (choice.tool_calls ?? []).length,
      provider_request_id: json.id,
      latency_ms: Date.now() - started,
    },
  };
}

// --- Embeddings ------------------------------------------------------------------------------
export interface EmbedResult {
  vector: number[];
  inputTokens: number;
  provider_request_id?: string;
  latency_ms: number;
}

// Embed text into a vector. Like the chat adapters this only calls the provider + normalizes usage;
// the gateway owns credit movement.
export async function embed(provider: string, model: string, text: string): Promise<EmbedResult> {
  if (provider !== "venice") {
    throw new GatewayError("PROVIDER_NOT_SUPPORTED", `no embedding adapter for provider '${provider}'`, 400);
  }
  if (!config.veniceApiKey) throw new GatewayError("PROVIDER_NOT_CONFIGURED", "VENICE_API_KEY not set", 503);
  const base = config.veniceBaseUrl;
  const started = Date.now();
  let resp: Response;
  try {
    resp = await fetch(`${base}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.veniceApiKey}` },
      body: JSON.stringify({ model, input: text.slice(0, 32000), dimensions: config.embeddingDim }),
    });
  } catch (e) {
    throw new ProviderTimeoutError((e as Error).message);
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new GatewayError("PROVIDER_ERROR", `venice embeddings ${resp.status}: ${body.slice(0, 200)}`, 502);
  }
  const json = (await resp.json()) as any;
  const vector: number[] = json.data?.[0]?.embedding ?? [];
  return {
    vector,
    inputTokens: Number(json.usage?.prompt_tokens ?? 0),
    provider_request_id: json.id,
    latency_ms: Date.now() - started,
  };
}

// --- Anthropic (messages) --------------------------------------------------------------------
async function executeAnthropic(args: ProviderCallArgs): Promise<ProviderResponse> {
  if (!config.anthropicApiKey) throw new GatewayError("PROVIDER_NOT_CONFIGURED", "ANTHROPIC_API_KEY not set", 503);
  const base = config.litellmProxyUrl ?? "https://api.anthropic.com";
  const system = args.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  const turns = args.messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role, content: m.content }));
  const started = Date.now();
  let resp: Response;
  try {
    resp = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.anthropicApiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model: args.model, max_tokens: args.maxTokens, system: system || undefined, messages: turns }),
    });
  } catch (e) {
    throw new ProviderTimeoutError((e as Error).message);
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new GatewayError("PROVIDER_ERROR", `anthropic ${resp.status}: ${body.slice(0, 200)}`, 502);
  }
  const json = (await resp.json()) as any;
  const content = (json.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
  const u = json.usage ?? {};
  return {
    content,
    usage: {
      input_tokens: Number(u.input_tokens ?? 0) + Number(u.cache_read_input_tokens ?? 0),
      cached_input_tokens: Number(u.cache_read_input_tokens ?? 0),
      output_tokens: Number(u.output_tokens ?? 0),
      reasoning_tokens: 0,
      tool_call_count: 0,
      provider_request_id: json.id,
      latency_ms: Date.now() - started,
    },
  };
}

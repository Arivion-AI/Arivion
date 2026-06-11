import { z } from "zod";
import { Registrar, textResult, describeShape } from "./registry.js";
import * as kb from "../kb/index.js";

export function registerMetaTools(r: Registrar): void {
  r.tool(
    "meta",
    "list_capabilities",
    "The master menu: every tool grouped by domain, plus the catalogs/resources/prompts available. Call this first.",
    {},
    () => {
      const byDomain: Record<string, { name: string; description: string }[]> = {};
      for (const c of r.capabilities) {
        (byDomain[c.domain] ??= []).push({ name: c.name, description: c.description });
      }
      return textResult({
        summary: "Duality Netrunner Quant Lab — agent toolbox.",
        howToDiscover: {
          parameters: "Use get_param_help {kind,id} to see params/defaults/ranges/enums for any strategy/bot/subsystem.",
          errors: "Use explain_error {code} to decode any failure code into cause + fix.",
          tools: "Use describe_tool {tool} for one tool's input schema.",
          reference: "Browse the duality://catalog/* and duality://reference/* resources.",
        },
        toolsByDomain: byDomain,
        catalogs: {
          strategies: kb.strategyIds(),
          bots: kb.botIds(),
          portfolioWeighting: kb.PORTFOLIO_REFERENCE.weightingSchemes,
          optimizerMethods: kb.OPTIMIZER_REFERENCE.methods,
          fillModes: Object.keys(kb.FILL_MODEL_REFERENCE.modes),
          regimes: kb.RECOMMENDER_REFERENCE.regimes,
          xstocks: kb.XSTOCKS_REFERENCE.catalog,
          tiers: kb.TIERS,
        },
        totalTools: r.capabilities.length,
      });
    }
  );

  r.tool(
    "meta",
    "describe_tool",
    "Full input schema (field names, types, optionality) for one tool, plus related discovery hints.",
    { tool: z.string().describe("Tool name, e.g. run_bot_backtest") },
    (args) => {
      const name = String(args.tool);
      const shape = r.schemas[name];
      if (!shape) {
        return textResult({ error: `unknown tool '${name}'`, available: r.capabilities.map((c) => c.name) });
      }
      const cap = r.capabilities.find((c) => c.name === name);
      return textResult({ tool: name, domain: cap?.domain, description: cap?.description, inputs: describeShape(shape) });
    }
  );

  r.tool(
    "meta",
    "get_param_help",
    "The 'which value goes here?' tool. Returns params/defaults/ranges/enums/units + verified-tier implications for a strategy, bot, or subsystem.",
    {
      kind: z
        .enum(kb.PARAM_KINDS as [string, ...string[]])
        .describe("strategy | bot | run_common | portfolio_weighting | optimizer | venue | fill_model | risk_tolerance | recommender | risk_cockpit | xstocks"),
      id: z.string().optional().describe("For kind=strategy|bot, the id (e.g. futures_martingale). Omit to list all."),
    },
    (args) => textResult(kb.paramHelp(args.kind as kb.ParamKind, args.id as string | undefined))
  );

  r.tool(
    "meta",
    "explain_error",
    "Decode any machine error / eligibility / hard-block / recovery / tier-downgrade code into meaning + fix + related params.",
    { code: z.string().describe("e.g. RUIN_MARGIN_EXCEEDS_CAPITAL") },
    (args) => {
      const code = String(args.code);
      const help = kb.explainCode(code);
      if (!help) return textResult({ code, found: false, knownCodes: Object.keys(kb.ERROR_CODES) });
      return textResult({ code, ...help });
    }
  );

  r.tool(
    "meta",
    "get_env_reference",
    "Environment variables (default + meaning) for a lab service.",
    { service: z.string().optional().describe("api | worker | data-ingestor | verifier | mcp (this server). Omit for all.") },
    (args) => {
      const svc = args.service as string | undefined;
      if (svc) {
        const key = Object.keys(kb.ENV_REFERENCE).find((k) => k.startsWith(svc));
        return textResult(key ? { [key]: kb.ENV_REFERENCE[key] } : { error: `unknown service '${svc}'`, available: Object.keys(kb.ENV_REFERENCE) });
      }
      return textResult(kb.ENV_REFERENCE);
    }
  );

  r.tool(
    "meta",
    "health",
    "Fan-out health check across api/worker/verifier/sandbox/ingestor + data staleness.",
    {},
    async () => {
      const results: Record<string, unknown> = {};
      const probe = async (label: string, p: Promise<unknown>) => {
        try {
          results[label] = await p;
        } catch (e) {
          results[label] = { error: (e as Error).message };
        }
      };
      await Promise.all([
        probe("api", r.clients.api.get("/health", undefined, r.ctx())),
        probe("data_health", r.clients.api.get("/api/data/health", undefined, r.ctx())),
        ...(r.cfg.enableInternal
          ? [
              probe("verifier", r.clients.verifier.get("/health")),
              probe("ingestor", r.clients.ingestor.get("/health")),
              probe("sandbox", r.clients.sandbox.get("/health")),
            ]
          : []),
      ]);
      return textResult(results);
    }
  );
}

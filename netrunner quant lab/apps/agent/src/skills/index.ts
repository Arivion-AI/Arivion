import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../logger.js";

// Loads the agent's operating skill (full Duality/MCP/platform context) once at import. The skill is a
// stable system-prompt prefix — with provider prompt caching this stays cheap to send on every turn.

let cached: string | null = null;

export function getSkill(): string {
  if (cached !== null) return cached;
  try {
    const here = dirname(fileURLToPath(import.meta.url)); // apps/agent/src/skills
    const path = resolve(here, "../../skills/duality-lab.skill.md"); // apps/agent/skills/...
    cached = readFileSync(path, "utf8");
    logger.info("loaded agent skill", { bytes: cached.length });
  } catch (e) {
    logger.warn("agent skill not found — running with base prompt only", { message: (e as Error).message });
    cached = "";
  }
  return cached;
}

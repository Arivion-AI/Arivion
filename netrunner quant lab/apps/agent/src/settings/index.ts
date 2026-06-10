import { db } from "../db.js";
import { config } from "../config.js";

// Per-owner governance: autonomy level + kill switches. Phase 4/5. A row is lazily created with safe
// defaults (autonomy L1, everything enabled). The GLOBAL kill switch is an env-level emergency stop.

export type AutonomyLevel = "L0" | "L1" | "L1_5_shadow" | "L2" | "L3";
export const AUTONOMY_RANK: Record<string, number> = { L0: 0, L1: 1, L1_5_shadow: 1.5, L2: 2, L3: 3 };

export interface OwnerSettings {
  owner_id: number;
  autonomy_level: AutonomyLevel;
  agent_enabled: boolean;
  disable_triggers: boolean;
  disable_web: boolean;
  disable_memory_writes: boolean;
  disable_live_paper_start: boolean;
  contribute_global: boolean;
}

export async function getOwnerSettings(ownerId: number): Promise<OwnerSettings> {
  const r = await db.query(`SELECT * FROM agent_owner_settings WHERE owner_id=$1`, [ownerId]);
  if (r.rowCount) return r.rows[0] as OwnerSettings;
  const ins = await db.query(
    `INSERT INTO agent_owner_settings (owner_id) VALUES ($1)
     ON CONFLICT (owner_id) DO UPDATE SET updated_at = now() RETURNING *`,
    [ownerId],
  );
  return ins.rows[0] as OwnerSettings;
}

export async function updateOwnerSettings(ownerId: number, patch: Partial<OwnerSettings>): Promise<OwnerSettings> {
  await getOwnerSettings(ownerId);
  const r = await db.query(
    `UPDATE agent_owner_settings SET
       autonomy_level           = COALESCE($2, autonomy_level),
       agent_enabled            = COALESCE($3, agent_enabled),
       disable_triggers         = COALESCE($4, disable_triggers),
       disable_web              = COALESCE($5, disable_web),
       disable_memory_writes    = COALESCE($6, disable_memory_writes),
       disable_live_paper_start = COALESCE($7, disable_live_paper_start),
       contribute_global        = COALESCE($8, contribute_global),
       updated_at = now()
     WHERE owner_id=$1 RETURNING *`,
    [
      ownerId, patch.autonomy_level ?? null, patch.agent_enabled ?? null, patch.disable_triggers ?? null,
      patch.disable_web ?? null, patch.disable_memory_writes ?? null, patch.disable_live_paper_start ?? null,
      patch.contribute_global ?? null,
    ],
  );
  return r.rows[0] as OwnerSettings;
}

export function globalKillActive(): boolean {
  return config.globalKillSwitch;
}

// Kill-switch state for the API (global + per-owner granular).
export async function killSwitchState(ownerId: number): Promise<Record<string, unknown>> {
  const s = await getOwnerSettings(ownerId);
  return {
    global: globalKillActive(),
    per_owner: !s.agent_enabled,
    granular: {
      disable_triggers: s.disable_triggers,
      disable_web: s.disable_web,
      disable_memory_writes: s.disable_memory_writes,
      disable_live_paper_start: s.disable_live_paper_start,
    },
    autonomy_level: s.autonomy_level,
  };
}

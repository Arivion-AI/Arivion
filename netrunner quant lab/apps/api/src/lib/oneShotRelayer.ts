// 1Shot permissionless relayer client (EIP-7710 / EIP-7702, gas paid in stablecoins).
// JSON-RPC 2.0 over HTTP to https://relayer.1shotapi.com/relayers — keyless/permissionless.
// Shapes are taken verbatim from the authoritative OpenRPC spec
// (https://www.1shotapi.com/openrpc/openrpc.json, "1Shot Relayer JSON-RPC API 1.0.0"):
//   relayer_getCapabilities([chainId]) -> { [chainId]: { feeCollector, targetAddress, tokens[] } }
//   relayer_getFeeData({chainId, token}) -> { gasPrice, rate, minFee, feeCollector, targetAddress, context, expiry }
//   relayer_estimate7710Transaction(params) -> { success, requiredPaymentAmount, gasUsed, context, error }
//   relayer_send7710Transaction(params) -> TaskId (0x..64)
//   relayer_getStatus([taskId]) -> { status: 100|110|200|400|500, hash?, receipt?, message? }
// The relayer is the redeemer: the LAST delegation in `permissionContext` must delegate to the
// chain's `targetAddress`. The user EOA is upgraded in-flight via `authorizationList` (EIP-7702).

const RELAYER_URL = process.env.ONESHOT_RELAYER_URL ?? "https://relayer.1shotapi.com/relayers";

export interface Delegation7710 {
  delegate: string;
  delegator: string;
  authority: string;
  caveats: Array<{ enforcer: string; terms: string; args: string }>;
  salt: string;
  signature: string;
}
export interface Execution7710 { target: string; value: string; data: string }
export interface Authorization7702 { address: string; chainId: number | string; nonce: number | string; r: string; s: string; yParity: number | string }

export interface FeeData {
  chainId: string;
  token: { address: string; decimals: number | string; symbol?: string; name?: string };
  gasPrice: string;
  rate: number;
  minFee: string;
  expiry: number;
  feeCollector: string;
  targetAddress?: string;
  context?: string;
}
export interface Capabilities {
  feeCollector: string;
  targetAddress: string;
  tokens: Array<{ address: string; symbol?: string; decimals: number | string }>;
}
export interface EstimateResult {
  success: boolean;
  paymentTokenAddress?: string;
  paymentChain?: number;
  gasUsed: Record<string, string>;
  requiredPaymentAmount?: string;
  context?: string;
  error?: string;
}

export interface Send7710Params {
  chainId: string;
  transactions: Array<{ permissionContext: Delegation7710[]; executions: Execution7710[] }>;
  authorizationList?: Authorization7702[];
  context?: string;        // signed fee-lock from estimate/getFeeData
  taskId?: string;         // client-supplied bytes32 for idempotency
  destinationUrl?: string; // webhook
  memo?: string;
}

// Status codes (terminal: 200 confirmed, 400 rejected, 500 reverted; non-terminal: 100 pending, 110 submitted).
export type StatusResult = {
  id: string; chainId: string; status: number; createdAt?: number; memo?: string;
  hash?: string; receipt?: Record<string, unknown>; message?: string; data?: string;
};
export const STATUS = { PENDING: 100, SUBMITTED: 110, CONFIRMED: 200, REJECTED: 400, REVERTED: 500 } as const;
export const isTerminal = (s: number): boolean => s >= 200;

class OneShotError extends Error {
  constructor(public code: number | string, message: string, public data?: unknown) { super(message); }
}

let rpcId = 0;
async function call<T>(method: string, params: unknown): Promise<T> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params });
  let resp: Response;
  try {
    resp = await fetch(RELAYER_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body });
  } catch (e) {
    throw new OneShotError("NETWORK", `1Shot relayer unreachable: ${(e as Error).message}`);
  }
  if (!resp.ok) throw new OneShotError(resp.status, `1Shot HTTP ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 200)}`);
  const json = (await resp.json()) as { result?: T; error?: { code: number; message: string; data?: unknown } };
  if (json.error) throw new OneShotError(json.error.code, `1Shot ${method}: ${json.error.message}`, json.error.data);
  return json.result as T;
}

export async function getCapabilities(chainId: number | string): Promise<Capabilities | undefined> {
  const cid = String(chainId);
  const res = await call<Record<string, Capabilities>>("relayer_getCapabilities", [cid]);
  return res?.[cid];
}

export async function getFeeData(chainId: number | string, token: string): Promise<FeeData> {
  return call<FeeData>("relayer_getFeeData", { chainId: String(chainId), token });
}

export async function estimate7710(params: Omit<Send7710Params, "taskId">): Promise<EstimateResult> {
  return call<EstimateResult>("relayer_estimate7710Transaction", params);
}

/** Submit a delegated bundle. Returns the TaskId. Poll getStatus until terminal (or use the webhook). */
export async function send7710(params: Send7710Params): Promise<string> {
  return call<string>("relayer_send7710Transaction", params);
}

export async function getStatus(taskId: string, logs = false): Promise<StatusResult> {
  // Param shape per OpenRPC: [{ id, logs }] (NOT a bare taskId).
  return call<StatusResult>("relayer_getStatus", [{ id: taskId, logs }]);
}

/** Poll getStatus until terminal or timeout. Returns the final status row. */
export async function waitForStatus(taskId: string, opts?: { timeoutMs?: number; intervalMs?: number }): Promise<StatusResult> {
  const timeoutMs = opts?.timeoutMs ?? 120_000;
  const intervalMs = opts?.intervalMs ?? 2500;
  const deadline = Date.now() + timeoutMs;
  let last: StatusResult | undefined;
  while (Date.now() < deadline) {
    last = await getStatus(taskId).catch((e) => ({ id: taskId, chainId: "", status: -1, message: (e as Error).message }));
    if (last && isTerminal(last.status)) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return last ?? { id: taskId, chainId: "", status: -1, message: "timeout" };
}

export { OneShotError };

# GMX v2 → 1Shot Permissionless Relayer adapter

Goal: execute a **real GMX v2 perp order** as an EIP-7710 delegated execution **relayed by 1Shot**
(gas in USDC), instead of GMX's native Gelato express relay. This makes the GMX leg of the cross-chain
plan ride 1Shot like the LP and CCTP legs do.

Status: **mechanism fully reverse-engineered + feasibility re-confirmed. Adapter + live test in
progress.** This doc is the running record.

---

## 1. Why GMX was "native relay only" before

`@gmx-io/sdk`'s public, documented entry point is `executeExpressOrder`, which is **bound to GMX's own
Gelato relay** (it `prepareOrder` → signs typed data → `submitOrder` to GMX's relay API). It does not
hand you a plain `{to, data, value}` you can redeem through `DelegationManager.redeemDelegations`. So
the earlier decision was: GMX stays on its native relay; 1Shot serves LP + plain calls.

That was a *delivery-risk* choice, not an impossibility. This doc removes it.

## 2. Feasibility — re-confirmed (free, estimate-only)

A GMX v2 order is `ExchangeRouter.multicall([sendWnt(executionFee), sendTokens(collateral), createOrder(params)])`
— a contract call that carries **native ETH `value`** (GMX's keeper execution fee). The only
1Shot-specific unknown was: *can a 1Shot-redeemed execution carry native ETH value?*

`scripts/gmx-1shot-feasibility.mjs` builds a native-token-scoped delegation + a value-carrying
execution and calls `relayer_estimate7710Transaction`. Latest run (2026-06-16):

```
estimate: {"success":false, "error":"No valid payments to the feeAddress were found in the transaction calldata."}
```

This is **not** a rejection of the value-carrying execution. The relayer validated the delegation and
the native-value execution and only stopped because the test bundle omits the USDC fee leg to the
feeCollector. The canonical `submitDelegatedBundle` always appends that fee transfer (getFeeData →
estimate7710 with the exact `requiredPaymentAmount` → send). So: **value-carrying GMX executions are
structurally accepted by 1Shot.** Feasible.

## 3. The unlock — get EXACT calldata from the SDK, don't hand-roll

Hand-rolling `createOrder` params (acceptablePrice, executionFee, market, index token, slippage) from
memory is reckless with real funds — the struct is version-sensitive (`cancellationReceiver`,
`autoCancel`, `validFromTime`, `dataList` were all added across GMX v2 revisions). Instead we reuse the
SDK's own builders, which are correct for the installed version (`@gmx-io/sdk@1.6.3`):

- `sdk.orders.long(params)` → `increaseOrderHelper` fetches markets/oracle prices/gas, computes
  `getIncreasePositionAmounts`, and calls `createIncreaseOrderTxn`.
- `createIncreaseOrderTxn` builds the multicall `[sendWnt, sendTokens, createOrder]`, then **sends** it
  via `sdk.callContract(exchangeRouter, abis.ExchangeRouter, "multicall", [finalPayload], { value: totalWntAmount })`.

**Interception:** override `sdk.callContract` to *capture* `(address, "multicall", [finalPayload], {value})`
and throw a sentinel before the send. Then encode `ExchangeRouter.multicall(finalPayload)` ourselves
with viem (`abis.ExchangeRouter`) and route it through `submitDelegatedBundle` (the proven 1Shot path).
Result: the EXACT calldata GMX itself would broadcast, with correct live prices — relayed by 1Shot.

## 4. Verified on-chain constants (Arbitrum One, 42161)

| What | Address |
|---|---|
| ExchangeRouter (current, from SDK config) | `0x1C3fa76e6E1088bCE750f23a5BFcffa1efEF6A41` |
| ETH/USD GM market [WETH-USDC] | `0x70d95587d40A2caf56bd97485aB3Eec10Bee6336` |
| USDC (collateral + 1Shot fee token) | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` |
| 1Shot redeemer target (42161) | `0x47f3e9d111a0ba2f2e86d9f4a3f21235fd6d0a42` |
| 1Shot feeCollector | `0xE936e8FAf4A5655469182A49a505055B71C17604` |
| 1Shot live minFee (42161) | ~0.0149 USDC/tx |

`OrderVault` + the GMX `Router` (the plugin-transfer router USDC is approved to) come from the SDK's
`getContract(chainId, ...)` config; the multicall's `sendTokens`/`sendWnt` use the OrderVault.

## 5. The bundle 1Shot relays

`permissionContext` = a signed delegation from the user/test Smart Account → the 1Shot redeemer, scoped
with an **open** delegation (caveats: `allowedTargets` = [ExchangeRouter, GMX Router, USDC] +
native-value limit + erc20 limit + timestamp). `executions` =

1. `USDC.transfer(feeCollector, requiredPaymentAmount)` — the 1Shot fee (appended server-side).
2. `{ target: ExchangeRouter, value: executionFee (ETH), data: multicall(...) }` — the GMX order.

The executing account (delegator SA) is `msg.sender` to ExchangeRouter, so `sendTokens` pulls USDC from
it (needs a one-time `USDC.approve(GMX Router)`), and `sendWnt` consumes its native ETH as `value`.

## 6. Funding requirements for a LIVE test (important)

Unlike LP/bridge (pure USDC), a GMX order is **not pure-USDC**:

- **USDC**: collateral (GMX v2 min ≈ $2) + the ~0.0149 USDC 1Shot fee + headroom.
- **ETH**: GMX's keeper **execution fee**, carried as native `value` (~0.0002–0.001 ETH on Arbitrum,
  a few cents–dollars). This ETH comes from the delegator SA's own balance — 1Shot pays the *outer* tx
  gas in USDC, but the *inner* GMX keeper fee is native ETH by GMX's design.
- **Approval**: one-time `USDC.approve(GMX Router, …)` from the SA.

Caveat: very small GMX orders can be auto-cancelled by keepers (refund minus fees). A clean live test
uses ≈ $2 collateral at low leverage on the deepest market (ETH/USD).

## 7. Test plan (safe → spend)

1. **Build** the real multicall via the SDK interceptor (minimal ETH long, ~$2 USDC).
2. **Estimate** (FREE): `relayer_estimate7710Transaction` on the real calldata + fee leg. `success:true`
   ⇒ the adapter produces valid, relayable GMX calldata and 1Shot will relay it. This is the strongest
   proof that doesn't gamble on keeper behavior.
3. **Send** (gated on a CONFIRM flag + sufficient USDC **and** ETH): `relayer_send7710Transaction`, then
   poll `relayer_getStatus` / the webhook for the landed tx; verify the order on Arbiscan / GMX.

## 8. Adapter implementation (`apps/api/scripts/gmx-1shot-adapter.mjs`)

The working adapter:
1. `new GmxSdk({ chainId: 42161, account, rpcUrl, oracleUrl, subsquidUrl })` — must pass `oracleUrl`
   (`https://arbitrum-api.gmxinfra.io`) explicitly; the SDK doesn't auto-apply the per-chain default.
   Load via CJS (`createRequire("@gmx-io/sdk")`) — the ESM build ships extensionless imports Node can't
   resolve.
2. **Intercept** `sdk.callContract` (capture `address`, `method`, `params`, `value`; throw a sentinel
   before send), then `await sdk.orders.long({ payTokenAddress: USDC, collateralTokenAddress: USDC,
   marketAddress: ETH/USD, payAmount, leverage, allowedSlippageBps, skipSimulation })`. This fetches live
   markets/prices/gas and builds the exact `multicall([sendWnt, sendTokens, createOrder])` + the ETH
   `value` (execution fee).
3. Encode the outer call with a local `multicall(bytes[])` ABI (no need for the SDK's internal abis).
4. **Delegation:** `createDelegation({ from: SA, to: relayerTarget, scope: { type: ScopeType.FunctionCall,
   targets: [ExchangeRouter, USDC], selectors: ["multicall(bytes[])", "transfer(address,uint256)"],
   valueLte: { maxValue } } })`. The `FunctionCall` scope is essential: it composes
   `allowedTargets + allowedMethods + valueLte` and — unlike `NativeToken*Transfer` scopes — does NOT
   add an `ExactCalldataEnforcer` (which requires empty calldata and rejected the GMX multicall with
   `ExactCalldataEnforcer:invalid-calldata`). `valueLte` permits the native execution fee.
5. `executions = [USDC.transfer(feeCollector, requiredPaymentAmount), { ExchangeRouter, value, multicall }]`
   → `relayer_estimate7710Transaction` (free) → `relayer_send7710Transaction`.

## 9. Results log

- 2026-06-16 — **feasibility re-confirmed** (value execution accepted; estimate only missing the fee leg).
- 2026-06-16 — **adapter estimate PASSED on mainnet** with the real GMX calldata:
  `relayer_estimate7710Transaction` → `success: true`, `gasUsed[42161] = 1,270,484`,
  `requiredPaymentAmount = 0.056497 USDC`. 1Shot fully simulated the real GMX v2
  `ExchangeRouter.multicall(createOrder)` as a 7710 delegated execution and accepted it. Real ETH
  execution fee from the SDK = 0.000159 ETH; multicall = 3 legs, 1348 calldata bytes.
- 2026-06-16 — test wallet `0xDCdF…9d8f`: 0.00226 ETH, 4.09 USDC, USDC→GMX Router allowance = MAX
  (already approved from earlier native GMX runs). All live-send preconditions met.
- 2026-06-16 — **★ LIVE SEND LANDED ON ARBITRUM ONE MAINNET.** `relayer_send7710Transaction` accepted
  the bundle and the relayed `redeemDelegations → ExchangeRouter.multicall(createOrder)` executed.
  On-chain balance deltas on `0xDCdF…9d8f`:
  - **USDC −2.0556** = 2.00 collateral (→ OrderVault) + 0.0565 relayer fee (→ feeCollector).
  - **ETH −0.00012** = GMX keeper execution fee (carried as native `value`; unused portion refunded).
  - The **outer tx gas was paid by 1Shot in USDC** — the user spent ZERO ETH on transaction gas. The
    only ETH consumed is GMX's intrinsic keeper fee.
  The GMX keeper then **filled the order into a real position**: ETH/USD market
  `0x70d95587d40A2caf56bd97485aB3Eec10Bee6336`, **isLong=true, sizeUsd 3.99, collateral 1.9976 USDC**.

  **Landed transaction:** `0x772bcc83552cf3c9524fa0b2c276d27d5c7db3985e831eca5cd9c4fff54736c8`
  (block 473856928) — https://arbiscan.io/tx/0x772bcc83552cf3c9524fa0b2c276d27d5c7db3985e831eca5cd9c4fff54736c8
  One relayed `redeemDelegations` tx carrying both the 0.0556 USDC fee → feeCollector and the GMX
  `ExchangeRouter.multicall`. (Found via the USDC `Transfer(account → feeCollector)` log; the public
  `https://arb1.arbitrum.io/rpc` serves `eth_getLogs`, the project's Alchemy RPC rejected the ranged query.)

- 2026-06-16 — **position later closed** (BTC/USD + ETH/USD longs) via GMX express decrease orders
  (`scripts/gmx-close-all.mjs`), all collateral returned to the wallet (USDC 2.04 → 8.15).

  **Verdict: GMX v2 perp orders now genuinely execute through the 1Shot Permissionless Relayer as
  EIP-7710 delegated executions (gas in USDC). All three legs of the cross-chain plan — Uniswap LP,
  Circle CCTP bridge, AND GMX perp — ride 1Shot.**

  Caveat retained: GMX needs a little ETH in the executing account for the keeper execution fee (~0.00012
  ETH here); it is not pure-USDC. The 1Shot fee + tx gas are USDC.

## 10. Known 1Shot issue — `relayer_getStatus` server crash (report to 1Shot)

**Symptom.** After a successful `relayer_send7710Transaction` (a valid taskId is returned and the tx
lands on-chain), polling `relayer_getStatus` fails on EVERY call for the task with a JSON-RPC error:

```
relayer_getStatus: undefined is not an object (evaluating 'hex2.startsWith')
```

It is not transient — it threw on all 22 poll attempts (every 4s) for this task, and reproduced earlier
on the W5 self-transfer tasks too. The error is a **server-side exception inside 1Shot's relayer**, not
a client/argument problem: `hex2.startsWith` is 1Shot's own code calling `.startsWith` on an `undefined`
value (almost certainly a hex field — a tx hash, log topic, or status string — that the relayer expects
to be present but is `undefined` for these tasks, perhaps before the tx is mined or for 7702/value-
carrying executions specifically).

**Param shapes tried.** Our client sends `relayer_getStatus([{ id: taskId, logs: true }])` (array with a
single object), per the OpenRPC spec. We also previously tried a bare `relayer_getStatus([taskId])`
(positional string) during W5, which failed differently. The `[{id, logs}]` shape is what the spec
documents and what `send`/`estimate`/`getFeeData` accept, so the crash is downstream of arg parsing —
the relayer accepts the request, then throws while building the status response.

**Impact.** `getStatus` is unusable as a status source for these tasks, so a naive integration that
trusts it would report the order as perpetually "unknown/failed" even though it landed. **This directly
affects the 1Shot bounty line "projects that leverage the relayer webhooks as the source for transaction
status updates will score higher"** — webhooks (`destinationUrl` / `POST /webhooks/1shot`) are the
intended status channel and a more robust one than `getStatus`.

**Our mitigation (no false confidence).** We do NOT trust a send as landed off the taskId alone. We
verify terminal state out-of-band:
1. **On-chain balance deltas** — the exact USDC (collateral + fee) and ETH (keeper fee) movements.
2. **GMX position / order state** via the SDK (`fetchPositionsInfo`).
3. **Webhook reconciliation** in production — `POST /webhooks/1shot` updates the
   `agent_relay_tasks` ledger; `submitDelegatedBundle` / the relay route reconcile terminal states
   against on-chain truth before trusting them, so a `getStatus` crash never produces a false "confirmed".

**Recommendation to 1Shot.** Guard the `hex2.startsWith` call (null-check the hex field before
`.startsWith`) and return a structured pending/known status instead of throwing; or document that
webhooks are the supported status channel for 7702/value-carrying tasks. We can supply the failing
taskId + the landed tx `0x772bcc8…36c8` for their repro.

## 11. Wired into the API — DONE

- **`apps/api/src/lib/gmxOneShotExec.ts`** — reusable server-side adapter. `buildGmxExecution(account, p)`
  builds the real GMX multicall via the SDK interception; `executeGmxViaOneShot(p)` signs a
  FunctionCall-scoped delegation (agent wallet → 1Shot relayer) and submits via `submitDelegatedBundle`
  (canonical getFeeData → estimate7710 → send + webhook reconciliation; the USDC fee leg is appended
  there). Returns `{ taskId, feeUsdc, exchangeRouter, executionFeeWei }`.
- **`apps/api/src/routes/gmx.ts`** — the `/api/gmx/live/launch` route no longer hard-stops with
  `GMX_USES_NATIVE_RELAY` when `DUALITY_EXEC_VIA_SMART_ACCOUNT=true`. It now resolves the market address
  (`resolveMarketAddress`), calls `executeGmxViaOneShot`, records the relayed task in
  `agent_gmx_live_orders` (`status="relayed"`, submitted JSON carries the taskId), and returns
  `result_tier: "GMX_MAINNET_RELAYED_1SHOT"`. Flag off → the native Gelato express path runs unchanged.
- API typecheck clean.

**To run it live:** set `DUALITY_EXEC_VIA_SMART_ACCOUNT=true` and ensure the owner's agent wallet holds
the USDC collateral + a little ETH (keeper fee) + a USDC→GMX Router approval. The Execute test widget's
GMX leg, the agent's GMX launch, and a direct `POST /api/gmx/live/launch` all funnel through this path.

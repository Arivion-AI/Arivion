# Arivion

Arivion is an agentic quant lab for designing, testing, and operating crypto, tokenized-stock, liquidity, and GMX trading workflows from one owner-scoped command surface.

The repository combines a Next.js trading cockpit, an agentic Copilot service, a PNPM and Python quant workspace, market-data ingestion, paper execution, verification, on-chain testnet execution, and guarded GMX v2 live trading routes.

Arivion is built around one principle: the agent can reason and act, but every action must carry proof, scope, and guardrails. Backtests report fill fidelity. Testnet transactions return transaction hashes. GMX live actions require explicit confirmations, environment kill switches, caps, and owner-scoped ledgers.

## Status

- Frontend cockpit: Next.js app under `frontend/`.
- Agent Copilot: TypeScript Express service under `netrunner quant lab/apps/agent/`.
- Lab API: TypeScript API under `netrunner quant lab/apps/api/`.
- Quant services: Python workers, verifier, sandbox runner, and data ingestor under `netrunner quant lab/apps/`.
- Shared quant code: `netrunner quant lab/packages/quant-core/`.
- Strategy schema and templates: `netrunner quant lab/packages/strategy-dsl/` and `netrunner quant lab/packages/ui/`.
- Smart contracts and testnet execution helpers: `netrunner quant lab/contracts/` and API execution libraries.
- Infrastructure: local Compose and observability files under `netrunner quant lab/infra/`.

## Repository Map

```text
.
|-- assets/
|   `-- copilot-architecture.svg
|-- frontend/
|   |-- src/app/netrunners/
|   |-- src/app/api/copilot/
|   |-- src/components/copilot/
|   |-- src/components/netrunners/
|   `-- src/lib/
`-- netrunner quant lab/
    |-- apps/
    |   |-- agent/
    |   |-- api/
    |   |-- data-ingestor/
    |   |-- mcp/
    |   |-- sandbox-runner/
    |   |-- verifier/
    |   |-- web/
    |   `-- worker/
    |-- contracts/
    |-- infra/
    |-- packages/
    |   |-- quant-core/
    |   |-- strategy-dsl/
    |   `-- ui/
    |-- scripts/
    `-- tests/
```

## Copilot Architecture

![Arivion Copilot architecture](assets/copilot-architecture.svg)

The primary runtime flow is:

1. The user signs in and opens the Netrunners Copilot UI.
2. The browser calls the Next.js proxy at `/api/copilot/*`.
3. The proxy exchanges the Privy access token for an owner JWT through the Lab API.
4. The proxy forwards the owner JWT to the agent service.
5. The agent creates or resumes a thread, starts a run, builds context, and enters the LLM/tool loop.
6. The agent emits run events, widgets, messages, approvals, and truth cards over SSE.
7. The UI renders those events into the Nexa board, chat rail, panels, and live trading views.

## Quick Start

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Useful frontend commands:

```bash
npm run lint
npm run build
npm run start
```

### Quant Lab Workspace

```bash
cd "netrunner quant lab"
pnpm install
pnpm test
```

The workspace combines TypeScript packages, TypeScript services, and Python services. Install Python dependencies per service when running the worker, data ingestor, verifier, or sandbox runner directly.

### Environment

Copy the provided example file:

```bash
cp "netrunner quant lab/.env.example" "netrunner quant lab/.env"
```

Keep private keys, RPC URLs, API keys, JWT secrets, and execution toggles in local environment files only. Environment files are ignored by Git.

## Core Boundaries

Arivion separates trading capability into clear execution tiers:

- `LOCAL ONLY`: deterministic local simulation or modeling.
- `BACKTEST VERIFIED`: replayed against stored candles, snapshots, or trades with reported coverage.
- `LIVE PAPER VERIFIED`: forward paper execution with live data.
- `TESTNET EXECUTED`: real testnet transaction with a receipt, never production capital.
- `GMX_MAINNET_SUBMITTED`: real GMX v2 mainnet submit path, allowed only behind explicit live-trading gates.

The agent must surface truth metadata whenever a workflow crosses from reasoning into action. Important fields include data source, fill model, coverage proof, venue, result tier, risk blocks, cost, and whether real-money execution is possible.

## Agent Copilot

The Agent Copilot is the operating layer that turns chat into owner-scoped actions. It is not a static chatbot. It can inspect live market data, build strategy specs, run paper backtests, reason about portfolios, open managed paper positions, prepare testnet launches, and route explicit GMX live operations through guarded API surfaces.

### Main Responsibilities

- Maintain user conversations as threads, messages, runs, steps, events, and snapshots.
- Build a system prompt from the base operating skill, market briefing, memory recall, and knowledge retrieval.
- Select a tool-capable actor model when tools are required.
- Route model calls through the LLM gateway for metering, pricing, provider selection, and usage records.
- Connect to the owner-scoped MCP tool server for Lab reads and analysis.
- Expose curated action tools instead of raw mutating tools.
- Run plans through guardrails, budgets, approvals, risk checks, and truth-card generation.
- Stream the whole run to the UI as events rather than hiding work behind a blocking request.

### User-Facing Copilot Surface

The main Copilot screen lives at:

```text
frontend/src/app/netrunners/copilot/page.tsx
```

It includes:

- Chat composer for natural-language requests.
- Nexa board for live widgets and flow cards.
- Market briefing, research, models, budget, autonomy, memory, console, and portfolio panels.
- Saved setup and recent chat views.
- Agent wallet display.
- Live GMX account, order, and position inspection.
- Multi-asset setup and rerun flows.
- SSE-driven step groups so users can inspect what the agent actually did.

The client helper functions live in:

```text
frontend/src/lib/copilot/api.ts
frontend/src/lib/copilot/config.ts
```

### Proxy and Authentication

The browser does not hold the internal owner token. Instead:

1. The browser sends a Privy token using `x-privy-token`.
2. The Next.js proxy calls `/auth/session` on the Lab API.
3. The Lab API returns an owner JWT.
4. The proxy forwards `Authorization: Bearer <owner JWT>` to the agent.

Proxy implementation:

```text
frontend/src/app/api/copilot/[...path]/route.ts
```

The proxy also streams server-sent events directly from the agent to the browser without buffering.

### Agent API Server

The agent service is defined in:

```text
netrunner quant lab/apps/agent/src/server.ts
```

Major Copilot API groups include:

- Credits and managed balance.
- LLM model catalog and model preferences.
- Usage and per-run cost reporting.
- Memory list, patch, and deletion.
- Trigger configuration and autonomy controls.
- Threads, messages, run events, and snapshots.
- Research, market overview, token screening, and token news.
- Managed paper positions.
- Multi-asset proposal and paper starts.
- Knowledge ingestion and retrieval.
- Dune and on-chain research surfaces.

### Chat Turn Lifecycle

The chat turn starts in:

```text
netrunner quant lab/apps/agent/src/chat/engine.ts
```

Lifecycle:

1. Persist the user message.
2. Create a new run.
3. Publish `run.started`.
4. Load model preferences.
5. Pick a tool-capable actor when necessary.
6. Fetch conversation history.
7. Build market briefing context.
8. Recall owner-specific memory.
9. Retrieve relevant knowledge passages.
10. Connect to the MCP tool server with the owner token.
11. Build the dynamic tool catalog.
12. Call the LLM through the gateway.
13. Execute tool calls, publish step events, and collect outputs.
14. Persist the assistant result.
15. Emit widgets, messages, or truth cards back to the board.

### LLM Gateway

The gateway lives under:

```text
netrunner quant lab/apps/agent/src/llm-gateway/
```

It handles:

- Managed model catalog.
- Provider health.
- Provider and model routing.
- BYOK mode boundaries.
- Cost quotes.
- Token and cost metering.
- Credit reservation.
- Usage events.
- Run-level usage rollups.

The Copilot can choose separate model roles such as planner, actor, triage, and embedding model. For tool execution, the actor must support tool calling. If the preferred actor cannot call tools, the service can switch to a configured OpenAI tool-capable model for that turn.

### Tool System

The chat tool layer lives in:

```text
netrunner quant lab/apps/agent/src/chat/tools.ts
```

There are two tool classes:

- Dynamic owner-scoped MCP read tools.
- Curated Copilot action tools.

Raw mutating MCP tools are not exposed directly to the model. The agent gets curated tools that preserve guardrails and truth-card reporting.

Important Copilot tools include:

- `market_overview`: broad live market read.
- `screen_tokens`: deeper multi-factor token and xStock screening.
- `token_news`: current trusted RSS headlines.
- `research_web`: quarantined web research.
- `analyze_symbol`: technical, sentiment, on-chain, and risk-manager analysis for one symbol.
- `build_and_backtest`: build a bot spec and run an honest paper backtest.
- `open_managed_position`: open a capped paper position with a required stop-loss.
- `list_positions`: inspect managed positions.
- `discovery_intake`: collect portfolio profile inputs.
- `reason_portfolio`: synthesize objective, screen assets, reason per sleeve, and produce a portfolio plan.
- `setup_multiasset`: legacy multi-asset paper proposal flow.
- `start_multiasset_paper`: start a confirmed paper basket.
- `launch_testnet_plan`: execute supported testnet-only legs after explicit confirmation.

### Plan Orchestration

Typed plan execution lives in:

```text
netrunner quant lab/apps/agent/src/orchestrator/runner.ts
netrunner quant lab/apps/agent/src/orchestrator/plan.ts
netrunner quant lab/apps/agent/src/orchestrator/truthCard.ts
```

The orchestrator:

- Validates a typed plan before action.
- Runs guardrails before any mutating step.
- Supports autonomy levels.
- Persists step state.
- Supports resumable approval flows.
- Resolves outputs from earlier steps into later step parameters.
- Stops on tool errors, hard risk blocks, or insufficient coverage.
- Builds a truth card at the end of a completed or blocked run.
- Records outcomes for learning and memory.

### Governance

The Copilot governance layer includes:

- Budget checks for daily runs, live sessions, and LLM cost.
- Risk state and kill-switch controls.
- Autonomy settings.
- Approval records for guarded steps.
- Circuit-breakers for drawdown, loss streaks, and tail risk.
- Hard blocks for unsafe plans.
- Truth-card output for evidence and auditability.

Important modules:

```text
netrunner quant lab/apps/agent/src/budget/
netrunner quant lab/apps/agent/src/risk/
netrunner quant lab/apps/agent/src/guardrails/
netrunner quant lab/apps/agent/src/settings/
```

### Memory, Knowledge, and Learning

The Copilot uses memory and knowledge to make future turns less stateless:

- Episode memory records outcomes and lessons.
- Semantic memory supports retrieval by embedding.
- Knowledge ingestion stores user-provided documents or research material.
- Reflection jobs can turn outcomes into learned reports.
- The chat engine injects relevant recall blocks before the model decides.

Important modules:

```text
netrunner quant lab/apps/agent/src/memory/
netrunner quant lab/apps/agent/src/knowledge/
netrunner quant lab/apps/agent/src/learning/
```

### Live Event Streaming

Runs are streamed to the UI through the run event bus:

```text
netrunner quant lab/apps/agent/src/chat/bus.ts
```

Common event types:

- `run.started`
- `run.step`
- `widget`
- `approval.required`
- `truth_card`
- `message`
- `run.done`
- `run.error`

The UI uses these events to update step groups, flow widgets, status text, and final assistant messages.

## Quant Lab

The Quant Lab is the research, simulation, and verification layer under `netrunner quant lab/`. It is designed to keep trading workflows reproducible, inspectable, and honest about the data used.

### What the Quant Lab Does

- Ingest market data from centralized and decentralized venues.
- Store candles, L2 snapshots, trade prints, pool state, and replay artifacts.
- Build and validate bot specs.
- Run deterministic backtests.
- Model venue-specific order behavior.
- Run live paper sessions.
- Verify replay results and result tiers.
- Analyze portfolios and multi-asset baskets.
- Support strategy templates and UI presets.
- Provide an MCP tool surface for the Copilot.

### Workspace Structure

```text
netrunner quant lab/apps/api/             Main Lab API
netrunner quant lab/apps/agent/           Copilot agent service
netrunner quant lab/apps/mcp/             Owner-scoped MCP server
netrunner quant lab/apps/data-ingestor/   Market data collection
netrunner quant lab/apps/worker/          Backtests, live paper, LP services
netrunner quant lab/apps/verifier/        Replay and verification
netrunner quant lab/apps/sandbox-runner/  Isolated strategy execution
netrunner quant lab/packages/quant-core/  Deterministic quant engine
netrunner quant lab/packages/strategy-dsl/ Strategy schema and generated types
netrunner quant lab/packages/ui/          Strategy templates and regimes
netrunner quant lab/tests/                Golden, integration, and load tests
```

### Data Sources

The lab uses different data lanes depending on the workflow:

- Bybit market data for centralized crypto and xStocks analysis.
- DEX discovery and pool data for Uniswap, Camelot, and other Arbitrum lanes.
- GMX SDK data for GMX v2 markets, account state, orders, trades, and balances.
- Chainlink or Chainlink-compatible price references where available.
- Dune allowlisted query packs for on-chain analytics.
- Trusted RSS feeds for token headlines.
- Internal database tables for candles, sessions, orders, positions, and replay records.

### Fill Fidelity

The Quant Lab is explicit about execution fidelity. Supported fill modes include:

- `bar_based`: default candle OHLC path. Deterministic and fast, but maker fills are optimistic.
- `l2_sweep`: conservative L2 replay where maker limits fill only on strict sweeps.
- `l2_queue`: queue-aware replay using book snapshots and public trades.
- `amm_mid_only`: DEX candle-only AMM approximation.
- `amm_quote_snapshot`: modeled AMM quote from recorded reserves or snapshots.
- `amm_swap_replay`: historical replay using swap prints where available.
- `testnet_actual`: recorded testnet transaction or receipt.

The lab reports honesty flags such as:

- `maker_fills_optimistic`
- `liquidity_free_upper_bound`
- `l2_provider_used`
- `trade_prints_used`
- `snapshot_coverage_pct`
- `trade_coverage_pct`
- `fallback_reason`

### Venue Exactness

The venue layer can model real exchange constraints:

- Tick and quantity snapping.
- Minimum quantity and notional checks.
- Price band checks.
- Fee schedules by category and VIP tier.
- Post-only rejection if the order would cross.
- Reduce-only clamp behavior.
- IOC and FOK semantics.
- Trigger price references.
- Funding and liquidation modeling.

These checks are implemented in the quant-core package and tested through golden tests.

### Strategy and Bot Coverage

The lab supports strategy families such as:

- Spot grid.
- Futures grid.
- DCA.
- Futures DCA.
- TWAP.
- VP/POV style execution.
- Market-making variants.
- Funding arbitrage research.
- Cross-asset allocation.
- LP and AMM simulations.
- xStock portfolio and tokenized-equity sleeves.

Strategy specifications are validated through the strategy schema and generated TypeScript/Python types.

### Portfolio and Multi-Asset Analysis

The portfolio layer supports:

- Fixed weights.
- Equal weights.
- Inverse volatility.
- Risk parity.
- Momentum selection.
- Crypto, equity/xStock, and LP legs.
- Union timelines with forward fill.
- Equity regular-trading-hours constraints.
- Rebalance cost modeling.
- Exposure and concentration checks.

The Copilot can use this layer to propose a single-deposit portfolio across:

- GMX trading sleeve.
- LP sleeve.
- Robinhood tokenized-stock sleeve.

### Verification and Truth

The verifier and truth-card layers make sure results are not presented as stronger than the evidence allows. A backtest with only candles is not described as L2 verified. A testnet transaction is not described as real-money production execution. A GMX account read is not confused with an order submit.

The goal is to keep every result auditable:

- What data source was used?
- What fill model was used?
- What coverage was available?
- What assumptions were made?
- Was execution simulated, paper, testnet, or live?
- Did any guardrail block the action?

### Running Tests

From the lab root:

```bash
cd "netrunner quant lab"
pnpm test
```

The repository also includes Python golden tests under:

```text
netrunner quant lab/tests/golden/
netrunner quant lab/tests/integration/
netrunner quant lab/tests/load/
```

Run focused Python tests with `pytest` from the lab root after installing the required Python service dependencies.

## Robinhood Token Buying Market

The Robinhood token buying market is the testnet tokenized-stock execution lane. It lets an owner-scoped agent wallet buy, sell, schedule, and inspect testnet stock tokens on Robinhood Chain Testnet.

This lane is not production equity trading. It uses deployed testnet contracts, test collateral, and test tokenized stocks. It is useful for proving the end-to-end execution path: wallet creation, oracle read, collateral mint, approval, vault mint or redeem, transaction receipt, and UI display.

### Chain and Contracts

The Robinhood lane uses:

- Chain: Robinhood Chain Testnet.
- Chain ID: `46630`.
- Collateral: `MockUSDG`.
- Vault: `DualityStockVault`.
- Stock tokens: `dTSLA`, `dAMZN`, `dPLTR`, `dNFLX`, `dAMD`, or whichever symbols are configured in `DUALITY_STOCK_TOKENS`.
- Oracle path: `DualityStockVault.priceOf(symbol)`.
- Explorer: `https://explorer.testnet.chain.robinhood.com`.

The execution library lives in:

```text
netrunner quant lab/apps/api/src/lib/agentExec.ts
```

### Agent Wallet Model

Each owner gets a lazily created agent EOA:

- Private key is generated by the backend.
- Private key is encrypted at rest.
- Wallet is owner-scoped in the database.
- Wallet can be gas-funded by the treasury wallet.
- The same logical agent wallet can be inspected from the UI.

This lets the Copilot act on behalf of the owner's testnet account without exposing backend signing keys to the browser.

### Market State

The market state endpoint reads:

- Whether execution is enabled.
- Configured vault and collateral addresses.
- Agent wallet address.
- Agent gas balance.
- Agent MockUSDG balance.
- Market open flag.
- RTH-only flag.
- Max price staleness.
- Per-stock oracle price.
- Per-stock oracle freshness.
- Per-stock agent balance.
- Per-stock total supply.
- Quote for buying with 100 USDG.

The truth metadata labels this as `LIVE_TESTNET_STATE` with `can_execute_real_money: false`.

### Buying Tokenized Stocks

The buy path is:

1. Check `DUALITY_ENABLE_TESTNET_ACTIONS`.
2. Check requested amount against the configured per-transaction cap.
3. Resolve the owner agent wallet.
4. Read the vault oracle price.
5. Reject if the oracle price is stale.
6. Mint test `MockUSDG` to the agent wallet.
7. Approve the vault.
8. Call `vault.mint(symbol, collateralIn)`.
9. Read the resulting stock-token balance.
10. Return tx hashes, explorer URL, price, amount spent, amount received, and truth metadata.

Result tier:

```text
TESTNET EXECUTED
```

### Selling Tokenized Stocks

The sell path is:

1. Check testnet actions are enabled.
2. Resolve the owner agent wallet.
3. Read oracle freshness.
4. Check the agent has enough stock-token balance.
5. Call `vault.redeem(symbol, stockIn)`.
6. Return the testnet transaction hash and received MockUSDG estimate or balance delta.

### Limit Orders, Baskets, and DCA

The stock order router supports persisted order intents for the tokenized-stock market:

```text
netrunner quant lab/apps/api/src/routes/stockOrders.ts
```

Supported actions:

- List recent orders, DCA bots, and stock-order events.
- Create a limit order.
- Create a basket order.
- Cancel a pending order.
- Create a DCA bot.
- Pause or resume a DCA bot.
- Mark a DCA bot done.

Order features:

- Owner-scoped rows.
- Buy or sell side.
- One or more legs.
- USDG sizing or stock-token sizing.
- Optional trigger price.
- Comparator logic for limit triggers.
- Optional expiry.
- `createdBy` source such as `user` or `copilot`.
- Optional run ID linking the order back to a Copilot run.

### Robinhood API Surface

Common API concepts:

```text
GET    /api/exec/agent-wallet
GET    /api/exec/orders
POST   /api/exec/orders
DELETE /api/exec/orders/:id
POST   /api/exec/dca
PATCH  /api/exec/dca/:id
DELETE /api/exec/dca/:id
```

The direct execution helpers include stock buy, stock sell, LP execution, swaps, and demo bridge execution. The stock market is the Robinhood-specific subset.

### Robinhood Environment

Important variables:

```text
DUALITY_ENABLE_TESTNET_ACTIONS=true
ROBINHOOD_TESTNET_RPC_URL=...
ROBINHOOD_TESTNET_ALCHEMY_RPC_URL=...
DEPLOY_PRIVATE_KEY=...
AGENT_WALLET_MASTER_KEY=...
AGENT_GAS_TOPUP_ETH=0.004
AGENT_MAX_BUY_USDG=2000
DUALITY_STOCK_VAULT_ADDRESS=...
DUALITY_MOCK_USDG_ADDRESS=...
DUALITY_STOCK_TOKENS=TSLA:0x...,AMZN:0x...,PLTR:0x...
```

Safety behavior:

- If `DUALITY_ENABLE_TESTNET_ACTIONS` is not true, execution returns `TESTNET_ACTIONS_DISABLED`.
- If vault addresses are missing, state returns `VAULT_NOT_CONFIGURED`.
- If oracle data is stale, buy and sell are blocked.
- Returned truth metadata always states `can_execute_real_money: false`.

## GMX Live Trading

GMX live trading is the guarded real-money route for GMX v2 express orders on Arbitrum One. It is intentionally separate from paper trading and testnet execution.

The route implementation lives in:

```text
netrunner quant lab/apps/api/src/routes/gmx.ts
```

### Scope

GMX live trading can:

- Read GMX v2 markets.
- Read GMX account positions, orders, trades, and balances.
- Prepare an increase order ticket.
- Submit an increase order after explicit confirmation.
- Poll order status by request ID.
- Resolve a launched position from the owner ledger.
- Submit a decrease order to close or partially close a position after explicit confirmation.
- Store submitted GMX launch and close records in `agent_gmx_live_orders`.

GMX live trading is not the same as the testnet launch tool. It uses Arbitrum One and can submit real GMX v2 express orders when live trading is enabled and configured.

### Chain and SDK

- Chain: Arbitrum One.
- Chain ID: `42161`.
- Venue: GMX v2.
- SDK: `@gmx-io/sdk/v2`.
- Submit path: `executeExpressOrder`.
- Order mode: `express`.
- Collateral token: `USDC`.

### Live Policy Gates

GMX live trading is blocked unless the live policy passes.

Required:

```text
DUALITY_ENABLE_REAL_TRADER=true
AGENT_GMX_PRIVATE_KEY=...
```

Configurable caps:

```text
GMX_MAX_COLLATERAL_USD=250
GMX_MAX_LEVERAGE=3
GMX_REFERRAL_CODE=...
GMX_UI_FEE_RECEIVER=...
```

The policy checks:

- Real trader kill switch.
- GMX private key presence.
- Collateral cap.
- Leverage cap.
- Limit orders require trigger price.
- Low collateral warning.
- Higher leverage warning.

### Preparing a GMX Order

The prepare path validates and canonicalizes the request before any real submission.

Input shape:

```json
{
  "symbol": "ETH",
  "direction": "long",
  "orderType": "market",
  "collateralUsd": 25,
  "leverage": 2,
  "slippageBps": 30,
  "strategyId": "optional",
  "botType": "optional"
}
```

For limit orders, include:

```json
{
  "orderType": "limit",
  "triggerPriceUsd": 3500
}
```

The prepare response includes:

- Canonical GMX market symbol.
- Direction.
- Order type.
- Collateral amount.
- Leverage.
- Size in USD.
- Slippage.
- Risk warnings.
- GMX request object.
- Policy result.

### Launching a GMX Order

Launch requires explicit confirmation:

```json
{
  "confirm": "LAUNCH_GMX_MAINNET"
}
```

The launch path:

1. Requires owner authentication.
2. Validates the order schema.
3. Resolves the canonical GMX symbol.
4. Builds the ticket.
5. Runs policy checks.
6. Requires `LAUNCH_GMX_MAINNET`.
7. Creates a GMX private-key signer from `AGENT_GMX_PRIVATE_KEY`.
8. Sets `ticket.request.from` to the signer address.
9. Calls `sdk.executeExpressOrder(ticket.request, signer)`.
10. Stores the launch in `agent_gmx_live_orders`.
11. Returns request ID, status, signer account, ticket, and truth metadata.

Result tier:

```text
GMX_MAINNET_SUBMITTED
```

Truth metadata states:

```text
venue: gmx_v2
can_execute_real_money: true
source: @gmx-io/sdk/v2 executeExpressOrder
```

### Reading GMX Markets and Accounts

Supported reads:

```text
GET /api/gmx/live/markets
GET /api/gmx/live/account?address=0x...
GET /api/gmx/live/sessions
GET /api/gmx/live/order-status/:requestId
```

The market endpoint uses GMX SDK market and ticker reads. The account endpoint reads positions, related orders, recent trades, and wallet balances for a supplied address.

The sessions endpoint reads the owner-scoped ledger of launches and closes from the database. It is not a substitute for live GMX account state, so the UI also reads the GMX account endpoint.

### Closing a GMX Position

Close requires explicit confirmation:

```json
{
  "requestId": "existing-launch-request-id",
  "closeFraction": 1,
  "slippageBps": 30,
  "confirm": "STOP_GMX_MAINNET"
}
```

The close path:

1. Requires owner authentication.
2. Resolves the original launch from the owner ledger.
3. Requires `STOP_GMX_MAINNET`.
4. Runs the same live policy checks.
5. Reads live GMX positions for the signer account.
6. Finds the matching symbol and direction.
7. Calculates size delta from the real on-chain position.
8. Builds a GMX v2 decrease request.
9. Calls `executeExpressOrder`.
10. Stores the close record.
11. Marks the original launch as closing or partial close.

Freed collateral returns to the GMX account wallet as USDC according to the decrease request.

### GMX UI Workflow

The Copilot live trading panel supports:

- Preparing drafts from strategy or bot outputs.
- Choosing market, side, order type, collateral, leverage, and slippage.
- Inspecting policy blocks before launch.
- Launching only with explicit confirmation.
- Reading agent and user wallet GMX account state.
- Viewing positions, orders, trades, and balances.
- Closing positions through the guarded stop path.

### GMX Safety Notes

- GMX live trading can submit real mainnet orders.
- Keep collateral and leverage caps conservative.
- Keep `DUALITY_ENABLE_REAL_TRADER` disabled by default.
- Never commit `AGENT_GMX_PRIVATE_KEY`.
- Use small collateral while validating.
- Always poll order status after launch.
- Always inspect account state before closing.
- The owner ledger records what Arivion submitted; GMX account reads show what is actually open.

## Environment Reference

Common variables:

```text
JWT_SECRET=...
DATABASE_URL=...
REDIS_URL=...
ALLOW_DEV_TOKEN=false
NETRUNNERS_AGENT_URL=http://localhost:4500
NETRUNNERS_API_URL=http://localhost:4000
```

Copilot and LLM:

```text
OPENAI_API_KEY=...
COPILOT_ADMIN_OWNER_IDS=...
COPILOT_MAX_COST_PER_DAY_USD=...
COPILOT_BYOK_ENABLED=false
```

Robinhood testnet:

```text
DUALITY_ENABLE_TESTNET_ACTIONS=true
ROBINHOOD_TESTNET_RPC_URL=...
DUALITY_STOCK_VAULT_ADDRESS=...
DUALITY_MOCK_USDG_ADDRESS=...
DUALITY_STOCK_TOKENS=...
```

Arbitrum Sepolia testnet:

```text
ARBITRUM_SEPOLIA_RPC_URL=...
DUALITY_AMM_ADDRESS=...
DUALITY_AMM_TOKEN0=...
DUALITY_AMM_TOKEN1=...
```

GMX live trading:

```text
DUALITY_ENABLE_REAL_TRADER=true
AGENT_GMX_PRIVATE_KEY=...
GMX_MAX_COLLATERAL_USD=250
GMX_MAX_LEVERAGE=3
```

## Development Notes

- Generated dependencies, build outputs, caches, and compiled Python files are ignored.
- Keep local `.env` files out of Git.
- Keep all execution credentials outside the repository.
- Use the README architecture diagram for high-level onboarding.
- Use the source files listed in each section for implementation-level details.
- The frontend is best used with the API, agent, database, and supporting services running together.

## Safety and Product Notes

Arivion is a research and execution-control system. It can simulate, paper trade, submit testnet transactions, and, when explicitly enabled, submit GMX mainnet orders. It is not a guarantee of performance, not financial advice, and not a substitute for human review.

The system is designed to make uncertainty visible:

- It labels paper results as paper.
- It labels testnet transactions as testnet.
- It labels live GMX submissions as live.
- It records owner-scoped ledgers.
- It requires confirmation strings for dangerous actions.
- It keeps model-generated action behind code-level policy checks.

That separation is the point: the Copilot may be intelligent, but the runtime remains evidence-driven and policy-gated.

# Foundry Deployment Scripts

These scripts are the first Forge-native replacement for the legacy Hardhat deploy flow.

They are intentionally environment-driven and small in surface area so they are easy to audit, easy to rerun, and easier for AI agents to modify safely.

## Scripts

- `script/foundry/DeploySystemV1.s.sol`
  - Deploys the V1 core system: registries, `Escrow`, `Orchestrator`, and `ProtocolViewer`
  - Wires `EscrowRegistry.addEscrow(...)` and `Escrow.setOrchestrator(...)`
  - Can deploy `USDCMock` when `USDC_ADDRESS` is omitted
- `script/foundry/DeployAcrossBridgeHook.s.sol`
  - Deploys `AcrossBridgeHook`
  - Optionally deploys `AcrossSpokePoolMock`
  - Optionally registers the hook in `PostIntentHookRegistry`

## Required Environment

Common:

- `PRIVATE_KEY`

`DeploySystemV1.s.sol` optional overrides:

- `OWNER`
- `MULTISIG`
- `USDC_ADDRESS`
- `USDC_MINT_AMOUNT`
- `PROTOCOL_TAKER_FEE`
- `PROTOCOL_TAKER_FEE_RECIPIENT`
- `ESCROW_DUST_RECIPIENT`
- `ESCROW_DUST_THRESHOLD`
- `MAX_INTENTS_PER_DEPOSIT`
- `INTENT_EXPIRATION_PERIOD`
- `TRANSFER_OWNERSHIP_TO_MULTISIG`

`DeployAcrossBridgeHook.s.sol` required inputs:

- `USDC_ADDRESS`
- `ORCHESTRATOR_ADDRESS`
- `POST_INTENT_HOOK_REGISTRY_ADDRESS`

`DeployAcrossBridgeHook.s.sol` optional overrides:

- `MULTISIG`
- `ACROSS_SPOKE_POOL_ADDRESS`
- `DEPLOY_ACROSS_SPOKE_POOL_MOCK`
- `REGISTER_POST_INTENT_HOOK`
- `TRANSFER_OWNERSHIP_TO_MULTISIG`

## Example Commands

Local core deployment:

```bash
PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
forge script script/foundry/DeploySystemV1.s.sol:DeploySystemV1 --rpc-url http://127.0.0.1:8545
```

Local Across hook deployment with a mock spoke pool:

```bash
PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
USDC_ADDRESS=<usdc-address> \
ORCHESTRATOR_ADDRESS=<orchestrator-address> \
POST_INTENT_HOOK_REGISTRY_ADDRESS=<registry-address> \
DEPLOY_ACROSS_SPOKE_POOL_MOCK=true \
forge script script/foundry/DeployAcrossBridgeHook.s.sol:DeployAcrossBridgeHook --rpc-url http://127.0.0.1:8545
```

Add `--broadcast` once you are ready to submit transactions.

Goal (incl. success criteria):
- Deliver `AcrossBridgeHookV2` with explicit mode envelope and validate it with both unit tests and forked Foundry tests against real chain state.
- Success criteria:
  - Existing Hardhat suite remains green.
  - Forked Foundry tests cover V2 bridge-only and swap+bridge pathways against live Base contracts/tokens.
  - Additional relevant negative/fallback tests are included.

Constraints/Assumptions:
- Work in `/Users/richardliang/Documents/zk/zkp2p-v2-contracts`.
- User accepted breaking change: no implicit legacy payload detection.
- `intent.data` must always be `abi.encode(HookCommitment{mode,modeData})` in V2.
- Keep single hook contract/address UX.

Key decisions:
- Keep same commitment fields in `modeData` as legacy bridge commitment:
  - `destinationChainId`, `outputToken`, `recipient`, `minOutputAmount`.
- New structure is explicit envelope only:
  - `mode` + `modeData`.
- Swap route details are fulfill-time inputs (not signal-time commitments) to avoid route drift failures.
- Maintain fallback-to-origin transfer semantics on execution failure.
- Fork tests use current live Base periphery from Across API (`0x767e4c20F521a829dE4Ffc40C25176676878147f`) and Base spoke pool (`0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64`).

State:
- Done: V2 contract + unit tests + forked Foundry coverage implemented and passing.
- Now: confirm exact path coverage (direct bridge + swapAndBridge) in the new tests for user.
- Next: optional deploy/integration helper updates for V2 envelope encoding.

Done:
- Added `/Users/richardliang/Documents/zk/zkp2p-v2-contracts/contracts/hooks/AcrossBridgeHookV2.sol`.
- Added `/Users/richardliang/Documents/zk/zkp2p-v2-contracts/contracts/external/Interfaces/IAcrossSpokePoolPeriphery.sol`.
- Added `/Users/richardliang/Documents/zk/zkp2p-v2-contracts/contracts/mocks/AcrossSpokePoolPeripheryMock.sol`.
- Added `/Users/richardliang/Documents/zk/zkp2p-v2-contracts/test/hooks/acrossBridgeHookV2.spec.ts`.
- Added `/Users/richardliang/Documents/zk/zkp2p-v2-contracts/test-foundry/fork/AcrossBridgeHookV2Fork.t.sol` with 5 fork tests:
  - bridge-only success (explicit envelope)
  - bridge-only legacy raw payload rejection
  - swap+bridge success via real periphery + deterministic exchange
  - swap+bridge fallback on swap-path revert
  - bridge-only fallback when output below minimum
- Updated `/Users/richardliang/Documents/zk/zkp2p-v2-contracts/foundry.toml` fork profile EVM to `cancun` (from `shanghai`) to support current live contract opcodes on fork.
- Verified Across API current addresses/behavior:
  - bridgeable route uses selector `0xad5425c6` to Base SpokePool
  - any-to-bridgeable route uses selector `0x110560ad` to periphery `0x767e4c20F521a829dE4Ffc40C25176676878147f`

Now:
- Answer user question on whether both direct bridge and periphery swapAndBridge are explicitly exercised.

Next:
- Optional: add deployment script for `AcrossBridgeHookV2` and migration helpers.
- Optional: wire offchain builder helpers for explicit `HookCommitment` encoding.

Open questions (UNCONFIRMED if needed):
- UNCONFIRMED: whether to add V2 deploy script now or in a follow-up PR.
- UNCONFIRMED: whether to keep legacy hook deployed in parallel during migration.

Working set (files/ids/commands):
- `/Users/richardliang/Documents/zk/zkp2p-v2-contracts/CONTINUITY.md`
- `/Users/richardliang/Documents/zk/zkp2p-v2-contracts/contracts/hooks/AcrossBridgeHookV2.sol`
- `/Users/richardliang/Documents/zk/zkp2p-v2-contracts/contracts/external/Interfaces/IAcrossSpokePoolPeriphery.sol`
- `/Users/richardliang/Documents/zk/zkp2p-v2-contracts/contracts/mocks/AcrossSpokePoolPeripheryMock.sol`
- `/Users/richardliang/Documents/zk/zkp2p-v2-contracts/test/hooks/acrossBridgeHookV2.spec.ts`
- `/Users/richardliang/Documents/zk/zkp2p-v2-contracts/test-foundry/fork/AcrossBridgeHookV2Fork.t.sol`
- `/Users/richardliang/Documents/zk/zkp2p-v2-contracts/foundry.toml`
- `FOUNDRY_PROFILE=fork BASE_RPC_URL=https://mainnet.base.org forge test --match-path 'test-foundry/fork/*.t.sol' -vv`
- `npx hardhat test test/hooks/acrossBridgeHook.spec.ts test/hooks/acrossBridgeHookV2.spec.ts`

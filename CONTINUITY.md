Goal (incl. success criteria):
- Keep `maxFee` computed as 10 bps onchain but make it governance-updatable; update spec/tests and ship with passing tests.

Constraints/Assumptions:
- Must maintain/update this ledger each turn; keep concise facts only.
- Review ALL docs provided by user (Arc tutorial + Circle CCTP).
- Scope is source-chain hook only; destination chain out of scope.
- Environment: workspace-write, network enabled, approval_policy=never.
- User request: do not fall back; base logic must be grounded in Circle GitHub contract review.
- User request: do not change the external hook/interface shape beyond adding governance configurability.

Key decisions:
- Implement maxFee as 10 bps default with owner/governance updateable `maxFeeBps`.

State:
- TokenMessengerV2 on Base Sepolia/Base mainnet lacks `getMinFeeAmount`; source shows only `_maxFee < _amount` on deposit and `fee <= maxFee` on receive.
- Circle GitHub `TokenMinter.sol` (evm-cctp-contracts) has no fee logic.

Done:
- Read ledger; checked `contracts/hooks` contents.
- Reviewed Arc tutorial and Circle CCTP overview.
- Reviewed Circle CCTP technical guide + EVM contracts/interfaces (addresses, domains, TokenMessengerV2/MessageTransmitterV2 APIs).
- Drafted CCTP v2 hook integration spec (source-chain only).
- Added spec doc with flow diagram: `specs/cctp-v2-hook-spec.md`.
- Added CCTP hook contract + TokenMessenger interface + mock + deploy script.
- Added hook unit test and deploy test; added CCTP params.
- Created branch `cctp-bridge-hook`, committed changes, pushed to origin.
- Ran unit + deploy tests after local setup; tests passing with env overrides.
- Added hardhat network params for deploy scripts, test fixes, and hardhat config env overrides.
- Committed and pushed `a68280f`.
- Added Foundry fork integration test for CCTP hook and ran it successfully against Base Sepolia RPC.
- Committed and pushed Foundry integration test.
- Ran full Foundry suite with Base Sepolia fork; 42 tests passed; compile warnings only.
- Removed `.foundry/` and `.svm/` directories.
- Reviewed CCTP hook for CEI, reentrancy, and business-logic issues.
- Compared CCTP hook logic against Across hook and answered maxFee question.
- Clarified that maxFee is JIT (fulfill) while maxFeeCap is set at signal, and described fulfillability implications.
- Updated `specs/cctp-v2-hook-spec.md` and `contracts/hooks/CctpBridgeHook.sol` to document the maxFeeCap minimum requirement.
- Committed and pushed documentation update (`51b20ad`).
- Explained that low maxFeeCap makes intent unfulfillable; recovery via cancel/release/prune.
- Removed maxFeeCap from `contracts/hooks/CctpBridgeHook.sol`, spec, and tests; updated integration test.
- Committed and pushed maxFeeCap removal (`49d379f`).
- Updated `contracts/hooks/CctpBridgeHook.sol` to compute maxFee onchain and removed maxFee from fulfill data.
- Updated `contracts/mocks/TokenMessengerV2Mock.sol`, tests, and spec for onchain maxFee.
- Committed and pushed onchain maxFee changes (`1fbeeb0`).
- Ran `npx hardhat test test/hooks/cctpBridgeHook.spec.ts` (with XDG env + dummy keys); passed.
- Ran `forge test --match-path test-foundry/integration/CctpBridgeHookFork.t.sol -vvv`; failed because `getMinFeeAmount` reverted on Base Sepolia.
- Checked Circle docs and onchain bytecode: `getMinFeeAmount(uint256)` selector `0x516990e3` not present in TokenMessengerV2 implementations (Base Sepolia + Base mainnet).
- Used `cast selectors --resolve` on Base Sepolia implementation (0xf80e...) showing no fee getter beyond `feeRecipient`.
- Pulled Circle GitHub `TokenMinter.sol` from `circlefin/evm-cctp-contracts`; no fee logic present.
- Updated `CctpBridgeHook` to compute `maxFee` as 10 bps onchain; removed `getMinFeeAmount` from interface/mock/tests/spec.
- Hardhat tests: `npx hardhat test test/hooks/cctpBridgeHook.spec.ts`, `npx hardhat test test/deploy/11_cctpBridgeHook.spec.ts` (PATH includes `.foundry/bin`); passed.
- Foundry full suite with fork (`BASE_SEPOLIA_RPC_URL=https://sepolia.base.org`): 42 tests passed.
- Committed and pushed fixed 10 bps maxFee update (`c26c5a0`).
- Added governance-updatable `maxFeeBps`, event, and error; updated spec and tests.
- Hardhat tests: `npx hardhat test test/hooks/cctpBridgeHook.spec.ts`, `npx hardhat test test/deploy/11_cctpBridgeHook.spec.ts`; passed.
- Foundry full suite with fork (`BASE_SEPOLIA_RPC_URL=https://sepolia.base.org`): 42 tests passed.

Now:
- Stage changes, clean untracked test artifacts, commit and push.

Next:
- None.

Open questions (UNCONFIRMED if needed):
- UNCONFIRMED: Circle docs list `getMinFeeAmount`, but deployed TokenMessengerV2 lacks it; 10 bps is a local policy choice.

Working set (files/ids/commands):
- CONTINUITY.md
- specs/cctp-v2-hook-spec.md
- contracts/hooks/CctpBridgeHook.sol
- contracts/external/Interfaces/ITokenMessengerV2.sol
- contracts/mocks/TokenMessengerV2Mock.sol
- deployments/parameters.ts
- deploy/11_deploy_cctp_bridge_hook.ts
- test/hooks/cctpBridgeHook.spec.ts
- test/deploy/11_cctpBridgeHook.spec.ts
- test-foundry/integration/CctpBridgeHookFork.t.sol

Name: repo-test-style
Domain: Hardhat + Mocha/Chai tests for this repository
Purpose: Provide a concise, repeatable pattern for writing readable, consistent tests that match our established style (see test/escrow/escrow.spec.ts).

When to use
- Writing or refactoring tests for Solidity contracts in this repo.
- Reviewing external contributions for test readability and consistency.

Quick checklist
- Use typed contracts from `@utils/contracts` (and `@typechain` when needed).
- One top-level `describe("<Contract>")`; nested `describe("#function")` blocks.
- Define a single `subject()` per block that calls exactly the function under test.
- Set all `subject*` inputs in `beforeEach`; `it` blocks only call `subject()` and assert.
- Use explicit variable names (no single-letter locals) and stable fixtures.
- Cover: success (state + events) and each revert path as separate `it` cases.
- Prefer `expect(...).to.emit(...).withArgs(...)` for event checks and custom errors for reverts.
- Writer subjects should accept a `subjectCaller` set in `beforeEach` (default to the authorized actor); negative-caller tests only change `subjectCaller`.
- Avoid double-wait patterns for transactions. If you need an emitted value (e.g., an id), add a small local helper inside the test file (not a global util) to parse the receipt and return the value.
- Keep deployment helpers (contract factories) in `utils/deploys.ts`; non-deployment test helpers should live in the test file to avoid overloading utils.

Structure & conventions
- Imports
  - `@utils/contracts` for typed contract factories/instances (Escrow, Orchestrator, registries, mocks).
  - `@utils/test` for `getAccounts`, `getWaffleExpect`.
  - `@utils/common` for helpers like `usdc()`, `ether()`.
  - `@utils/constants` for `ZERO`, `ADDRESS_ZERO`, etc.
- Naming
  - Contract instance: use `escrow` (or `ramp` in legacy escrow tests), `orchestrator`, etc.
  - Inputs to subject: prefix with `subject`, e.g., `subjectDepositId`, `subjectRegistry`.
  - Bytes identifiers: `venmoPaymentMethod`, `payeeDetailsHash`.
  - Avoid one-letter locals (`f`, `r`); prefer `fee`, `recipient`, `registryAddr`.
- Subject pattern
  - Example: `async function subject() { return escrow.connect(depositor.wallet).setDepositRateManager(subjectDepositId, subjectRegistry, subjectRateManagerId); }`
  - `beforeEach` assigns all `subject*` values and any fixtures; `it` does not mutate inputs.
  - For callers: `let subjectCaller = depositor;` then `escrow.connect(subjectCaller.wallet)...` in `subject()`.
- Test cases
  - Success: assert state updates and all emitted events.
  - Reverts: one `it` per reason (caller not authorized, zero inputs, not found, paused, etc.).
  - Views: return value assertions via `await subject()`.
- Events & errors
  - Use `withArgs` to assert exact payload; for arrays, assert length and entries when feasible.
  - Use custom errors (Hardhat custom error matcher) for precise revert reasons.
- Fixtures & helpers
  - Prefer small helpers (e.g., `seedDeposit()`) that are called from `beforeEach` only.
  - Avoid randomness/time drift; if time matters, control block timestamp explicitly.
  - Keep helper logic minimal; do not hide assertions inside helpers.

Minimal template
```
import "module-alias/register";
import { ethers } from "hardhat";
import { BigNumber, BytesLike } from "ethers";
import { getAccounts, getWaffleExpect } from "@utils/test";
import DeployHelper from "@utils/deploys";
import { ADDRESS_ZERO, ZERO } from "@utils/constants";
import { ether, usdc } from "@utils/common";
import { Currency } from "@utils/protocolUtils";
import { Escrow, Orchestrator, PaymentVerifierRegistry, PostIntentHookRegistry, RelayerRegistry, EscrowRegistry, USDCMock, PaymentVerifierMock } from "@utils/contracts";

const expect = getWaffleExpect();

describe("<Contract> — <Area>", () => {
  // Accounts
  let owner: any, user: any;

  // Contracts
  let escrow: Escrow; let orchestrator: Orchestrator; let paymentVerifierRegistry: PaymentVerifierRegistry; let postIntentHookRegistry: PostIntentHookRegistry; let relayerRegistry: RelayerRegistry; let escrowRegistry: EscrowRegistry; let usdcToken: USDCMock; let verifier: PaymentVerifierMock;

  let deployer: DeployHelper;

  beforeEach(async () => {
    [owner, user] = await getAccounts();
    deployer = new DeployHelper(owner.wallet);
    // deploy fixtures...
  });

  async function seedFixture() { /* create baseline state */ }

  describe("#functionUnderTest", () => {
    let subjectArg1: BytesLike; let subjectArg2: BigNumber; let subjectCaller: any;
    async function subject() { return escrow.connect(subjectCaller.wallet).functionUnderTest(subjectArg1, subjectArg2); }

    beforeEach(async () => {
      await seedFixture();
      subjectCaller = user;
      subjectArg1 = ethers.constants.HashZero; subjectArg2 = ZERO;
    });

    it("updates state and emits", async () => {
      await expect(subject()).to.emit(escrow, "EventName");
      // assert state via viewer / getters
    });

    describe("when invalid input", () => {
      beforeEach(async () => { subjectArg1 = ADDRESS_ZERO; });
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "ZeroAddress");
      });
    });
  });
});
```

Common pitfalls
- Mutating subject inputs inside `it` without resetting in `beforeEach` (leads to test coupling).
- Multiple operations inside `subject()`; keep it to a single call.
- Sparse event assertions (assert payloads to catch regressions).
- Using untyped `any` for contract types; prefer TypeChain types for safety.

Review rubric (quick)
- Is there a single subject per suite? Are inputs set in `beforeEach`?
- Are success and each revert case covered in separate tests?
- Are contracts strongly typed and variable names explicit?
- Are events asserted with payloads? Are state updates verified via getters/viewers?

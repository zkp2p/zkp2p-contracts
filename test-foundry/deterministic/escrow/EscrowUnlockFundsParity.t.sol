// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {EscrowLegacyFixture} from "../helpers/EscrowLegacyFixture.sol";
import {IEscrow} from "contracts/interfaces/IEscrow.sol";

contract EscrowUnlockFundsParityTest is EscrowLegacyFixture {
    event FundsUnlocked(uint256 indexed depositId, bytes32 indexed intentHash, uint256 amount);

    bytes32 internal constant SUBJECT_INTENT = keccak256("subject-intent");

    function setUp() public override {
        super.setUp();
        IEscrow.CreateDepositParams memory params = _baseCreateParams();
        params.intentAmountRange = IEscrow.Range({min: 10e6, max: 50e6});
        params.retainOnEmpty = false;
        params.currencies[0] = new IEscrow.Currency[](1);
        params.currencies[0][0] = IEscrow.Currency({code: USD, minConversionRate: 1.01e18});
        _createAsOffRamper(params);
        escrow.setOrchestrator(address(orchestratorMock));
        orchestratorMock.lockFunds(0, SUBJECT_INTENT, 30e6);
    }

    function _unlock(uint256 depositId, bytes32 intentHash) internal {
        orchestratorMock.unlockFunds(depositId, intentHash);
    }

    function test_UnlockFundsRestoresDepositAccounting() public {
        IEscrow.Deposit memory beforeDeposit = escrow.getDeposit(0);
        assertEq(beforeDeposit.remainingDeposits, 70e6);
        assertEq(beforeDeposit.outstandingIntentAmount, 30e6);

        _unlock(0, SUBJECT_INTENT);

        IEscrow.Deposit memory afterDeposit = escrow.getDeposit(0);
        assertEq(afterDeposit.remainingDeposits, 100e6);
        assertEq(afterDeposit.outstandingIntentAmount, 0);
    }

    function test_UnlockFundsDeletesIntent() public {
        assertEq(escrow.getDepositIntent(0, SUBJECT_INTENT).intentHash, SUBJECT_INTENT);
        _unlock(0, SUBJECT_INTENT);
        assertEq(escrow.getDepositIntent(0, SUBJECT_INTENT).intentHash, bytes32(0));
    }

    function test_UnlockFundsRemovesIntentHash() public {
        assertEq(escrow.getDepositIntentHashes(0).length, 1);
        _unlock(0, SUBJECT_INTENT);
        assertEq(escrow.getDepositIntentHashes(0).length, 0);
    }

    function test_UnlockFundsEmitsUnlockedAmount() public {
        vm.expectEmit(true, true, false, true, address(escrow));
        emit FundsUnlocked(0, SUBJECT_INTENT, 30e6);
        _unlock(0, SUBJECT_INTENT);
    }

    function test_UnlockFundsRejectsCallerThatIsNoLongerOrchestrator() public {
        escrow.setOrchestrator(offRamper);
        vm.expectRevert(
            abi.encodeWithSelector(IEscrow.UnauthorizedCaller.selector, address(orchestratorMock), offRamper)
        );
        _unlock(0, SUBJECT_INTENT);
    }

    function test_UnlockFundsRejectsMissingDeposit() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrow.DepositNotFound.selector, 999));
        _unlock(999, SUBJECT_INTENT);
    }

    function test_UnlockFundsRejectsMissingIntent() public {
        bytes32 missingIntent = keccak256("nonexistent");
        vm.expectRevert(abi.encodeWithSelector(IEscrow.IntentNotFound.selector, missingIntent));
        _unlock(0, missingIntent);
    }
}

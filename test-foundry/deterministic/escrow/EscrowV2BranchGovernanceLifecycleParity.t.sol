// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {EscrowV2LegacyFixture} from "../helpers/EscrowV2LegacyFixture.sol";
import {IEscrowV2} from "contracts/interfaces/IEscrowV2.sol";

contract EscrowV2BranchGovernanceLifecycleParityTest is EscrowV2LegacyFixture {
    function _expectNonOwnerRevert() internal {
        vm.expectRevert("Ownable: caller is not the owner");
        vm.prank(other);
    }

    function test_SetOrchestratorRegistryRejectsZeroAddress() public {
        vm.expectRevert(IEscrowV2.ZeroAddress.selector);
        escrow.setOrchestratorRegistry(address(0));
    }

    function test_SetOrchestratorRegistryRejectsNonOwner() public {
        _expectNonOwnerRevert();
        escrow.setOrchestratorRegistry(address(orchestratorRegistry));
    }

    function test_SetPaymentVerifierRegistryRejectsZeroAddress() public {
        vm.expectRevert(IEscrowV2.ZeroAddress.selector);
        escrow.setPaymentVerifierRegistry(address(0));
    }

    function test_SetPaymentVerifierRegistryRejectsNonOwner() public {
        _expectNonOwnerRevert();
        escrow.setPaymentVerifierRegistry(address(paymentVerifierRegistry));
    }

    function test_SetDustRecipientRejectsZeroAddress() public {
        vm.expectRevert(IEscrowV2.ZeroAddress.selector);
        escrow.setDustRecipient(address(0));
    }

    function test_SetDustRecipientRejectsNonOwner() public {
        _expectNonOwnerRevert();
        escrow.setDustRecipient(dustRecipient);
    }

    function test_SetDustThresholdRejectsValueAboveMaximum() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.AmountAboveMax.selector, 1_000_001, 1_000_000));
        escrow.setDustThreshold(1_000_001);
    }

    function test_SetDustThresholdRejectsNonOwner() public {
        _expectNonOwnerRevert();
        escrow.setDustThreshold(1e6);
    }

    function test_SetMaxIntentsRejectsZero() public {
        vm.expectRevert(IEscrowV2.ZeroValue.selector);
        escrow.setMaxIntentsPerDeposit(0);
    }

    function test_SetMaxIntentsRejectsNonOwner() public {
        _expectNonOwnerRevert();
        escrow.setMaxIntentsPerDeposit(10);
    }

    function test_SetIntentExpirationPeriodRejectsZero() public {
        vm.expectRevert(IEscrowV2.ZeroValue.selector);
        escrow.setIntentExpirationPeriod(0);
    }

    function test_SetIntentExpirationPeriodRejectsNonOwner() public {
        _expectNonOwnerRevert();
        escrow.setIntentExpirationPeriod(7200);
    }

    function test_PauseEscrowRejectsNonOwner() public {
        _expectNonOwnerRevert();
        escrow.pauseEscrow();
    }

    function test_UnpauseEscrowRejectsNonOwner() public {
        escrow.pauseEscrow();
        _expectNonOwnerRevert();
        escrow.unpauseEscrow();
    }

    function test_LockFundsRejectsMissingDeposit() public {
        bytes32 intentHash = keccak256("no-deposit-intent");
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.DepositNotFound.selector, 999));
        orchestratorMock.lockFunds(999, intentHash, 20e6);
    }

    function test_LockFundsRejectsDepositNotAcceptingIntents() public {
        vm.prank(depositor);
        escrow.setAcceptingIntents(0, false);
        bytes32 intentHash = keccak256("not-accepting-intent");
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.DepositNotAcceptingIntents.selector, 0));
        orchestratorMock.lockFunds(0, intentHash, 20e6);
    }

    function test_LockFundsRejectsAmountBelowRange() public {
        bytes32 intentHash = keccak256("below-min-intent");
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.AmountBelowMin.selector, 5e6, 10e6));
        orchestratorMock.lockFunds(0, intentHash, 5e6);
    }

    function test_LockFundsRejectsAmountAboveRange() public {
        bytes32 intentHash = keccak256("above-max-intent");
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.AmountAboveMax.selector, 201e6, 200e6));
        orchestratorMock.lockFunds(0, intentHash, 201e6);
    }

    function test_UnlockFundsRejectsMissingDeposit() public {
        bytes32 intentHash = keccak256("phantom-intent");
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.DepositNotFound.selector, 999));
        orchestratorMock.unlockFunds(999, intentHash);
    }

    function test_UnlockFundsRejectsMissingIntent() public {
        bytes32 intentHash = keccak256("missing-intent");
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.IntentNotFound.selector, intentHash));
        orchestratorMock.unlockFunds(0, intentHash);
    }

    function test_UnlockAndTransferRejectsMissingDeposit() public {
        bytes32 intentHash = keccak256("phantom-transfer-intent");
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.DepositNotFound.selector, 999));
        orchestratorMock.unlockAndTransferFunds(999, intentHash, 20e6, other);
    }

    function test_UnlockAndTransferRejectsMissingIntent() public {
        bytes32 intentHash = keccak256("missing-transfer-intent");
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.IntentNotFound.selector, intentHash));
        orchestratorMock.unlockAndTransferFunds(0, intentHash, 20e6, other);
    }

    function test_UnlockAndTransferRejectsZeroTransferAmount() public {
        bytes32 intentHash = _lock(address(orchestratorMock), 20e6);
        vm.expectRevert(IEscrowV2.ZeroValue.selector);
        orchestratorMock.unlockAndTransferFunds(0, intentHash, 0, other);
    }

    function test_UnlockAndTransferRejectsAmountAboveLockedAmount() public {
        bytes32 intentHash = _lock(address(orchestratorMock), 20e6);
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.AmountExceedsAvailable.selector, 25e6, 20e6));
        orchestratorMock.unlockAndTransferFunds(0, intentHash, 25e6, other);
    }

    function test_ExtendIntentExpiryRejectsMissingDeposit() public {
        bytes32 intentHash = keccak256("phantom-extend");
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.DepositNotFound.selector, 999));
        vm.prank(intentGuardian);
        escrow.extendIntentExpiry(999, intentHash, 120);
    }

    function test_ExtendIntentExpiryRejectsMissingIntent() public {
        bytes32 intentHash = keccak256("missing-extend-intent");
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.IntentNotFound.selector, intentHash));
        vm.prank(intentGuardian);
        escrow.extendIntentExpiry(0, intentHash, 120);
    }

    function test_ExtendIntentExpiryRejectsNonGuardian() public {
        bytes32 intentHash = _lock(address(orchestratorMock), 20e6);
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.UnauthorizedCaller.selector, other, intentGuardian));
        vm.prank(other);
        escrow.extendIntentExpiry(0, intentHash, 120);
    }

    function test_ExtendIntentExpiryRejectsZeroAdditionalTime() public {
        bytes32 intentHash = _lock(address(orchestratorMock), 20e6);
        vm.expectRevert(IEscrowV2.ZeroValue.selector);
        vm.prank(intentGuardian);
        escrow.extendIntentExpiry(0, intentHash, 0);
    }
}

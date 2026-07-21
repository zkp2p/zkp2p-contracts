// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {EscrowLegacyFixture} from "../helpers/EscrowLegacyFixture.sol";
import {IEscrow} from "contracts/interfaces/IEscrow.sol";
import {PaymentVerifierRegistry} from "contracts/registries/PaymentVerifierRegistry.sol";

contract EscrowGovernanceParityTest is EscrowLegacyFixture {
    event OrchestratorUpdated(address indexed orchestratorAddress);
    event PaymentVerifierRegistryUpdated(address indexed registry);
    event Paused(address account);
    event Unpaused(address account);
    event DustRecipientUpdated(address indexed recipient);
    event DustThresholdUpdated(uint256 threshold);
    event IntentExpirationPeriodUpdated(uint256 period);
    event MaxIntentsPerDepositUpdated(uint256 maximum);

    function test_SetOrchestratorUpdatesAddress() public {
        assertNotEq(address(escrow.orchestrator()), address(orchestratorMock));
        escrow.setOrchestrator(address(orchestratorMock));
        assertEq(address(escrow.orchestrator()), address(orchestratorMock));
    }

    function test_SetOrchestratorEmitsUpdate() public {
        vm.expectEmit(true, false, false, true, address(escrow));
        emit OrchestratorUpdated(address(orchestratorMock));
        escrow.setOrchestrator(address(orchestratorMock));
    }

    function test_SetOrchestratorRejectsZeroAddress() public {
        vm.expectRevert(IEscrow.ZeroAddress.selector);
        escrow.setOrchestrator(address(0));
    }

    function test_SetOrchestratorRejectsNonOwner() public {
        vm.expectRevert("Ownable: caller is not the owner");
        vm.prank(onRamper);
        escrow.setOrchestrator(address(orchestratorMock));
    }

    function test_SetPaymentVerifierRegistryUpdatesAddress() public {
        PaymentVerifierRegistry newRegistry = new PaymentVerifierRegistry();
        assertNotEq(address(escrow.paymentVerifierRegistry()), address(newRegistry));
        escrow.setPaymentVerifierRegistry(address(newRegistry));
        assertEq(address(escrow.paymentVerifierRegistry()), address(newRegistry));
    }

    function test_SetPaymentVerifierRegistryEmitsUpdate() public {
        PaymentVerifierRegistry newRegistry = new PaymentVerifierRegistry();
        vm.expectEmit(true, false, false, true, address(escrow));
        emit PaymentVerifierRegistryUpdated(address(newRegistry));
        escrow.setPaymentVerifierRegistry(address(newRegistry));
    }

    function test_SetPaymentVerifierRegistryRejectsZeroAddress() public {
        vm.expectRevert(IEscrow.ZeroAddress.selector);
        escrow.setPaymentVerifierRegistry(address(0));
    }

    function test_SetPaymentVerifierRegistryRejectsNonOwner() public {
        PaymentVerifierRegistry newRegistry = new PaymentVerifierRegistry();
        vm.expectRevert("Ownable: caller is not the owner");
        vm.prank(onRamper);
        escrow.setPaymentVerifierRegistry(address(newRegistry));
    }

    function test_PauseEscrowSetsPausedState() public {
        escrow.pauseEscrow();
        assertTrue(escrow.paused());
    }

    function test_PauseEscrowEmitsOwner() public {
        vm.expectEmit(false, false, false, true, address(escrow));
        emit Paused(address(this));
        escrow.pauseEscrow();
    }

    function test_PauseEscrowRejectsNonOwner() public {
        vm.expectRevert("Ownable: caller is not the owner");
        vm.prank(onRamper);
        escrow.pauseEscrow();
    }

    function test_PauseEscrowRejectsAlreadyPaused() public {
        escrow.pauseEscrow();
        vm.expectRevert("Pausable: paused");
        escrow.pauseEscrow();
    }

    function test_UnpauseEscrowClearsPausedState() public {
        escrow.pauseEscrow();
        escrow.unpauseEscrow();
        assertFalse(escrow.paused());
    }

    function test_UnpauseEscrowEmitsOwner() public {
        escrow.pauseEscrow();
        vm.expectEmit(false, false, false, true, address(escrow));
        emit Unpaused(address(this));
        escrow.unpauseEscrow();
    }

    function test_UnpauseEscrowRejectsNonOwner() public {
        escrow.pauseEscrow();
        vm.expectRevert("Ownable: caller is not the owner");
        vm.prank(onRamper);
        escrow.unpauseEscrow();
    }

    function test_UnpauseEscrowRejectsWhenNotPaused() public {
        vm.expectRevert("Pausable: not paused");
        escrow.unpauseEscrow();
    }

    function test_SetDustRecipientUpdatesRecipient() public {
        escrow.setDustRecipient(receiver);
        assertEq(escrow.dustRecipient(), receiver);
    }

    function test_SetDustRecipientEmitsUpdate() public {
        vm.expectEmit(true, false, false, true, address(escrow));
        emit DustRecipientUpdated(receiver);
        escrow.setDustRecipient(receiver);
    }

    function test_SetDustRecipientReplacesExistingRecipient() public {
        escrow.setDustRecipient(feeRecipient);
        assertEq(escrow.dustRecipient(), feeRecipient);
        escrow.setDustRecipient(receiver);
        assertEq(escrow.dustRecipient(), receiver);
    }

    function test_SetDustRecipientRejectsZeroAddress() public {
        vm.expectRevert(IEscrow.ZeroAddress.selector);
        escrow.setDustRecipient(address(0));
    }

    function test_SetDustRecipientRejectsNonOwner() public {
        vm.expectRevert("Ownable: caller is not the owner");
        vm.prank(onRamper);
        escrow.setDustRecipient(receiver);
    }

    function test_SetDustThresholdUpdatesThreshold() public {
        assertEq(escrow.dustThreshold(), 0);
        escrow.setDustThreshold(1e6);
        assertEq(escrow.dustThreshold(), 1e6);
    }

    function test_SetDustThresholdEmitsUpdate() public {
        vm.expectEmit(false, false, false, true, address(escrow));
        emit DustThresholdUpdated(1e6);
        escrow.setDustThreshold(1e6);
    }

    function test_SetDustThresholdAllowsZero() public {
        escrow.setDustThreshold(1e6);
        escrow.setDustThreshold(0);
        assertEq(escrow.dustThreshold(), 0);
    }

    function test_SetDustThresholdRejectsAboveMaximum() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrow.AmountAboveMax.selector, 100e6, 1e6));
        escrow.setDustThreshold(100e6);
    }

    function test_SetDustThresholdRejectsNonOwner() public {
        vm.expectRevert("Ownable: caller is not the owner");
        vm.prank(onRamper);
        escrow.setDustThreshold(1e6);
    }

    function test_SetIntentExpirationPeriodUpdatesPeriod() public {
        assertEq(escrow.intentExpirationPeriod(), 1 days);
        escrow.setIntentExpirationPeriod(2 days);
        assertEq(escrow.intentExpirationPeriod(), 2 days);
    }

    function test_SetIntentExpirationPeriodEmitsUpdate() public {
        vm.expectEmit(false, false, false, true, address(escrow));
        emit IntentExpirationPeriodUpdated(2 days);
        escrow.setIntentExpirationPeriod(2 days);
    }

    function test_SetIntentExpirationPeriodRejectsZero() public {
        vm.expectRevert(IEscrow.ZeroValue.selector);
        escrow.setIntentExpirationPeriod(0);
    }

    function test_SetIntentExpirationPeriodRejectsNonOwner() public {
        vm.expectRevert("Ownable: caller is not the owner");
        vm.prank(onRamper);
        escrow.setIntentExpirationPeriod(2 days);
    }

    function test_SetMaxIntentsPerDepositUpdatesMaximum() public {
        escrow.setMaxIntentsPerDeposit(5);
        assertEq(escrow.maxIntentsPerDeposit(), 5);
    }

    function test_SetMaxIntentsPerDepositEmitsUpdate() public {
        vm.expectEmit(false, false, false, true, address(escrow));
        emit MaxIntentsPerDepositUpdated(5);
        escrow.setMaxIntentsPerDeposit(5);
    }

    function test_SetMaxIntentsPerDepositRejectsZero() public {
        vm.expectRevert(IEscrow.ZeroValue.selector);
        escrow.setMaxIntentsPerDeposit(0);
    }

    function test_SetMaxIntentsPerDepositRejectsNonOwner() public {
        vm.expectRevert("Ownable: caller is not the owner");
        vm.prank(onRamper);
        escrow.setMaxIntentsPerDeposit(5);
    }
}

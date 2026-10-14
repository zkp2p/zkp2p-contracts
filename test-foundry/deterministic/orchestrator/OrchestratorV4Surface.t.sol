// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {OrchestratorV4Fixture} from "../helpers/OrchestratorV4Fixture.sol";
import {IOrchestratorV4} from "contracts/interfaces/IOrchestratorV4.sol";
import {IPreIntentHook} from "contracts/interfaces/IPreIntentHook.sol";
import {EscrowRegistry} from "contracts/registries/EscrowRegistry.sol";
import {RelayerRegistry} from "contracts/registries/RelayerRegistry.sol";

contract OrchestratorV4SurfaceTest is OrchestratorV4Fixture {
    event DepositPreIntentHookSet(
        address indexed escrow, uint256 indexed depositId, address indexed hook, address setter
    );
    event EscrowRegistryUpdated(address indexed registry);
    event RelayerRegistryUpdated(address indexed registry);
    event AllowMultipleIntentsUpdated(bool allowMultiple);
    event ProtocolFeeUpdated(uint256 fee);
    event ProtocolFeeRecipientUpdated(address indexed recipient);

    function test_DepositorSetsPreIntentHookAndEmits() public {
        vm.expectEmit(true, true, true, true, address(orchestrator));
        emit DepositPreIntentHookSet(address(escrow), depositId, address(preIntentHook), depositor);
        vm.prank(depositor);
        orchestrator.setDepositPreIntentHook(address(escrow), depositId, preIntentHook);
    }

    function test_HookSetterRejectsZeroEscrow() public {
        vm.expectRevert(IOrchestratorV4.ZeroAddress.selector);
        vm.prank(depositor);
        orchestrator.setDepositPreIntentHook(address(0), depositId, preIntentHook);
    }

    function test_HookSetterRejectsEoaHook() public {
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV4.InvalidPreIntentHook.selector, other));
        vm.prank(depositor);
        orchestrator.setDepositPreIntentHook(address(escrow), depositId, IPreIntentHook(other));
    }

    function test_GovernanceUpdatesRegistriesFeesAndPauseState() public virtual {
        EscrowRegistry newRegistry = new EscrowRegistry();
        RelayerRegistry newRelayerRegistry = new RelayerRegistry();
        vm.expectEmit(true, false, false, true, address(orchestrator));
        emit EscrowRegistryUpdated(address(newRegistry));
        orchestrator.setEscrowRegistry(address(newRegistry));
        vm.expectEmit(false, false, false, true, address(orchestrator));
        emit ProtocolFeeUpdated(1e16);
        orchestrator.setProtocolFee(1e16);
        vm.expectEmit(true, false, false, true, address(orchestrator));
        emit ProtocolFeeRecipientUpdated(other);
        orchestrator.setProtocolFeeRecipient(other);
        vm.expectEmit(false, false, false, true, address(orchestrator));
        emit AllowMultipleIntentsUpdated(false);
        orchestrator.setAllowMultipleIntents(false);
        vm.expectEmit(true, false, false, true, address(orchestrator));
        emit RelayerRegistryUpdated(address(newRelayerRegistry));
        orchestrator.setRelayerRegistry(address(newRelayerRegistry));
        assertEq(address(orchestrator.escrowRegistry()), address(newRegistry));
        assertEq(address(orchestrator.paymentVerifierRegistry()), address(paymentVerifierRegistry));
        assertEq(address(orchestrator.relayerRegistry()), address(newRelayerRegistry));
        assertEq(orchestrator.protocolFee(), 1e16);
        assertEq(orchestrator.protocolFeeRecipient(), other);
        assertEq(orchestrator.chainId(), CHAIN_ID);
        assertEq(orchestrator.owner(), address(this));
        assertFalse(orchestrator.allowMultipleIntents());
        orchestrator.pauseOrchestrator();
        assertTrue(orchestrator.paused());
        orchestrator.unpauseOrchestrator();
        assertFalse(orchestrator.paused());
    }

    function test_GovernanceRejectsInvalidSetterValues() public virtual {
        vm.expectRevert(IOrchestratorV4.ZeroAddress.selector);
        orchestrator.setEscrowRegistry(address(0));
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV4.FeeExceedsMaximum.selector, 6e16, 5e16));
        orchestrator.setProtocolFee(6e16);
        vm.expectRevert(IOrchestratorV4.ZeroAddress.selector);
        orchestrator.setProtocolFeeRecipient(address(0));
        vm.expectRevert(IOrchestratorV4.ZeroAddress.selector);
        orchestrator.setRelayerRegistry(address(0));
    }

    function test_GovernanceRejectsEveryNonOwnerCall() public virtual {
        vm.startPrank(other);
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        orchestrator.pauseOrchestrator();
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        orchestrator.unpauseOrchestrator();
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        orchestrator.setEscrowRegistry(address(escrowRegistry));
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        orchestrator.setProtocolFee(1e16);
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        orchestrator.setProtocolFeeRecipient(other);
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        orchestrator.setAllowMultipleIntents(false);
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        orchestrator.setRelayerRegistry(address(relayerRegistry));
        vm.stopPrank();
    }

    function test_SignalRejectsWhilePaused() public {
        orchestrator.pauseOrchestrator();
        vm.expectRevert(bytes("Pausable: paused"));
        _signalCall(taker, _defaultParams());
    }

    function test_EscrowPrunesExpiredIntentFromOrchestrator() public {
        bytes32 intentHash = _signalDefault();
        vm.warp(block.timestamp + 3601);
        vm.prank(other);
        escrow.pruneExpiredIntents(depositId);
        assertEq(orchestrator.getIntent(intentHash).owner, address(0));
    }

    function test_AnyoneCleansUpIntentOrphanedByEscrow() public {
        bytes32 intentHash = _signalDefault();
        bytes32 storageSlot = keccak256(abi.encode(intentHash, uint256(15)));
        vm.store(address(escrow), storageSlot, bytes32(0));
        vm.warp(block.timestamp + 3601);
        vm.prank(other);
        escrow.pruneExpiredIntents(depositId);
        assertEq(orchestrator.getIntent(intentHash).owner, taker);
        bytes32[] memory hashes = new bytes32[](1);
        hashes[0] = intentHash;
        vm.prank(other);
        orchestrator.cleanupOrphanedIntents(hashes);
        assertEq(orchestrator.getIntent(intentHash).owner, address(0));
    }

    function test_OrphanCleanupSkipsUnknownIntent() public {
        bytes32[] memory hashes = new bytes32[](1);
        hashes[0] = bytes32("unknown-intent");
        orchestrator.cleanupOrphanedIntents(hashes);
    }

    function test_OrphanCleanupPreservesActiveEscrowIntent() public {
        bytes32 intentHash = _signalDefault();
        bytes32[] memory hashes = new bytes32[](1);
        hashes[0] = intentHash;
        orchestrator.cleanupOrphanedIntents(hashes);
        assertEq(orchestrator.getIntent(intentHash).owner, taker);
    }

    function test_PruneIntentsIgnoresZeroAndNonEscrowCaller() public {
        bytes32 intentHash = _signalDefault();
        bytes32[] memory hashes = new bytes32[](2);
        hashes[0] = bytes32(0);
        hashes[1] = intentHash;
        vm.prank(other);
        orchestrator.pruneIntents(hashes);
        assertEq(orchestrator.getIntent(intentHash).owner, taker);
    }

    function test_FulfillRejectsWhilePaused() public {
        bytes32 intentHash = _signalDefault();
        orchestrator.pauseOrchestrator();
        vm.expectRevert(bytes("Pausable: paused"));
        _fulfill(intentHash, INTENT_AMOUNT, CONVERSION_RATE);
    }
    function test_ViewsAndDelegateHookSetter() public {
        vm.prank(delegate);
        orchestrator.setDepositPreIntentHook(address(escrow), depositId, preIntentHook);
        assertEq(address(orchestrator.getDepositPreIntentHook(address(escrow), depositId)), address(preIntentHook));
        bytes32 hash = _signalDefault();
        assertEq(preIntentHook.callCount(), 1);
        bytes32[] memory hashes = orchestrator.getAccountIntents(taker);
        assertEq(hashes.length, 1);
        assertEq(hashes[0], hash);
        assertEq(address(orchestrator.getIntentLifecycleHook(hash)), address(0));
        vm.prank(depositor);
        orchestrator.setDepositPreIntentHook(address(escrow), depositId, IPreIntentHook(address(0)));
        assertEq(address(orchestrator.getDepositPreIntentHook(address(escrow), depositId)), address(0));
    }

    function test_PruneSkipsForeignEscrowAndUnknownHash() public {
        bytes32 hash = _signalDefault();
        bytes32[] memory hashes = new bytes32[](3);
        hashes[0] = bytes32(0);
        hashes[1] = bytes32("unknown");
        hashes[2] = hash;
        escrowRegistry.addEscrow(other);
        vm.prank(other);
        orchestrator.pruneIntents(hashes);
        assertEq(orchestrator.getIntent(hash).owner, taker);
        vm.prank(address(escrow));
        orchestrator.pruneIntents(hashes);
        assertEq(orchestrator.getIntent(hash).owner, address(0));
    }

    function test_PauseStateRevertsAndRecoveryRemainsAvailable() public {
        bytes32 hash = _signalDefault();
        orchestrator.pauseOrchestrator();
        vm.expectRevert("Pausable: paused");
        orchestrator.pauseOrchestrator();
        vm.prank(taker);
        orchestrator.cancelIntent(hash);
        orchestrator.unpauseOrchestrator();
        vm.expectRevert("Pausable: not paused");
        orchestrator.unpauseOrchestrator();
    }
}

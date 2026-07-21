// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {StakeVault} from "contracts/StakeVault.sol";
import {USDCMock} from "contracts/mocks/USDCMock.sol";
import {NullifierRegistry} from "contracts/registries/NullifierRegistry.sol";
import {NullifierRegistryV2} from "contracts/registries/NullifierRegistryV2.sol";
import {INullifierRegistry} from "contracts/interfaces/INullifierRegistry.sol";
import {IStakeVault} from "contracts/interfaces/IStakeVault.sol";
import {StakeVaultHandler} from "./handlers/StakeVaultHandler.sol";
import {NullifierHandler} from "./handlers/NullifierHandler.sol";

contract StakeVaultStatefulInvariantTest is StdInvariant, Test {
    USDCMock internal token;
    StakeVault internal vault;
    StakeVaultHandler internal handler;

    function setUp() public {
        token = new USDCMock(1_000_000_000e6, "USDC", "USDC");
        vault = new StakeVault(address(this), token, address(0), 7 days, 1 days);
        handler = new StakeVaultHandler(vault, token);
        vault.initializeController(address(handler));
        token.transfer(address(handler), handler.ACTOR_COUNT() * 100_000e6);
        handler.configureActors(100_000e6);

        bytes4[] memory selectors = new bytes4[](12);
        selectors[0] = handler.deposit.selector;
        selectors[1] = handler.reserve.selector;
        selectors[2] = handler.increase.selector;
        selectors[3] = handler.update.selector;
        selectors[4] = handler.release.selector;
        selectors[5] = handler.slash.selector;
        selectors[6] = handler.claimCompensation.selector;
        selectors[7] = handler.requestPartialWithdrawal.selector;
        selectors[8] = handler.settlePartialWithdrawal.selector;
        selectors[9] = handler.toggleOrSettleExit.selector;
        selectors[10] = handler.advanceTime.selector;
        selectors[11] = handler.unauthorizedReserve.selector;
        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// Conservation: every vault token remains backed by a live stake, compensation, or fee liability.
    function invariant_VaultBalanceEqualsAllLiabilitiesAndGhostFlow() public view {
        assertEq(token.balanceOf(address(vault)), vault.totalLiabilities());
        assertEq(token.balanceOf(address(vault)), handler.ghostTokensIn() - handler.ghostTokensOut());
        assertEq(vault.totalDeferredFees(), 0);
        assertEq(vault.totalClaimableFees(), 0);
    }

    /// Accounting: aggregate and per-actor stake/reservation state matches an independent handler shadow model.
    function invariant_StakeAndReservationAccountingMatchesGhostState() public view {
        uint256 totalStake;
        uint256 totalReserved;
        for (uint256 actorIndex; actorIndex < handler.ACTOR_COUNT(); ++actorIndex) {
            address actor = handler.actorAt(actorIndex);
            uint256 stake = vault.stakeBalance(actor);
            uint256 reserved = vault.reservedStake(actor);
            assertEq(stake, handler.ghostStake(actor));
            assertEq(reserved, handler.ghostReserved(actor));
            assertLe(reserved, vault.eligibleStake(actor));
            assertLe(vault.eligibleStake(actor), stake);
            assertEq(vault.freeStake(actor) + reserved, vault.eligibleStake(actor));
            IStakeVault.ExitRequest memory exitRequest = vault.getExitRequest(actor);
            IStakeVault.StakeWithdrawalRequest memory withdrawal = vault.getStakeWithdrawalRequest(actor);
            if (exitRequest.exiting) assertEq(withdrawal.amount, 0);
            totalStake += stake;
            totalReserved += reserved;
        }
        assertEq(totalStake, vault.totalStaked());

        uint256 positionReserved;
        for (uint256 slot; slot < handler.SLOT_COUNT(); ++slot) {
            IStakeVault.Reservation memory reservation = vault.getReservation(handler.positionAt(slot));
            if (reservation.active) {
                assertGt(reservation.amount, 0);
                assertEq(reservation.controller, address(handler));
                positionReserved += reservation.amount;
            }
        }
        assertEq(positionReserved, totalReserved);
    }

    /// Compensation: slashing changes liability ownership, never total backing, until a maker claims it.
    function invariant_CompensationAccountingMatchesGhostState() public view {
        uint256 totalCompensation;
        for (uint256 makerIndex; makerIndex < handler.MAKER_COUNT(); ++makerIndex) {
            address maker = handler.makerAt(makerIndex);
            uint256 compensation = vault.claimableCompensation(maker);
            assertEq(compensation, handler.ghostCompensation(maker));
            totalCompensation += compensation;
        }
        assertEq(totalCompensation, vault.totalClaimableCompensation());
    }

    /// Authorization and reachability: caught reverts are accounted and no untrusted controller action succeeds.
    function invariant_HandlerAccountingAndAuthorizationRemainSound() public view {
        assertEq(handler.totalCalls(), handler.successfulCalls() + handler.rejectedCalls());
        assertEq(handler.unauthorizedSuccesses(), 0);
    }

    function test_HandlerSelectorsReachSuccessAndExpectedRevertPaths() public {
        handler.deposit(0, 500e6);
        handler.reserve(0, 0, 200e6, 1 days);
        handler.increase(0, 50e6, 2 days);
        handler.update(0, 100e6, 3 days);
        handler.slash(0, 0, 25e6);
        handler.claimCompensation(0);
        handler.release(0);
        handler.reserve(0, 1, 50e6, 1 days);
        handler.release(1);
        handler.requestPartialWithdrawal(0, 25e6);
        handler.advanceTime(8 days);
        handler.settlePartialWithdrawal(0, false);
        handler.toggleOrSettleExit(0, false);
        handler.advanceTime(8 days);
        handler.toggleOrSettleExit(0, true);
        handler.unauthorizedReserve(0, 2);
        handler.release(11);

        for (uint256 action; action < handler.ACTION_COUNT(); ++action) {
            assertGt(handler.actionCalls(action), 0);
        }
        assertGt(handler.successfulCalls(), 0);
        assertGt(handler.rejectedCalls(), 0);
        assertGt(handler.unauthorizedAttempts(), 0);
        assertEq(handler.unauthorizedSuccesses(), 0);
    }

    function test_HandlerFailsClosedOnUnexpectedProductionRevert() public {
        bytes memory unexpectedRevert = abi.encodeWithSelector(StakeVault.StakeActionPaused.selector);
        vm.mockCallRevert(address(vault), abi.encodeWithSelector(vault.depositStake.selector), unexpectedRevert);

        vm.expectRevert(
            abi.encodeWithSelector(StakeVaultHandler.UnexpectedRevert.selector, uint256(0), unexpectedRevert)
        );
        handler.deposit(0, 1e6);
    }

    function test_HandlerFailsClosedOnUnexpectedProductionSuccess() public {
        vm.mockCall(address(vault), abi.encodeWithSelector(vault.releaseReservation.selector), bytes(""));

        vm.expectRevert(abi.encodeWithSelector(StakeVaultHandler.UnexpectedSuccess.selector, uint256(4)));
        handler.release(0);
    }
}

contract NullifierStatefulInvariantTest is StdInvariant, Test {
    NullifierRegistry internal legacyRegistry;
    NullifierRegistryV2 internal registry;
    NullifierHandler internal handler;

    function setUp() public {
        legacyRegistry = new NullifierRegistry();
        registry = new NullifierRegistryV2(INullifierRegistry(address(legacyRegistry)));
        handler = new NullifierHandler(legacyRegistry, registry);
        legacyRegistry.addWritePermission(address(handler));
        registry.addWritePermission(address(handler));

        bytes4[] memory selectors = new bytes4[](3);
        selectors[0] = handler.bind.selector;
        selectors[1] = handler.consumeLegacyThenAttemptV2.selector;
        selectors[2] = handler.unauthorizedWrite.selector;
        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// Replay safety: every V2 binding is bidirectional and no legacy-consumed payment gains a V2 binding.
    function invariant_NullifiersRemainUniqueAndBidirectionallyBound() public view {
        for (uint256 nullifierSlot; nullifierSlot < handler.SLOT_COUNT(); ++nullifierSlot) {
            bytes32 nullifier = handler.nullifierAt(nullifierSlot);
            bytes32 intentHash = handler.ghostIntentByNullifier(nullifier);
            assertEq(registry.intentHashByNullifier(nullifier), intentHash);
            if (intentHash != bytes32(0)) {
                assertEq(registry.nullifierByIntentHash(intentHash), nullifier);
                assertTrue(registry.isNullified(nullifier));
                assertFalse(handler.ghostLegacyNullifier(nullifier));
            }
            if (handler.ghostLegacyNullifier(nullifier)) {
                assertTrue(legacyRegistry.isNullified(nullifier));
                assertTrue(registry.isNullified(nullifier));
                assertEq(intentHash, bytes32(0));
            }
        }
        for (uint256 intentSlot; intentSlot < handler.SLOT_COUNT(); ++intentSlot) {
            bytes32 intentHash = handler.intentAt(intentSlot);
            bytes32 nullifier = handler.ghostNullifierByIntent(intentHash);
            assertEq(registry.nullifierByIntentHash(intentHash), nullifier);
            if (nullifier != bytes32(0)) assertEq(registry.intentHashByNullifier(nullifier), intentHash);
        }
    }

    /// Authorization: every untrusted write is rejected while expected collision paths remain non-fatal to the run.
    function invariant_NullifierHandlerAccountsForSuccessAndReverts() public view {
        assertEq(handler.totalCalls(), handler.successfulBindings() + handler.rejectedCalls());
        assertEq(handler.unauthorizedSuccesses(), 0);
    }

    function test_NullifierHandlerExercisesBindingCollisionLegacyAndAuthorizationPaths() public {
        handler.bind(0, 0);
        handler.bind(0, 1);
        handler.bind(1, 0);
        handler.consumeLegacyThenAttemptV2(2, 2);
        handler.unauthorizedWrite(0, 3, 3);
        assertEq(handler.successfulBindings(), 1);
        assertEq(handler.successfulLegacyWrites(), 1);
        assertEq(handler.rejectedCalls(), 4);
        assertEq(handler.unauthorizedAttempts(), 1);
        assertEq(handler.unauthorizedSuccesses(), 0);
    }
}

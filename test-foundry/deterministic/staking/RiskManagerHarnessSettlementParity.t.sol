// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {RiskManagerHarnessFixture} from "../helpers/RiskManagerHarnessFixture.sol";
import {USDCMock} from "contracts/mocks/USDCMock.sol";
import {IRiskManager} from "contracts/interfaces/IRiskManager.sol";
import {IIntentRiskHook} from "contracts/interfaces/IIntentRiskHook.sol";

contract RiskManagerHarnessSettlementParityTest is RiskManagerHarnessFixture {
    function _fee(address feeRecipient, uint256 amount)
        internal
        pure
        returns (IIntentRiskHook.FeeAllocation[] memory fees)
    {
        fees = new IIntentRiskHook.FeeAllocation[](1);
        fees[0] = IIntentRiskHook.FeeAllocation({
            feeType: IIntentRiskHook.FeeType.PROTOCOL, recipient: feeRecipient, amount: amount
        });
    }

    function _context(
        bytes32 intentHash,
        address settlementToken,
        address payoutRecipient,
        uint256 grossAmount,
        uint256 executableAmount,
        bool isManualRelease,
        IIntentRiskHook.FeeAllocation[] memory fees
    ) internal pure returns (IIntentRiskHook.RiskSettlementContext memory) {
        return IIntentRiskHook.RiskSettlementContext({
            intentHash: intentHash,
            token: settlementToken,
            recipient: payoutRecipient,
            grossAmount: grossAmount,
            executableAmount: executableAmount,
            isManualRelease: isManualRelease,
            feeAllocations: fees
        });
    }

    function _defaultContext(bytes32 intentHash) internal view returns (IIntentRiskHook.RiskSettlementContext memory) {
        return _context(intentHash, address(token), beneficiary, 100e6, 98e6, false, _fee(beneficiary, 2e6));
    }

    function test_RiskSettlementRejectsDirectAndInvalidContexts() public {
        bytes32 intentHash = keccak256("invalid-settlement");
        _createPosition(intentHash);
        vm.expectRevert(abi.encodeWithSelector(IRiskManager.UnauthorizedOrchestrator.selector, address(this)));
        manager.settleIntent(_defaultContext(intentHash));

        USDCMock otherToken = new USDCMock(1, "Other", "OTHER");
        vm.expectRevert(
            abi.encodeWithSelector(IRiskManager.IntentTokenMismatch.selector, address(token), address(otherToken))
        );
        orchestrator.settlePosition(
            manager, _context(intentHash, address(otherToken), beneficiary, 100e6, 98e6, false, _fee(beneficiary, 2e6))
        );
        vm.expectRevert(abi.encodeWithSelector(IRiskManager.InvalidSettlementAmounts.selector, 100e6, 0));
        orchestrator.settlePosition(
            manager,
            _context(intentHash, address(token), beneficiary, 100e6, 0, false, new IIntentRiskHook.FeeAllocation[](0))
        );
        vm.expectRevert(abi.encodeWithSelector(IRiskManager.InvalidFeeAllocations.selector, 2e6, 0));
        orchestrator.settlePosition(
            manager,
            _context(
                intentHash, address(token), beneficiary, 100e6, 98e6, false, new IIntentRiskHook.FeeAllocation[](0)
            )
        );
        vm.expectRevert(IRiskManager.ZeroAddress.selector);
        orchestrator.settlePosition(
            manager, _context(intentHash, address(token), beneficiary, 100e6, 98e6, false, _fee(address(0), 2e6))
        );

        IIntentRiskHook.FeeAllocation[] memory tooMany = new IIntentRiskHook.FeeAllocation[](13);
        for (uint256 i = 0; i < tooMany.length; i++) {
            tooMany[i] = IIntentRiskHook.FeeAllocation({
                feeType: IIntentRiskHook.FeeType.PROTOCOL, recipient: beneficiary, amount: 0
            });
        }
        vm.expectRevert(abi.encodeWithSelector(IRiskManager.InvalidFeeAllocationCount.selector, 13, 12));
        orchestrator.settlePosition(
            manager, _context(intentHash, address(token), beneficiary, 100e6, 98e6, false, tooMany)
        );
        vm.expectRevert(abi.encodeWithSelector(IRiskManager.IntentStateMismatch.selector, intentHash));
        orchestrator.settlePosition(
            manager, _context(intentHash, address(token), other, 100e6, 98e6, false, _fee(beneficiary, 2e6))
        );
    }

    function test_StakeBackedSettlementUsesGrossCoverageAndConsumesNoFunds() public {
        bytes32 intentHash = keccak256("stake-settlement");
        _createPosition(intentHash);
        uint256 beforeBalance = token.balanceOf(address(orchestrator));
        orchestrator.settlePosition(manager, _defaultContext(intentHash));
        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        assertEq(position.grossReleasedAmount, 100e6);
        assertEq(position.executableAmount, 98e6);
        assertEq(position.reservedAmount, 100e6);
        assertEq(token.balanceOf(address(orchestrator)), beforeBalance);
    }

    function test_DeferredSettlementPullsGrossAndAccountsFees() public {
        manager.setPlatformRiskConfig(PAYPAL, _chargebackConfig(true));
        vault.setTakerState(taker, taker, 1e6, 1e6, false);
        bytes32 intentHash = keccak256("deferred-settlement");
        _setRiskIntent(intentHash, 100e6, PAYPAL, uint64(block.timestamp), taker, taker);
        orchestrator.createPosition(manager, intentHash);
        uint256 vaultBefore = token.balanceOf(address(vault));
        orchestrator.settlePosition(
            manager, _context(intentHash, address(token), taker, 100e6, 98e6, true, _fee(beneficiary, 2e6))
        );
        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        (address deferredStaker, uint256 grossAmount, uint256 feeAmount,,, bool funded) =
            vault.deferredStakes(intentHash);
        assertEq(position.grossReleasedAmount, 100e6);
        assertEq(position.executableAmount, 98e6);
        assertTrue(position.isManualRelease);
        assertEq(deferredStaker, taker);
        assertEq(grossAmount, 100e6);
        assertEq(feeAmount, 2e6);
        assertTrue(funded);
        assertEq(token.balanceOf(address(vault)), vaultBefore + 100e6);
        assertEq(token.allowance(address(orchestrator), address(manager)), 0);
    }

    function test_DeferredAdmissionSnapshotsPayoutRecipientAsStakeOwner() public {
        manager.setPlatformRiskConfig(PAYPAL, _chargebackConfig(true));
        vault.setTakerState(taker, taker, 1e6, 1e6, false);
        bytes32 intentHash = keccak256("deferred-third-party-recipient");
        _setRiskIntent(intentHash, 100e6, PAYPAL, uint64(block.timestamp), taker, other);
        orchestrator.createPosition(manager, intentHash);
        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        (address deferredStaker,,,,,) = vault.deferredStakes(intentHash);
        assertEq(position.taker, taker);
        assertEq(position.stakeOwner, other);
        assertEq(position.payoutRecipient, other);
        assertEq(deferredStaker, other);
    }

    function test_DeferredAdmissionRejectsExitingPayoutRecipient() public {
        manager.setPlatformRiskConfig(PAYPAL, _chargebackConfig(true));
        vault.setTakerState(taker, taker, 1e6, 1e6, false);
        vault.setTakerState(other, other, 0, 0, true);
        bytes32 intentHash = keccak256("deferred-exiting-recipient");
        _setRiskIntent(intentHash, 100e6, PAYPAL, uint64(block.timestamp), taker, other);
        vm.expectRevert(abi.encodeWithSelector(IRiskManager.StakeOwnerExiting.selector, taker, other));
        orchestrator.createPosition(manager, intentHash);
    }

    function test_UnbondedSettlementReleasesPositionAndRejectsRepeat() public {
        bytes32 intentHash = keccak256("ordinary-settlement");
        _setRiskIntent(intentHash, 100e6, ZELLE, uint64(block.timestamp), taker, beneficiary);
        orchestrator.createPosition(manager, intentHash);
        orchestrator.settlePosition(
            manager,
            _context(
                intentHash, address(token), beneficiary, 100e6, 100e6, false, new IIntentRiskHook.FeeAllocation[](0)
            )
        );
        assertEq(uint256(manager.getRiskPosition(intentHash).status), uint256(IRiskManager.PositionStatus.RELEASED));
        vm.expectRevert(
            abi.encodeWithSelector(
                IRiskManager.PositionNotPending.selector, intentHash, IRiskManager.PositionStatus.RELEASED
            )
        );
        orchestrator.settlePosition(manager, _defaultContext(intentHash));
    }

    function test_StakeCoverageMaturesAtHalfOpenDeadlineAndEmptyBatchRejects() public {
        bytes32 intentHash = keccak256("mature-stake");
        _createPosition(intentHash);
        orchestrator.settlePosition(manager, _defaultContext(intentHash));
        uint64 deadline = manager.getRiskPosition(intentHash).coverageDeadline;
        vm.expectRevert(
            abi.encodeWithSelector(IRiskManager.PositionNotMature.selector, deadline, uint64(block.timestamp))
        );
        manager.releaseMaturedPosition(intentHash);
        vm.warp(deadline);
        manager.releaseMaturedPosition(intentHash);
        assertEq(uint256(manager.getRiskPosition(intentHash).status), uint256(IRiskManager.PositionStatus.RELEASED));
        vm.expectRevert(IRiskManager.EmptyBatch.selector);
        manager.releaseMaturedPositions(new bytes32[](0));
    }
}

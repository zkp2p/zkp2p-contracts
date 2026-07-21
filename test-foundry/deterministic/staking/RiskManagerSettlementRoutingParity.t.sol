// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {RiskManagerBoundaryFixture} from "../helpers/RiskManagerBoundaryFixture.sol";
import {PostIntentHookV2Mock} from "contracts/mocks/PostIntentHookV2Mock.sol";
import {IPostIntentHookV2} from "contracts/interfaces/IPostIntentHookV2.sol";
import {IRiskManager} from "contracts/interfaces/IRiskManager.sol";

contract RiskManagerSettlementRoutingParityTest is RiskManagerBoundaryFixture {
    event IntentReferralFeeDistributed(bytes32 indexed intentHash, address indexed recipient, uint256 feeAmount);

    function test_ManualReleaseUsesDeferredCustodyAndSkipsOrdinaryPostHook() public {
        _enableDeferred();
        PostIntentHookV2Mock postHook = new PostIntentHookV2Mock(address(token), address(orchestrator));
        bytes32 intentHash = _signalCustom(
            taker,
            taker,
            100e6,
            PAYPAL,
            _emptyReferralFees(),
            IPostIntentHookV2(address(postHook)),
            abi.encode(recipient)
        );
        uint256 recipientBefore = token.balanceOf(recipient);
        vm.prank(maker);
        orchestrator.releaseFundsToPayer(intentHash);
        assertEq(vault.getDeferredStake(intentHash).grossAmount, 100e6);
        assertEq(token.balanceOf(recipient), recipientBefore);
        assertEq(token.allowance(address(orchestrator), address(manager)), 0);
        assertEq(token.allowance(address(orchestrator), address(postHook)), 0);
    }

    function test_ManualDeferredChargebackSlashesGrossWithoutVestingFees() public {
        _enableDeferred();
        orchestrator.setProtocolFee(ONE_PERCENT);
        bytes32 intentHash = _signalDefault(taker, 100e6, PAYPAL);
        vm.prank(maker);
        orchestrator.releaseFundsToPayer(intentHash);
        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        assertTrue(position.isManualRelease);
        assertEq(position.grossReleasedAmount - position.executableAmount, 1e6);
        manager.submitChargeback(_chargebackClaim(intentHash, 100e6, false));
        assertEq(vault.claimableCompensation(maker), 100e6);
        assertEq(vault.claimableFees(address(this)), 0);
        assertEq(vault.stakeBalance(taker), 0);
        assertEq(vault.totalDeferredFees(), 0);
    }

    function test_ZeroConsumptionPreservesOrdinaryPostIntentHook() public {
        PostIntentHookV2Mock postHook = new PostIntentHookV2Mock(address(token), address(orchestrator));
        bytes32 intentHash = _signalCustom(
            taker, taker, 20e6, ZELLE, _emptyReferralFees(), IPostIntentHookV2(address(postHook)), abi.encode(recipient)
        );
        uint256 recipientBefore = token.balanceOf(recipient);
        _fulfill(intentHash, 20e6);
        assertEq(token.balanceOf(recipient), recipientBefore + 20e6);
        assertEq(token.allowance(address(orchestrator), address(manager)), 0);
        assertEq(token.allowance(address(orchestrator), address(postHook)), 0);
    }

    function test_ZeroConsumptionPaysExactFeePlanBeforeOrdinaryPayout() public {
        orchestrator.setProtocolFee(ONE_PERCENT);
        _configureManagerFee(recipient);
        _depositAsTaker(20e6);
        bytes32 intentHash =
            _signalCustom(taker, taker, 20e6, PAYPAL, _oneReferral(other), IPostIntentHookV2(address(0)), "");
        uint256 protocolBefore = token.balanceOf(address(this));
        uint256 referrerBefore = token.balanceOf(other);
        uint256 managerBefore = token.balanceOf(recipient);
        uint256 takerBefore = token.balanceOf(taker);
        vm.expectEmit(true, true, false, true, address(orchestrator));
        emit IntentReferralFeeDistributed(intentHash, other, 0.2e6);
        _fulfill(intentHash, 20e6);
        assertEq(token.balanceOf(address(this)), protocolBefore + 0.2e6);
        assertEq(token.balanceOf(other), referrerBefore + 0.2e6);
        assertEq(token.balanceOf(recipient), managerBefore + 0.2e6);
        assertEq(token.balanceOf(taker), takerBefore + 19.4e6);
    }
}

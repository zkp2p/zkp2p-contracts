// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {IAddressGroupRegistry} from "contracts/interfaces/IAddressGroupRegistry.sol";
import {IEscrowV2} from "contracts/interfaces/IEscrowV2.sol";
import {IOrchestratorV4} from "contracts/interfaces/IOrchestratorV4.sol";
import {SettlementPolicyMock} from "../../mocks/SettlementPolicyMock.sol";
import {OrchestratorV4Fixture} from "../helpers/OrchestratorV4Fixture.sol";

contract OrchestratorV4ArbitratorTest is OrchestratorV4Fixture {
    event IntentFulfilled(bytes32 indexed intentHash, address indexed fundsTransferredTo, uint256 amount, address releasedBy);

    IAddressGroupRegistry internal groupRegistry;
    address internal curator;
    address internal arbitrator;
    bytes32 internal groupId;
    SettlementPolicyMock internal policyMock;

    function setUp() public override {
        super.setUp();
        groupRegistry = whitelist.groupRegistry();
        curator = makeAddr("curator");
        arbitrator = makeAddr("arbitrator");
        policyMock = new SettlementPolicyMock();

        groupId = _createGroup(curator, taker);
        _allowGroup(depositId, groupId);
    }

    function test_SignalCopiesGroupArbitratorAndChangesOnlyReachNewIntents() public {
        bytes32 before = _signalDefault();
        _setArbitrator(arbitrator);
        bytes32 first = _signalDefault();
        _setArbitrator(other);
        bytes32 second = _signalDefault();
        _setArbitrator(address(0));
        bytes32 third = _signalDefault();

        assertEq(orchestrator.getIntent(before).arbitrator, address(0));
        assertEq(orchestrator.getIntent(first).arbitrator, arbitrator);
        assertEq(orchestrator.getIntent(second).arbitrator, other);
        assertEq(orchestrator.getIntent(third).arbitrator, address(0));

        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV4.UnauthorizedCaller.selector, arbitrator, depositor));
        vm.prank(arbitrator);
        orchestrator.releaseFundsToPayer(second, INTENT_AMOUNT);

        vm.prank(arbitrator);
        orchestrator.releaseFundsToPayer(first, INTENT_AMOUNT);
        assertEq(token.balanceOf(taker), INTENT_AMOUNT);
    }

    function test_SignalWithoutGroupHasNoArbitrator() public {
        _setArbitrator(arbitrator);
        bytes32 intentHash = _signal(taker, super._defaultParams());

        assertEq(orchestrator.getIntent(intentHash).arbitrator, address(0));
    }

    function test_SignalRejectsGroupTheDepositDoesNotAllow() public {
        // A group the seller never allowed can't attach its arbitrator, even when the taker is a member.
        bytes32 unallowed = _createGroup(other, taker);
        vm.prank(other);
        groupRegistry.setArbitrator(unallowed, other);
        IOrchestratorV4.SignalIntentParams memory params = _defaultParams();
        params.groupId = unallowed;

        vm.expectRevert(
            abi.encodeWithSelector(IOrchestratorV4.GroupNotAllowed.selector, address(escrow), depositId, METHOD, unallowed)
        );
        _signalCall(taker, params);
    }

    function test_SignalRejectsTakerOutsideTheGroup() public {
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV4.NotGroupMember.selector, groupId, other));
        _signalCall(other, _defaultParams());
    }

    function test_GroupSignalPassesEnabledWhitelistAndRecordsTakerWhitelisted() public {
        _setArbitrator(arbitrator);
        vm.prank(depositor);
        whitelist.setEnabled(address(escrow), depositId, METHOD, true);

        bytes32 viaGroup = _signalDefault();
        bytes32 withoutGroup = _signal(taker, super._defaultParams());

        assertTrue(orchestrator.getIntent(viaGroup).takerWhitelisted);
        assertEq(orchestrator.getIntent(viaGroup).arbitrator, arbitrator);
        assertTrue(orchestrator.getIntent(withoutGroup).takerWhitelisted);
        assertEq(orchestrator.getIntent(withoutGroup).arbitrator, address(0));

        vm.expectRevert(
            abi.encodeWithSelector(IOrchestratorV4.TakerNotWhitelisted.selector, address(escrow), depositId, METHOD, other)
        );
        _signalCall(other, super._defaultParams());
    }

    function test_ArbitratorReleaseSkipsPolicyAndRecordsReleasedBy() public {
        orchestrator.setSettlementPolicy(policyMock);
        policyMock.setDeferralVault(address(policyMock));
        _setArbitrator(arbitrator);
        bytes32 intentHash = _signalDefault();

        vm.expectEmit(true, true, true, true);
        emit IntentFulfilled(intentHash, taker, INTENT_AMOUNT, arbitrator);
        vm.prank(arbitrator);
        orchestrator.releaseFundsToPayer(intentHash, INTENT_AMOUNT);

        assertEq(policyMock.settlementCalls(), 0);
        assertEq(token.balanceOf(taker), INTENT_AMOUNT);
        assertEq(orchestrator.getIntent(intentHash).owner, address(0));
        assertEq(escrow.getDeposit(depositId).outstandingIntentAmount, 0);
    }

    function test_ArbitratorCancelReturnsFundsToDeposit() public {
        _setArbitrator(arbitrator);
        bytes32 intentHash = _signalDefault();
        uint256 remainingBefore = escrow.getDeposit(depositId).remainingDeposits;

        vm.prank(arbitrator);
        orchestrator.cancelIntent(intentHash);

        assertEq(orchestrator.getIntent(intentHash).owner, address(0));
        assertEq(escrow.getDeposit(depositId).remainingDeposits, remainingBefore + INTENT_AMOUNT);
        assertEq(token.balanceOf(taker), 0);
    }

    function test_ReleaseAndCancelRejectCallersOtherThanPartiesAndArbitrator() public {
        _setArbitrator(arbitrator);
        bytes32 intentHash = _signalDefault();

        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV4.UnauthorizedCaller.selector, other, depositor));
        vm.prank(other);
        orchestrator.releaseFundsToPayer(intentHash, INTENT_AMOUNT);

        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV4.UnauthorizedCaller.selector, other, taker));
        vm.prank(other);
        orchestrator.cancelIntent(intentHash);
    }

    function test_PartialReleaseChargesFeesOnReleasedAmountAndReturnsTheRest() public {
        uint256 releaseAmount = 20e6;
        _setArbitrator(arbitrator);
        IOrchestratorV4.SignalIntentParams memory params = _defaultParams();
        params.referralFees = _twoReferralFees();
        bytes32 intentHash = _signal(taker, params);
        uint256 remainingBefore = escrow.getDeposit(depositId).remainingDeposits;

        vm.expectEmit(true, true, true, true);
        emit IntentFulfilled(intentHash, taker, releaseAmount - 100_000, arbitrator);
        vm.prank(arbitrator);
        orchestrator.releaseFundsToPayer(intentHash, releaseAmount);

        assertEq(token.balanceOf(taker), releaseAmount - 100_000);
        assertEq(token.balanceOf(referrer), 60_000);
        assertEq(token.balanceOf(other), 40_000);
        assertEq(escrow.getDeposit(depositId).remainingDeposits, remainingBefore + INTENT_AMOUNT - releaseAmount);
        assertEq(escrow.getDeposit(depositId).outstandingIntentAmount, 0);
    }

    function test_ArbitratorReleaseAmountMustBeNonZeroAndAtMostTheIntent() public {
        _setArbitrator(arbitrator);
        bytes32 intentHash = _signalDefault();

        vm.expectRevert(IEscrowV2.ZeroValue.selector);
        vm.prank(arbitrator);
        orchestrator.releaseFundsToPayer(intentHash, 0);

        vm.expectRevert(
            abi.encodeWithSelector(IEscrowV2.AmountExceedsAvailable.selector, INTENT_AMOUNT + 1, INTENT_AMOUNT)
        );
        vm.prank(arbitrator);
        orchestrator.releaseFundsToPayer(intentHash, INTENT_AMOUNT + 1);
    }

    function test_DepositorMustReleaseTheFullIntentAmount() public {
        _setArbitrator(arbitrator);
        bytes32 intentHash = _signalDefault();

        vm.expectRevert(
            abi.encodeWithSelector(IOrchestratorV4.PartialReleaseRequiresArbitrator.selector, 1, INTENT_AMOUNT)
        );
        vm.prank(depositor);
        orchestrator.releaseFundsToPayer(intentHash, 1);

        vm.expectRevert(
            abi.encodeWithSelector(IEscrowV2.AmountExceedsAvailable.selector, INTENT_AMOUNT + 1, INTENT_AMOUNT)
        );
        vm.prank(depositor);
        orchestrator.releaseFundsToPayer(intentHash, INTENT_AMOUNT + 1);

        vm.prank(depositor);
        orchestrator.releaseFundsToPayer(intentHash, INTENT_AMOUNT);
        assertEq(token.balanceOf(taker), INTENT_AMOUNT);
    }

    function test_ArbitratorReleaseWorksWhilePaused() public {
        _setArbitrator(arbitrator);
        bytes32 intentHash = _signalDefault();
        orchestrator.pauseOrchestrator();

        vm.prank(arbitrator);
        orchestrator.releaseFundsToPayer(intentHash, INTENT_AMOUNT);

        assertEq(token.balanceOf(taker), INTENT_AMOUNT);
    }

    /// @dev Signals through the arbitrated group unless a test opts out with the fixture's default params.
    function _defaultParams() internal view override returns (IOrchestratorV4.SignalIntentParams memory params) {
        params = super._defaultParams();
        params.groupId = groupId;
    }

    function _createGroup(address groupCurator, address member) internal returns (bytes32 id) {
        address[] memory members = new address[](1);
        members[0] = member;
        vm.startPrank(groupCurator);
        id = groupRegistry.createGroup("arbitrated");
        groupRegistry.addMembers(id, members);
        vm.stopPrank();
    }

    function _allowGroup(uint256 id, bytes32 group) internal {
        bytes32[] memory groups = new bytes32[](1);
        groups[0] = group;
        vm.prank(depositor);
        whitelist.addAllowedGroups(address(escrow), id, METHOD, groups);
    }

    function _setArbitrator(address newArbitrator) internal {
        vm.prank(curator);
        groupRegistry.setArbitrator(groupId, newArbitrator);
    }
}

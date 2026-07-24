// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {IIntentLifecycleHook} from "contracts/interfaces/IIntentLifecycleHook.sol";
import {IOrchestratorV2} from "contracts/interfaces/IOrchestratorV2.sol";
import {IOrchestratorV3} from "contracts/interfaces/IOrchestratorV3.sol";
import {IntentLifecycleHookV1} from "contracts/hooks/IntentLifecycleHookV1.sol";
import {WhitelistPolicy} from "contracts/hooks/WhitelistPolicy.sol";
import {BoundedCall} from "contracts/lib/BoundedCall.sol";
import {IntentLifecycleHookV1Mock} from "contracts/mocks/IntentLifecycleHookV1Mock.sol";
import {AddressGroupRegistry} from "contracts/registries/AddressGroupRegistry.sol";

import {OrchestratorV2LegacyFixture} from "../helpers/OrchestratorV2LegacyFixture.sol";

contract IntentLifecycleHookV1OrchestratorV3Test is OrchestratorV2LegacyFixture {
    bytes32 internal constant PEERS = keccak256("peers");
    bytes32 internal constant PEER_PLUSES = keccak256("peer-pluses");
    bytes32 internal constant PEER_MERCHANTS = keccak256("peer-merchants");

    address internal curator;

    AddressGroupRegistry internal groupRegistry;
    WhitelistPolicy internal policy;
    IntentLifecycleHookV1 internal lifecycleHook;

    function setUp() public override {
        super.setUp();
        _replaceOrchestratorWithStandaloneV3();

        curator = makeAddr("curator");
        groupRegistry = new AddressGroupRegistry(address(this));
        groupRegistry.registerGroup(PEERS, "Peers", curator);
        groupRegistry.registerGroup(PEER_PLUSES, "Peer Pluses", curator);
        groupRegistry.registerGroup(PEER_MERCHANTS, "Peer Merchants", curator);

        policy = new WhitelistPolicy(groupRegistry);
        lifecycleHook = new IntentLifecycleHookV1(orchestratorRegistry, policy);
        IOrchestratorV3(address(orchestrator)).setLifecycleHook(lifecycleHook);
    }

    function test_DisabledPolicyPassesThroughAndSnapshotsGlobalHook() public {
        bytes32 intentHash = _signalDefault();

        assertEq(
            address(IOrchestratorV3(address(orchestrator)).getIntentLifecycleHook(intentHash)), address(lifecycleHook)
        );
        assertEq(escrow.getDepositIntent(depositId, intentHash).intentHash, intentHash);
    }

    function test_EnabledEmptyPolicyFailsClosedBeforeEscrowLock() public {
        vm.prank(depositor);
        policy.setEnabled(true);

        uint256 counterBefore = orchestrator.intentCounter();
        bytes32 rejectedIntent = _intentHash(counterBefore);
        uint256 availableBefore = escrow.getDeposit(depositId).remainingDeposits;

        bytes memory emptyPolicyRevert =
            abi.encodeWithSelector(IntentLifecycleHookV1.TakerNotWhitelisted.selector, depositor, taker);
        vm.expectRevert(
            abi.encodeWithSelector(
                BoundedCall.LifecycleHookAdmissionFailed.selector,
                rejectedIntent,
                address(lifecycleHook),
                emptyPolicyRevert
            )
        );
        _signalCall(taker, _defaultParams());

        assertEq(orchestrator.intentCounter(), counterBefore);
        assertEq(IOrchestratorV3(address(orchestrator)).getIntentContext(rejectedIntent).owner, address(0));
        assertEq(escrow.getDepositIntent(depositId, rejectedIntent).intentHash, bytes32(0));
        assertEq(escrow.getDeposit(depositId).remainingDeposits, availableBefore);
    }

    function test_NonMemberRejectedAndMemberAccepted() public {
        vm.startPrank(depositor);
        policy.addAllowedGroups(_groupIds(PEERS));
        policy.setEnabled(true);
        vm.stopPrank();

        bytes32 rejectedIntent = _intentHash(orchestrator.intentCounter());
        bytes memory nonMemberRevert =
            abi.encodeWithSelector(IntentLifecycleHookV1.TakerNotWhitelisted.selector, depositor, taker);
        vm.expectRevert(
            abi.encodeWithSelector(
                BoundedCall.LifecycleHookAdmissionFailed.selector,
                rejectedIntent,
                address(lifecycleHook),
                nonMemberRevert
            )
        );
        _signalCall(taker, _defaultParams());

        _addMembers(PEERS, taker);
        bytes32 admittedIntent = _signalDefault();
        assertEq(escrow.getDepositIntent(depositId, admittedIntent).intentHash, admittedIntent);
    }

    function test_DirectAddressWhitelistAllowsTaker() public {
        vm.startPrank(depositor);
        policy.addWhitelistedAddresses(_addresses(taker));
        policy.setEnabled(true);
        vm.stopPrank();

        assertNotEq(_signalDefault(), bytes32(0));
    }

    function test_MultipleGroupsUseOrSemantics() public {
        vm.startPrank(depositor);
        policy.addAllowedGroups(_groupIds(PEERS, PEER_PLUSES, PEER_MERCHANTS));
        policy.setEnabled(true);
        vm.stopPrank();

        _addMembers(PEER_PLUSES, taker);
        assertNotEq(_signalDefault(), bytes32(0));
    }

    function test_MakerPolicyAppliesAcrossMakerDeposits() public {
        vm.startPrank(depositor);
        policy.addAllowedGroups(_groupIds(PEERS));
        policy.setEnabled(true);
        uint256 secondDepositId = _createDeposit(address(0), delegate);
        vm.stopPrank();

        IOrchestratorV2.SignalIntentParams memory secondDepositParams = _defaultParams();
        secondDepositParams.depositId = secondDepositId;
        vm.expectPartialRevert(BoundedCall.LifecycleHookAdmissionFailed.selector);
        _signalCall(taker, secondDepositParams);

        _addMembers(PEERS, taker);
        assertNotEq(_signal(taker, secondDepositParams), bytes32(0));
    }

    function test_MembershipRemovalOnlyAffectsFutureAdmissionAndCancellationRemainsLive() public {
        _enablePeerPolicyAndAddTaker();
        bytes32 activeIntent = _signalDefault();

        vm.prank(curator);
        groupRegistry.removeMembers(PEERS, _addresses(taker));
        vm.prank(taker);
        orchestrator.cancelIntent(activeIntent);

        assertEq(escrow.getDepositIntent(depositId, activeIntent).intentHash, bytes32(0));
        assertEq(IOrchestratorV3(address(orchestrator)).getIntentCancellation(activeIntent), 0);

        vm.expectPartialRevert(BoundedCall.LifecycleHookAdmissionFailed.selector);
        _signalCall(taker, _defaultParams());
    }

    function test_GroupDeactivationFailsClosedWithoutMutatingMakerPolicy() public {
        _enablePeerPolicyAndAddTaker();
        groupRegistry.setGroupActive(PEERS, false);

        assertTrue(policy.isGroupAllowed(depositor, PEERS));
        vm.expectPartialRevert(BoundedCall.LifecycleHookAdmissionFailed.selector);
        _signalCall(taker, _defaultParams());
    }

    function test_SettlementIsNoOpAndDoesNotRecheckPointInTimeMembership() public {
        _enablePeerPolicyAndAddTaker();
        bytes32 intentHash = _signalDefault();
        vm.prank(curator);
        groupRegistry.removeMembers(PEERS, _addresses(taker));

        uint256 takerBalanceBefore = token.balanceOf(taker);
        vm.prank(depositor);
        orchestrator.releaseFundsToPayer(intentHash);

        assertEq(token.balanceOf(taker) - takerBalanceBefore, INTENT_AMOUNT);
        assertEq(address(IOrchestratorV3(address(orchestrator)).getIntentLifecycleHook(intentHash)), address(0));
    }

    function test_GlobalHookReplacementDoesNotMutateActiveIntentSnapshot() public {
        _enablePeerPolicyAndAddTaker();
        IOrchestratorV3 riskOrchestrator = IOrchestratorV3(address(orchestrator));
        bytes32 inFlight = _signalDefault();
        assertEq(address(riskOrchestrator.getIntentLifecycleHook(inFlight)), address(lifecycleHook));

        IntentLifecycleHookV1Mock replacementHook = new IntentLifecycleHookV1Mock();
        riskOrchestrator.setLifecycleHook(replacementHook);

        vm.prank(taker);
        orchestrator.cancelIntent(inFlight);
        assertEq(replacementHook.cancelledCalls(), 0);

        bytes32 fresh = _signalDefault();
        assertEq(address(riskOrchestrator.getIntentLifecycleHook(fresh)), address(replacementHook));
        assertEq(replacementHook.createdCalls(), 1);
    }

    function test_MaximumPolicySizeCompletesWithinMinimumBoundedCallbackGas() public {
        bytes32[] memory groups = new bytes32[](10);
        groups[0] = PEERS;
        for (uint256 i = 1; i < groups.length; i++) {
            bytes32 groupId = keccak256(abi.encode("bounded-group", i));
            groupRegistry.registerGroup(groupId, "Bounded Group", curator);
            groups[i] = groupId;
        }

        vm.startPrank(depositor);
        policy.addAllowedGroups(groups);
        policy.setEnabled(true);
        vm.stopPrank();
        _addMembers(groups[groups.length - 1], taker);

        IOrchestratorV3(address(orchestrator)).setCallbackGasLimit(750_000);
        assertNotEq(_signalDefault(), bytes32(0));
    }

    function test_OnlyConfiguredOrchestratorMayCallLifecycleCallbacks() public {
        bytes32 intentHash = keccak256("intent");
        vm.expectRevert(abi.encodeWithSelector(IntentLifecycleHookV1.UnauthorizedOrchestrator.selector, other));
        vm.prank(other);
        lifecycleHook.onIntentCreated(intentHash);

        vm.expectRevert(abi.encodeWithSelector(IntentLifecycleHookV1.UnauthorizedOrchestrator.selector, other));
        vm.prank(other);
        lifecycleHook.onIntentCancelled(intentHash);

        IIntentLifecycleHook.SettlementContext memory context = IIntentLifecycleHook.SettlementContext({
            intentHash: intentHash,
            token: address(token),
            recipient: taker,
            grossAmount: 0,
            executableAmount: 0,
            isManualRelease: false,
            feeAllocations: new IIntentLifecycleHook.FeeAllocation[](0)
        });
        vm.expectRevert(abi.encodeWithSelector(IntentLifecycleHookV1.UnauthorizedOrchestrator.selector, other));
        vm.prank(other);
        lifecycleHook.settleIntent(context);
    }

    function _enablePeerPolicyAndAddTaker() internal {
        vm.startPrank(depositor);
        policy.addAllowedGroups(_groupIds(PEERS));
        policy.setEnabled(true);
        vm.stopPrank();
        _addMembers(PEERS, taker);
    }

    function _addMembers(bytes32 _groupId, address _member) internal {
        vm.prank(curator);
        groupRegistry.addMembers(_groupId, _addresses(_member));
    }

    function _groupIds(bytes32 _first) internal pure returns (bytes32[] memory groupIds) {
        groupIds = new bytes32[](1);
        groupIds[0] = _first;
    }

    function _groupIds(bytes32 _first, bytes32 _second, bytes32 _third)
        internal
        pure
        returns (bytes32[] memory groupIds)
    {
        groupIds = new bytes32[](3);
        groupIds[0] = _first;
        groupIds[1] = _second;
        groupIds[2] = _third;
    }

    function _addresses(address _member) internal pure returns (address[] memory members) {
        members = new address[](1);
        members[0] = _member;
    }
}

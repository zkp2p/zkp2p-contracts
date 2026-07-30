// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {IIntentLifecycleHook} from "contracts/interfaces/IIntentLifecycleHook.sol";
import {IEscrowV2} from "contracts/interfaces/IEscrowV2.sol";
import {IOrchestratorRegistry} from "contracts/interfaces/IOrchestratorRegistry.sol";
import {IOrchestratorV3} from "contracts/interfaces/IOrchestratorV3.sol";
import {StakeVault} from "contracts/StakeVault.sol";
import {ChargebackPolicy} from "contracts/hooks/ChargebackPolicy.sol";
import {IntentLifecycleHookV1} from "contracts/hooks/IntentLifecycleHookV1.sol";
import {WhitelistPolicy} from "contracts/hooks/WhitelistPolicy.sol";
import {AttestationVerifierMock} from "contracts/mocks/AttestationVerifierMock.sol";
import {IntentLifecycleHookV1Mock} from "contracts/mocks/IntentLifecycleHookV1Mock.sol";
import {AddressGroupRegistry} from "contracts/registries/AddressGroupRegistry.sol";
import {NullifierRegistry} from "contracts/registries/NullifierRegistry.sol";
import {NullifierRegistryV2} from "contracts/registries/NullifierRegistryV2.sol";
import {ChargebackVerifier} from "contracts/unifiedVerifier/ChargebackVerifier.sol";

import {OrchestratorV3Fixture} from "../helpers/OrchestratorV3Fixture.sol";

contract IntentLifecycleHookV1OrchestratorV3Test is OrchestratorV3Fixture {
    bytes32 internal constant OTHER_METHOD = keccak256("zelle");

    bytes32 internal PEERS;
    bytes32 internal PEER_PLUSES;
    bytes32 internal PEER_MERCHANTS;

    AddressGroupRegistry internal groupRegistry;
    WhitelistPolicy internal policy;
    StakeVault internal stakeVault;
    ChargebackPolicy internal chargebackPolicy;
    IntentLifecycleHookV1 internal lifecycleHook;

    function setUp() public override {
        super.setUp();
        groupRegistry = new AddressGroupRegistry();
        PEERS = groupRegistry.createGroup("Peers");
        PEER_PLUSES = groupRegistry.createGroup("Peer Pluses");
        PEER_MERCHANTS = groupRegistry.createGroup("Peer Merchants");

        policy = new WhitelistPolicy(groupRegistry, escrowRegistry, orchestratorRegistry);
        stakeVault = new StakeVault(address(this), token, address(0), 1 days);
        NullifierRegistry chargebackNullifierRegistry = new NullifierRegistry();
        chargebackPolicy = new ChargebackPolicy(
            address(this),
            stakeVault,
            new ChargebackVerifier(
                address(this), new NullifierRegistryV2(new NullifierRegistry()), new AttestationVerifierMock()
            ),
            chargebackNullifierRegistry
        );
        stakeVault.initializeController(address(chargebackPolicy));
        chargebackNullifierRegistry.addWritePermission(address(chargebackPolicy));
        lifecycleHook = new IntentLifecycleHookV1(orchestratorRegistry, policy, chargebackPolicy);
        chargebackPolicy.setLifecycleHookAuthorization(address(lifecycleHook), true);
        IOrchestratorV3(address(orchestrator)).setLifecycleHook(lifecycleHook);
    }

    function test_ConstructorRejectsZeroAndNonContractDependencies() public {
        vm.expectRevert(IntentLifecycleHookV1.ZeroAddress.selector);
        new IntentLifecycleHookV1(IOrchestratorRegistry(address(0)), policy, chargebackPolicy);

        vm.expectRevert(abi.encodeWithSelector(IntentLifecycleHookV1.InvalidDependency.selector, other));
        new IntentLifecycleHookV1(IOrchestratorRegistry(other), policy, chargebackPolicy);
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
        policy.setEnabled(address(escrow), depositId, true);

        uint256 counterBefore = orchestrator.intentCounter();
        bytes32 rejectedIntent = _intentHash(counterBefore);
        uint256 availableBefore = escrow.getDeposit(depositId).remainingDeposits;

        vm.expectRevert(
            abi.encodeWithSelector(
                IntentLifecycleHookV1.TakerNotWhitelisted.selector, address(escrow), depositId, taker
            )
        );
        _signalCall(taker, _defaultParams());

        assertEq(orchestrator.intentCounter(), counterBefore);
        assertEq(IOrchestratorV3(address(orchestrator)).getIntent(rejectedIntent).owner, address(0));
        assertEq(escrow.getDepositIntent(depositId, rejectedIntent).intentHash, bytes32(0));
        assertEq(escrow.getDeposit(depositId).remainingDeposits, availableBefore);
    }

    function test_NonMemberRejectedAndMemberAccepted() public {
        vm.prank(depositor);
        policy.configureDeposit(address(escrow), depositId, true, _groupIds(PEERS), new address[](0));

        vm.expectRevert(
            abi.encodeWithSelector(
                IntentLifecycleHookV1.TakerNotWhitelisted.selector, address(escrow), depositId, taker
            )
        );
        _signalCall(taker, _defaultParams());

        _addMembers(PEERS, taker);
        bytes32 admittedIntent = _signalDefault();
        assertEq(escrow.getDepositIntent(depositId, admittedIntent).intentHash, admittedIntent);
    }

    function test_DirectAddressWhitelistAllowsTaker() public {
        vm.prank(depositor);
        policy.configureDeposit(address(escrow), depositId, true, new bytes32[](0), _addresses(taker));

        assertNotEq(_signalDefault(), bytes32(0));
    }

    function test_DelegateIsNotAuthorizedToConfigureDeposit() public {
        vm.expectRevert(
            abi.encodeWithSelector(WhitelistPolicy.NotDepositor.selector, address(escrow), depositId, delegate)
        );
        vm.prank(delegate);
        policy.configureDeposit(address(escrow), depositId, true, new bytes32[](0), new address[](0));

        vm.prank(depositor);
        policy.configureDeposit(address(escrow), depositId, true, new bytes32[](0), new address[](0));
        assertTrue(policy.enabled(address(escrow), depositId));
    }

    function test_DepositPolicyAppliesAcrossAllPaymentMethodsOfTheDeposit() public {
        _addPaymentMethod(OTHER_METHOD);

        vm.prank(depositor);
        policy.configureDeposit(address(escrow), depositId, true, _groupIds(PEERS), new address[](0));

        IOrchestratorV3.SignalIntentParams memory otherMethodParams = _defaultParams();
        otherMethodParams.paymentMethod = OTHER_METHOD;
        vm.expectPartialRevert(IntentLifecycleHookV1.TakerNotWhitelisted.selector);
        _signalCall(taker, otherMethodParams);

        _addMembers(PEERS, taker);
        assertNotEq(_signal(taker, otherMethodParams), bytes32(0));
        assertNotEq(_signalDefault(), bytes32(0));
    }

    function test_MultipleGroupsUseOrSemantics() public {
        vm.prank(depositor);
        policy.configureDeposit(
            address(escrow), depositId, true, _groupIds(PEERS, PEER_PLUSES, PEER_MERCHANTS), new address[](0)
        );

        _addMembers(PEER_PLUSES, taker);
        assertNotEq(_signalDefault(), bytes32(0));
    }

    function test_PolicyIsScopedToDepositNotMaker() public {
        vm.startPrank(depositor);
        policy.configureDeposit(address(escrow), depositId, true, _groupIds(PEERS), new address[](0));
        uint256 secondDepositId = _createDeposit(address(0), delegate);
        vm.stopPrank();

        vm.expectPartialRevert(IntentLifecycleHookV1.TakerNotWhitelisted.selector);
        _signalCall(taker, _defaultParams());

        IOrchestratorV3.SignalIntentParams memory secondDepositParams = _defaultParams();
        secondDepositParams.depositId = secondDepositId;
        assertNotEq(_signal(taker, secondDepositParams), bytes32(0));

        vm.prank(depositor);
        policy.configureDeposit(address(escrow), secondDepositId, true, _groupIds(PEERS), new address[](0));
        vm.expectPartialRevert(IntentLifecycleHookV1.TakerNotWhitelisted.selector);
        _signalCall(taker, secondDepositParams);
    }

    function test_MembershipRemovalOnlyAffectsFutureAdmissionAndCancellationRemainsLive() public {
        _enablePeerPolicyAndAddTaker();
        bytes32 activeIntent = _signalDefault();

        groupRegistry.removeMembers(PEERS, _addresses(taker));
        vm.prank(taker);
        orchestrator.cancelIntent(activeIntent);

        assertEq(escrow.getDepositIntent(depositId, activeIntent).intentHash, bytes32(0));

        vm.expectPartialRevert(IntentLifecycleHookV1.TakerNotWhitelisted.selector);
        _signalCall(taker, _defaultParams());
    }

    function test_SettlementIsNoOpAndDoesNotRecheckPointInTimeMembership() public {
        _enablePeerPolicyAndAddTaker();
        bytes32 intentHash = _signalDefault();
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
        assertEq(replacementHook.signaledCalls(), 1);
    }

    function test_MaximumPolicySizeAdmitsMemberOfLastGroup() public {
        bytes32[] memory groups = new bytes32[](10);
        groups[0] = PEERS;
        for (uint256 i = 1; i < groups.length; i++) {
            groups[i] = groupRegistry.createGroup("Bounded Group");
        }

        vm.prank(depositor);
        policy.configureDeposit(address(escrow), depositId, true, groups, new address[](0));
        _addMembers(groups[groups.length - 1], taker);

        assertNotEq(_signalDefault(), bytes32(0));
    }

    function test_OnlyConfiguredOrchestratorMayCallLifecycleCallbacks() public {
        bytes32 intentHash = keccak256("intent");
        vm.expectRevert(abi.encodeWithSelector(IntentLifecycleHookV1.UnauthorizedOrchestrator.selector, other));
        vm.prank(other);
        lifecycleHook.onIntentSignaled(intentHash);

        vm.expectRevert(abi.encodeWithSelector(IntentLifecycleHookV1.UnauthorizedOrchestrator.selector, other));
        vm.prank(other);
        lifecycleHook.onIntentCancelled(intentHash);

        IIntentLifecycleHook.SettlementContext memory context = IIntentLifecycleHook.SettlementContext({
            intentHash: intentHash,
            token: address(token),
            recipient: taker,
            releaseAmount: 0,
            netAmount: 0,
            isManualRelease: false
        });
        vm.expectRevert(abi.encodeWithSelector(IntentLifecycleHookV1.UnauthorizedOrchestrator.selector, other));
        vm.prank(other);
        lifecycleHook.settleIntent(context);
    }

    function test_RegisteredOrchestratorWithUnknownIntentFailsClosed() public {
        bytes32 unknownIntent = keccak256("unknown-intent");
        vm.expectRevert(abi.encodeWithSelector(IntentLifecycleHookV1.IntentNotFound.selector, unknownIntent));
        vm.prank(address(orchestrator));
        lifecycleHook.onIntentSignaled(unknownIntent);
    }

    function _enablePeerPolicyAndAddTaker() internal {
        vm.prank(depositor);
        policy.configureDeposit(address(escrow), depositId, true, _groupIds(PEERS), new address[](0));
        _addMembers(PEERS, taker);
    }

    function _addPaymentMethod(bytes32 _paymentMethod) internal {
        bytes32[] memory supportedCurrencies = new bytes32[](1);
        supportedCurrencies[0] = USD;
        paymentVerifierRegistry.addPaymentMethod(_paymentMethod, address(verifier), supportedCurrencies);

        bytes32[] memory paymentMethods = new bytes32[](1);
        paymentMethods[0] = _paymentMethod;
        IEscrowV2.DepositPaymentMethodData[] memory paymentMethodData = new IEscrowV2.DepositPaymentMethodData[](1);
        paymentMethodData[0] =
            IEscrowV2.DepositPaymentMethodData({intentGatingService: address(0), payeeDetails: PAYEE, data: ""});
        IEscrowV2.Currency[][] memory currencies = new IEscrowV2.Currency[][](1);
        currencies[0] = new IEscrowV2.Currency[](1);
        currencies[0][0] =
            IEscrowV2.Currency({code: USD, minConversionRate: CONVERSION_RATE, oracleRateConfig: _emptyOracle()});

        vm.prank(depositor);
        escrow.addPaymentMethods(depositId, paymentMethods, paymentMethodData, currencies);
    }

    function _addMembers(bytes32 _groupId, address _member) internal {
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

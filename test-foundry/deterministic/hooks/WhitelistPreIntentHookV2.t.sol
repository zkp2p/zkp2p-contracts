// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {EscrowV2} from "contracts/EscrowV2.sol";
import {OrchestratorV3} from "contracts/OrchestratorV3.sol";
import {WhitelistPreIntentHookV2} from "contracts/hooks/WhitelistPreIntentHookV2.sol";
import {AddressGroupRegistry} from "contracts/registries/AddressGroupRegistry.sol";
import {WhitelistResolverMock} from "contracts/mocks/WhitelistResolverMock.sol";
import {PaymentVerifierMock} from "contracts/mocks/PaymentVerifierMock.sol";
import {USDCMock} from "contracts/mocks/USDCMock.sol";
import {EscrowRegistry} from "contracts/registries/EscrowRegistry.sol";
import {OrchestratorRegistry} from "contracts/registries/OrchestratorRegistry.sol";
import {PaymentVerifierRegistry} from "contracts/registries/PaymentVerifierRegistry.sol";
import {IEscrowV2} from "contracts/interfaces/IEscrowV2.sol";
import {IOrchestratorV3} from "contracts/interfaces/IOrchestratorV3.sol";
import {IPostIntentHookV2} from "contracts/interfaces/IPostIntentHookV2.sol";
import {IPreIntentHook} from "contracts/interfaces/IPreIntentHook.sol";
import {IReferralFee} from "contracts/interfaces/IReferralFee.sol";

contract WhitelistPreIntentHookV2Test is Test {
    event TakerWhitelisted(address indexed escrow, uint256 indexed depositId, address indexed taker);
    event TakerRemovedFromWhitelist(address indexed escrow, uint256 indexed depositId, address indexed taker);
    event GroupAttached(address indexed escrow, uint256 indexed depositId, uint256 indexed groupId);
    event GroupDetached(address indexed escrow, uint256 indexed depositId, uint256 indexed groupId);

    uint256 internal constant CHAIN_ID = 1;
    uint256 internal constant INTENT_AMOUNT = 50e6;
    uint256 internal constant CONVERSION_RATE = 1.02e18;
    bytes32 internal constant METHOD = keccak256("venmo");
    bytes32 internal constant USD = keccak256("USD");
    bytes32 internal constant PAYEE = keccak256("payeeDetails");

    address internal depositor;
    address internal delegate;
    address internal taker;
    address internal takerTwo;
    address internal unauthorized;
    USDCMock internal token;
    EscrowV2 internal escrow;
    OrchestratorV3 internal orchestrator;
    OrchestratorRegistry internal orchestratorRegistry;
    AddressGroupRegistry internal groupRegistry;
    WhitelistPreIntentHookV2 internal hook;
    WhitelistResolverMock internal resolverMock;

    function setUp() public {
        depositor = makeAddr("depositor");
        delegate = makeAddr("delegate");
        taker = makeAddr("taker");
        takerTwo = makeAddr("takerTwo");
        unauthorized = makeAddr("unauthorized");
        token = new USDCMock(1_000_000_000e6, "USDC", "USDC");
        token.transfer(depositor, 10_000e6);

        EscrowRegistry escrowRegistry = new EscrowRegistry();
        PaymentVerifierRegistry paymentVerifierRegistry = new PaymentVerifierRegistry();
        orchestratorRegistry = new OrchestratorRegistry();
        PaymentVerifierMock verifier = new PaymentVerifierMock();
        bytes32[] memory currencies = new bytes32[](1);
        currencies[0] = USD;
        paymentVerifierRegistry.addPaymentMethod(METHOD, address(verifier), currencies);

        escrow = new EscrowV2(
            address(this),
            CHAIN_ID,
            address(orchestratorRegistry),
            address(paymentVerifierRegistry),
            address(0),
            0,
            10,
            1 hours
        );
        escrowRegistry.addEscrow(address(escrow));
        orchestrator = new OrchestratorV3(
            address(this),
            CHAIN_ID,
            address(escrowRegistry),
            address(paymentVerifierRegistry),
            0,
            address(this),
            2_000_000 // risk callback gas limit (min 750k); no risk hooks are set in these tests
        );
        orchestratorRegistry.addOrchestrator(address(orchestrator));
        verifier.setVerificationContext(address(orchestrator), address(escrow));

        groupRegistry = new AddressGroupRegistry();
        hook = new WhitelistPreIntentHookV2(address(orchestratorRegistry), address(groupRegistry));
        resolverMock = new WhitelistResolverMock();

        vm.startPrank(depositor);
        token.approve(address(escrow), 10_000e6);
        _createDeposit();
        vm.stopPrank();

        vm.prank(depositor);
        orchestrator.setDepositWhitelistHook(address(escrow), 0, IPreIntentHook(address(hook)));
    }

    function _createDeposit() internal {
        bytes32[] memory methods = new bytes32[](1);
        methods[0] = METHOD;
        IEscrowV2.DepositPaymentMethodData[] memory methodData = new IEscrowV2.DepositPaymentMethodData[](1);
        methodData[0] =
            IEscrowV2.DepositPaymentMethodData({intentGatingService: address(0), payeeDetails: PAYEE, data: ""});
        IEscrowV2.Currency[][] memory currencies = new IEscrowV2.Currency[][](1);
        currencies[0] = new IEscrowV2.Currency[](1);
        currencies[0][0] = IEscrowV2.Currency({
            code: USD,
            minConversionRate: 1.01e18,
            oracleRateConfig: IEscrowV2.OracleRateConfig({
                adapter: address(0), adapterConfig: "", spreadBps: 0, maxStaleness: 0
            })
        });
        escrow.createDeposit(
            IEscrowV2.CreateDepositParams({
                token: IERC20(address(token)),
                amount: 100e6,
                intentAmountRange: IEscrowV2.Range({min: 10e6, max: 200e6}),
                paymentMethods: methods,
                paymentMethodData: methodData,
                currencies: currencies,
                delegate: delegate,
                intentGuardian: address(0),
                retainOnEmpty: false
            })
        );
    }

    function _address(address value) internal pure returns (address[] memory values) {
        values = new address[](1);
        values[0] = value;
    }

    function _addresses(address first, address second) internal pure returns (address[] memory values) {
        values = new address[](2);
        values[0] = first;
        values[1] = second;
    }

    function _groupIds(uint256 value) internal pure returns (uint256[] memory values) {
        values = new uint256[](1);
        values[0] = value;
    }

    function _add(address caller, address[] memory takers) internal {
        vm.prank(caller);
        hook.addToWhitelist(address(escrow), 0, takers);
    }

    function _remove(address caller, address[] memory takers) internal {
        vm.prank(caller);
        hook.removeFromWhitelist(address(escrow), 0, takers);
    }

    function _signalParams() internal view returns (IOrchestratorV3.SignalIntentParams memory params) {
        IReferralFee.ReferralFee[] memory referralFees = new IReferralFee.ReferralFee[](0);
        params = IOrchestratorV3.SignalIntentParams({
            escrow: address(escrow),
            depositId: 0,
            amount: INTENT_AMOUNT,
            to: taker,
            paymentMethod: METHOD,
            fiatCurrency: USD,
            conversionRate: CONVERSION_RATE,
            referralFees: referralFees,
            gatingServiceSignature: "",
            signatureExpiration: 0,
            postIntentHook: IPostIntentHookV2(address(0)),
            preIntentHookData: "",
            data: ""
        });
    }

    function _signalCall() internal {
        vm.prank(taker);
        orchestrator.signalIntent(_signalParams());
    }

    function _expectNotWhitelistedRevert() internal {
        vm.expectRevert(
            abi.encodeWithSelector(WhitelistPreIntentHookV2.TakerNotWhitelisted.selector, taker, address(escrow), 0)
        );
    }

    /* ============ constructor ============ */

    function test_ConstructorRejectsZeroAddresses() public {
        vm.expectRevert(WhitelistPreIntentHookV2.ZeroAddress.selector);
        new WhitelistPreIntentHookV2(address(0), address(groupRegistry));
        vm.expectRevert(WhitelistPreIntentHookV2.ZeroAddress.selector);
        new WhitelistPreIntentHookV2(address(orchestratorRegistry), address(0));
    }

    function test_ConstructorStoresImmutables() public view {
        assertEq(address(hook.orchestratorRegistry()), address(orchestratorRegistry));
        assertEq(address(hook.groupRegistry()), address(groupRegistry));
    }

    /* ============ direct whitelist management ============ */

    function test_DepositorAddsTakersAndEmitsPerTaker() public {
        vm.expectEmit(true, true, true, true, address(hook));
        emit TakerWhitelisted(address(escrow), 0, taker);
        vm.expectEmit(true, true, true, true, address(hook));
        emit TakerWhitelisted(address(escrow), 0, takerTwo);
        _add(depositor, _addresses(taker, takerTwo));
        assertTrue(hook.isWhitelisted(address(escrow), 0, taker));
        assertTrue(hook.isWhitelisted(address(escrow), 0, takerTwo));
    }

    function test_DelegateCanAddTakers() public {
        _add(delegate, _address(taker));
        assertTrue(hook.isWhitelisted(address(escrow), 0, taker));
    }

    function test_UnauthorizedCannotAddTakers() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                WhitelistPreIntentHookV2.UnauthorizedCallerOrDelegate.selector, unauthorized, depositor, delegate
            )
        );
        _add(unauthorized, _address(taker));
    }

    function test_AddExistingTakerIsNoOpWithoutEvent() public {
        _add(depositor, _address(taker));
        vm.recordLogs();
        _add(depositor, _address(taker));
        assertEq(vm.getRecordedLogs().length, 0);
        assertTrue(hook.isWhitelisted(address(escrow), 0, taker));
    }

    function test_RemoveAbsentTakerIsNoOpWithoutEvent() public {
        vm.recordLogs();
        _remove(depositor, _address(taker));
        assertEq(vm.getRecordedLogs().length, 0);
    }

    function test_DepositorRemovesTakerAndEmits() public {
        _add(depositor, _addresses(taker, takerTwo));
        vm.expectEmit(true, true, true, true, address(hook));
        emit TakerRemovedFromWhitelist(address(escrow), 0, taker);
        _remove(depositor, _address(taker));
        assertFalse(hook.isWhitelisted(address(escrow), 0, taker));
        assertTrue(hook.isWhitelisted(address(escrow), 0, takerTwo));
    }

    function test_ZeroEscrowReverts() public {
        vm.expectRevert(WhitelistPreIntentHookV2.ZeroAddress.selector);
        vm.prank(depositor);
        hook.addToWhitelist(address(0), 0, _address(taker));
    }

    function test_EmptyBatchReverts() public {
        vm.expectRevert(WhitelistPreIntentHookV2.EmptyArray.selector);
        vm.prank(depositor);
        hook.addToWhitelist(address(escrow), 0, new address[](0));
        vm.expectRevert(WhitelistPreIntentHookV2.EmptyArray.selector);
        vm.prank(depositor);
        hook.removeFromWhitelist(address(escrow), 0, new address[](0));
    }

    function test_ZeroTakerReverts() public {
        vm.expectRevert(WhitelistPreIntentHookV2.ZeroAddress.selector);
        _add(depositor, _address(address(0)));
        vm.expectRevert(WhitelistPreIntentHookV2.ZeroAddress.selector);
        _remove(depositor, _address(address(0)));
    }

    function test_ZeroTakerInBatchRevertsWholeTransaction() public {
        vm.expectRevert(WhitelistPreIntentHookV2.ZeroAddress.selector);
        _add(depositor, _addresses(taker, address(0)));
        assertFalse(hook.isWhitelisted(address(escrow), 0, taker)); // earlier element rolled back

        _add(depositor, _address(taker));
        vm.expectRevert(WhitelistPreIntentHookV2.ZeroAddress.selector);
        _remove(depositor, _addresses(taker, address(0)));
        assertTrue(hook.isWhitelisted(address(escrow), 0, taker)); // removal rolled back
    }

    function test_MixedBatchEmitsOnlyForStateChanges() public {
        _add(depositor, _address(taker));
        vm.recordLogs();
        _add(depositor, _addresses(taker, takerTwo)); // taker existing, takerTwo new
        assertEq(vm.getRecordedLogs().length, 1); // only takerTwo's TakerWhitelisted
        assertTrue(hook.isWhitelisted(address(escrow), 0, takerTwo));
    }

    /* ============ validateSignalIntent — direct path ============ */

    function test_DirectlyWhitelistedTakerCanSignal() public {
        _add(depositor, _address(taker));
        _signalCall();
        assertEq(orchestrator.getAccountIntents(taker).length, 1);
    }

    function test_UnknownTakerCannotSignal() public {
        _expectNotWhitelistedRevert();
        _signalCall();
    }

    function test_RemovedTakerCannotSignal() public {
        _add(depositor, _address(taker));
        _remove(depositor, _address(taker));
        _expectNotWhitelistedRevert();
        _signalCall();
    }

    function test_DirectValidateCallRejectsNonOrchestrator() public {
        IReferralFee.ReferralFee[] memory referralFees = new IReferralFee.ReferralFee[](0);
        IPreIntentHook.PreIntentContext memory context = IPreIntentHook.PreIntentContext({
            taker: taker,
            escrow: address(escrow),
            depositId: 0,
            amount: INTENT_AMOUNT,
            to: taker,
            paymentMethod: METHOD,
            fiatCurrency: USD,
            conversionRate: CONVERSION_RATE,
            referralFees: referralFees,
            preIntentHookData: ""
        });
        vm.expectRevert(
            abi.encodeWithSelector(WhitelistPreIntentHookV2.UnauthorizedOrchestratorCaller.selector, taker)
        );
        vm.prank(taker);
        hook.validateSignalIntent(context);
    }
    /* ============ group attachment ============ */

    function _newGroup(address groupOwner) internal returns (uint256 groupId) {
        vm.prank(groupOwner);
        groupId = groupRegistry.createGroup("g");
    }

    function _attach(address caller, uint256[] memory ids) internal {
        vm.prank(caller);
        hook.attachGroups(address(escrow), 0, ids);
    }

    function _detach(address caller, uint256[] memory ids) internal {
        vm.prank(caller);
        hook.detachGroups(address(escrow), 0, ids);
    }

    function test_DepositorAttachesGroupAndEmits() public {
        uint256 groupId = _newGroup(depositor);
        vm.expectEmit(true, true, true, true, address(hook));
        emit GroupAttached(address(escrow), 0, groupId);
        _attach(depositor, _groupIds(groupId));
        assertTrue(hook.isGroupAttached(address(escrow), 0, groupId));
        uint256[] memory attached = hook.getAttachedGroups(address(escrow), 0);
        assertEq(attached.length, 1);
        assertEq(attached[0], groupId);
    }

    function test_DelegateCanAttachGroups() public {
        uint256 groupId = _newGroup(depositor);
        _attach(delegate, _groupIds(groupId));
        assertTrue(hook.isGroupAttached(address(escrow), 0, groupId));
    }

    function test_UnauthorizedCannotAttachGroups() public {
        uint256 groupId = _newGroup(depositor);
        vm.expectRevert(
            abi.encodeWithSelector(
                WhitelistPreIntentHookV2.UnauthorizedCallerOrDelegate.selector, unauthorized, depositor, delegate
            )
        );
        _attach(unauthorized, _groupIds(groupId));
    }

    function test_AttachNonexistentGroupReverts() public {
        vm.expectRevert(abi.encodeWithSelector(WhitelistPreIntentHookV2.GroupDoesNotExist.selector, 42));
        _attach(depositor, _groupIds(42));
    }

    function test_AttachGroupZeroReverts() public {
        vm.expectRevert(abi.encodeWithSelector(WhitelistPreIntentHookV2.GroupDoesNotExist.selector, 0));
        _attach(depositor, _groupIds(0));
    }

    function test_AttachEmptyArrayReverts() public {
        vm.expectRevert(WhitelistPreIntentHookV2.EmptyArray.selector);
        _attach(depositor, new uint256[](0));
    }

    function test_NonexistentIdInBatchRevertsWholeAttach() public {
        uint256 valid = _newGroup(depositor);
        uint256[] memory mixed = new uint256[](2);
        mixed[0] = valid;
        mixed[1] = 999; // nonexistent
        vm.expectRevert(abi.encodeWithSelector(WhitelistPreIntentHookV2.GroupDoesNotExist.selector, 999));
        _attach(depositor, mixed);
        assertFalse(hook.isGroupAttached(address(escrow), 0, valid)); // earlier element rolled back
    }

    function test_DetachEmptyArrayReverts() public {
        vm.expectRevert(WhitelistPreIntentHookV2.EmptyArray.selector);
        _detach(depositor, new uint256[](0));
    }

    function test_AttachAlreadyAttachedIsNoOpWithoutEvent() public {
        uint256 groupId = _newGroup(depositor);
        _attach(depositor, _groupIds(groupId));
        vm.recordLogs();
        _attach(depositor, _groupIds(groupId));
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(hook.getAttachedGroups(address(escrow), 0).length, 1);
    }

    function test_DetachAbsentGroupIsNoOpWithoutEvent() public {
        vm.recordLogs();
        _detach(depositor, _groupIds(7));
        assertEq(vm.getRecordedLogs().length, 0);
    }

    function test_DetachGroupZeroIsNoOp() public {
        vm.recordLogs();
        _detach(depositor, _groupIds(0));
        assertEq(vm.getRecordedLogs().length, 0);
    }

    function test_MaxGroupsCapEnforced() public {
        uint256[] memory ids = new uint256[](11);
        for (uint256 i = 0; i < 11; i++) {
            ids[i] = _newGroup(depositor);
        }
        uint256[] memory firstTen = new uint256[](10);
        for (uint256 i = 0; i < 10; i++) {
            firstTen[i] = ids[i];
        }
        _attach(depositor, firstTen);
        vm.expectRevert(abi.encodeWithSelector(WhitelistPreIntentHookV2.MaxGroupsExceeded.selector, 11, 10));
        _attach(depositor, _groupIds(ids[10]));
    }

    function test_DetachSwapAndPopKeepsIndexIntegrity() public {
        uint256 a = _newGroup(depositor);
        uint256 b = _newGroup(depositor);
        uint256 c = _newGroup(depositor);
        uint256[] memory all = new uint256[](3);
        all[0] = a; all[1] = b; all[2] = c;
        _attach(depositor, all);

        vm.expectEmit(true, true, true, true, address(hook));
        emit GroupDetached(address(escrow), 0, a);
        _detach(depositor, _groupIds(a));

        uint256[] memory attached = hook.getAttachedGroups(address(escrow), 0);
        assertEq(attached.length, 2);
        assertEq(attached[0], c); // last element swapped into a's slot
        assertEq(attached[1], b);
        assertFalse(hook.isGroupAttached(address(escrow), 0, a));
        assertTrue(hook.isGroupAttached(address(escrow), 0, b));
        assertTrue(hook.isGroupAttached(address(escrow), 0, c));

        // detach the (moved) last element too
        _detach(depositor, _groupIds(b));
        attached = hook.getAttachedGroups(address(escrow), 0);
        assertEq(attached.length, 1);
        assertEq(attached[0], c);
    }

    function test_DetachedGroupCanBeReattached() public {
        uint256 groupId = _newGroup(depositor);
        _attach(depositor, _groupIds(groupId));
        _detach(depositor, _groupIds(groupId));
        _attach(depositor, _groupIds(groupId));
        assertTrue(hook.isGroupAttached(address(escrow), 0, groupId));
    }

    /* ============ validateSignalIntent — group path ============ */

    function test_CuratedGroupMemberCanSignal() public {
        uint256 groupId = _newGroup(depositor);
        vm.prank(depositor);
        groupRegistry.addMembers(groupId, _address(taker));
        _attach(depositor, _groupIds(groupId));
        _signalCall();
        assertEq(orchestrator.getAccountIntents(taker).length, 1);
    }

    function test_ThirdPartyGroupMemberCanSignal() public {
        address thirdParty = makeAddr("thirdParty");
        uint256 groupId = _newGroup(thirdParty);
        vm.prank(thirdParty);
        groupRegistry.addMembers(groupId, _address(taker));
        _attach(depositor, _groupIds(groupId));
        _signalCall();
        assertEq(orchestrator.getAccountIntents(taker).length, 1);
    }

    function test_ResolverGroupMemberCanSignal() public {
        uint256 groupId = _newGroup(depositor);
        vm.prank(depositor);
        groupRegistry.setResolver(groupId, address(resolverMock));
        resolverMock.setMemberOf(groupId, taker, true);
        _attach(depositor, _groupIds(groupId));
        _signalCall();
        assertEq(orchestrator.getAccountIntents(taker).length, 1);
    }

    function test_NonMemberOfAttachedGroupsCannotSignal() public {
        uint256 groupId = _newGroup(depositor);
        _attach(depositor, _groupIds(groupId));
        _expectNotWhitelistedRevert();
        _signalCall();
    }

    function test_MatchInLastOfTenGroupsSignals() public {
        uint256[] memory ids = new uint256[](10);
        for (uint256 i = 0; i < 10; i++) {
            ids[i] = _newGroup(depositor);
        }
        _attach(depositor, ids);
        vm.prank(depositor);
        groupRegistry.addMembers(ids[9], _address(taker));
        _signalCall();
        assertEq(orchestrator.getAccountIntents(taker).length, 1);
    }

    function test_MatchInMiddleOfTenGroupsSignals() public {
        uint256[] memory ids = new uint256[](10);
        for (uint256 i = 0; i < 10; i++) {
            ids[i] = _newGroup(depositor);
        }
        _attach(depositor, ids);
        vm.prank(depositor);
        groupRegistry.addMembers(ids[5], _address(taker));
        _signalCall();
        assertEq(orchestrator.getAccountIntents(taker).length, 1);
    }

    function test_DirectMatchShortCircuitsWithoutRegistryCalls() public {
        uint256 groupId = _newGroup(depositor);
        _attach(depositor, _groupIds(groupId));
        _add(depositor, _address(taker));
        vm.expectCall(address(groupRegistry), abi.encodeCall(groupRegistry.isMember, (groupId, taker)), 0);
        _signalCall();
        assertEq(orchestrator.getAccountIntents(taker).length, 1);
    }

    function test_GroupMatchShortCircuitsLaterGroupResolvers() public {
        uint256 first = _newGroup(depositor);
        uint256 second = _newGroup(depositor);
        vm.prank(depositor);
        groupRegistry.addMembers(first, _address(taker));
        vm.prank(depositor);
        groupRegistry.setResolver(second, address(resolverMock));
        uint256[] memory both = new uint256[](2);
        both[0] = first; both[1] = second;
        _attach(depositor, both);
        // match in the first group must not query the second group at all
        vm.expectCall(address(groupRegistry), abi.encodeCall(groupRegistry.isMember, (second, taker)), 0);
        vm.expectCall(address(resolverMock), abi.encodeCall(resolverMock.isMember, (second, taker)), 0);
        _signalCall();
        assertEq(orchestrator.getAccountIntents(taker).length, 1);
    }

    function test_RevertingResolverInEarlierGroupDoesNotBlockLaterGroupMatch() public {
        uint256 broken = _newGroup(depositor);
        uint256 good = _newGroup(depositor);
        vm.prank(depositor);
        groupRegistry.setResolver(broken, address(resolverMock));
        resolverMock.setMode(WhitelistResolverMock.Mode.Revert);
        vm.prank(depositor);
        groupRegistry.addMembers(good, _address(taker));
        uint256[] memory both = new uint256[](2);
        both[0] = broken; both[1] = good;
        _attach(depositor, both);
        _signalCall();
        assertEq(orchestrator.getAccountIntents(taker).length, 1);
    }

    function test_IsAllowedTakerMatchesValidateSemantics() public {
        uint256 groupId = _newGroup(depositor);
        _attach(depositor, _groupIds(groupId));
        assertFalse(hook.isAllowedTaker(address(escrow), 0, taker));
        vm.prank(depositor);
        groupRegistry.addMembers(groupId, _address(taker));
        assertTrue(hook.isAllowedTaker(address(escrow), 0, taker));
        _detach(depositor, _groupIds(groupId));
        assertFalse(hook.isAllowedTaker(address(escrow), 0, taker));
        _add(depositor, _address(taker));
        assertTrue(hook.isAllowedTaker(address(escrow), 0, taker));
    }
    /* ============ configuration persistence and lifecycle ============ */

    function test_ConfigPersistsAcrossHookUnsetAndReattach() public {
        uint256 groupId = _newGroup(depositor);
        _attach(depositor, _groupIds(groupId));
        _add(depositor, _address(taker));

        // unset hook slot => whitelist paused, anyone can signal
        vm.prank(depositor);
        orchestrator.setDepositWhitelistHook(address(escrow), 0, IPreIntentHook(address(0)));
        vm.prank(unauthorized);
        orchestrator.signalIntent(_paramsFor(unauthorized));
        assertEq(orchestrator.getAccountIntents(unauthorized).length, 1);

        // reattach => dormant config resumes: direct entry and attached group intact
        vm.prank(depositor);
        orchestrator.setDepositWhitelistHook(address(escrow), 0, IPreIntentHook(address(hook)));
        assertTrue(hook.isWhitelisted(address(escrow), 0, taker));
        assertTrue(hook.isGroupAttached(address(escrow), 0, groupId));
        _expectNotWhitelistedRevertFor(takerTwo);
        vm.prank(takerTwo);
        orchestrator.signalIntent(_paramsFor(takerTwo));
    }

    function test_MembershipRemovalDoesNotInvalidateSignaledIntent() public {
        uint256 groupId = _newGroup(depositor);
        vm.prank(depositor);
        groupRegistry.addMembers(groupId, _address(taker));
        _attach(depositor, _groupIds(groupId));
        _signalCall();
        bytes32[] memory intents = orchestrator.getAccountIntents(taker);
        assertEq(intents.length, 1);

        vm.prank(depositor);
        groupRegistry.removeMembers(groupId, _address(taker));
        // the already-signaled intent still exists and is untouched
        assertEq(orchestrator.getAccountIntents(taker).length, 1);
        // but a new signal is rejected (point-in-time admission)
        _expectNotWhitelistedRevert();
        _signalCall();
    }

    function test_SetupRaceWindowIsRealBeforeHookAttachment() public {
        // Demonstrates the documented limitation: a second deposit (id 1) accepts intents
        // between createDeposit and setDepositWhitelistHook.
        vm.startPrank(depositor);
        token.approve(address(escrow), 10_000e6);
        _createDeposit(); // deposit id 1, no hook configured yet
        vm.stopPrank();

        IOrchestratorV3.SignalIntentParams memory params = _paramsFor(unauthorized);
        params.depositId = 1;
        vm.prank(unauthorized);
        orchestrator.signalIntent(params); // succeeds — window is open
        assertEq(orchestrator.getAccountIntents(unauthorized).length, 1);
    }

    function test_HookRejectionPrecedesLiquidityCheck() public {
        // Validation order under test: OrchestratorV3.signalIntent runs _validateSignalIntent
        // (no liquidity check), then the hooks, and only locks funds afterwards — so a
        // non-member must get TakerNotWhitelisted even when the deposit is drained, while a
        // whitelisted taker passes the hook and then hits InsufficientDepositLiquidity.
        _add(depositor, _address(taker));
        IOrchestratorV3.SignalIntentParams memory params = _signalParams();
        params.amount = 100e6; // drain the entire deposit
        vm.prank(taker);
        orchestrator.signalIntent(params);

        _expectNotWhitelistedRevertFor(takerTwo);
        vm.prank(takerTwo);
        orchestrator.signalIntent(_paramsFor(takerTwo));

        _add(depositor, _address(takerTwo));
        vm.expectRevert(
            abi.encodeWithSelector(IEscrowV2.InsufficientDepositLiquidity.selector, 0, 0, INTENT_AMOUNT)
        );
        vm.prank(takerTwo);
        orchestrator.signalIntent(_paramsFor(takerTwo));
    }

    function test_NewDelegateGainsConfigRightsOldDelegateLosesThem() public {
        address newDelegate = makeAddr("newDelegate");
        vm.prank(depositor);
        escrow.setDelegate(0, newDelegate);

        vm.expectRevert(
            abi.encodeWithSelector(
                WhitelistPreIntentHookV2.UnauthorizedCallerOrDelegate.selector, delegate, depositor, newDelegate
            )
        );
        _add(delegate, _address(taker));

        _add(newDelegate, _address(taker));
        assertTrue(hook.isWhitelisted(address(escrow), 0, taker));
    }

    /* ============ helpers for the above ============ */

    function _paramsFor(address signaler) internal view returns (IOrchestratorV3.SignalIntentParams memory params) {
        params = _signalParams();
        params.to = signaler;
    }

    function _expectNotWhitelistedRevertFor(address who) internal {
        vm.expectRevert(
            abi.encodeWithSelector(WhitelistPreIntentHookV2.TakerNotWhitelisted.selector, who, address(escrow), 0)
        );
    }
}

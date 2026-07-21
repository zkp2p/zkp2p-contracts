// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {EscrowV2} from "contracts/EscrowV2.sol";
import {OrchestratorV2} from "contracts/OrchestratorV2.sol";
import {WhitelistPreIntentHook} from "contracts/hooks/WhitelistPreIntentHook.sol";
import {PaymentVerifierMock} from "contracts/mocks/PaymentVerifierMock.sol";
import {PreIntentHookMock} from "contracts/mocks/PreIntentHookMock.sol";
import {USDCMock} from "contracts/mocks/USDCMock.sol";
import {EscrowRegistry} from "contracts/registries/EscrowRegistry.sol";
import {OrchestratorRegistry} from "contracts/registries/OrchestratorRegistry.sol";
import {PaymentVerifierRegistry} from "contracts/registries/PaymentVerifierRegistry.sol";
import {RelayerRegistry} from "contracts/registries/RelayerRegistry.sol";
import {IEscrowV2} from "contracts/interfaces/IEscrowV2.sol";
import {IOrchestratorV2} from "contracts/interfaces/IOrchestratorV2.sol";
import {IPostIntentHookV2} from "contracts/interfaces/IPostIntentHookV2.sol";
import {IPreIntentHook} from "contracts/interfaces/IPreIntentHook.sol";
import {IReferralFee} from "contracts/interfaces/IReferralFee.sol";

contract WhitelistPreIntentHookParityTest is Test {
    event TakerWhitelisted(address indexed escrow, uint256 indexed depositId, address indexed taker);
    event TakerRemovedFromWhitelist(address indexed escrow, uint256 indexed depositId, address indexed taker);
    event DepositWhitelistHookSet(
        address indexed escrow, uint256 indexed depositId, address indexed hook, address setter
    );
    event IntentSignaled(
        bytes32 indexed intentHash,
        address indexed escrow,
        uint256 indexed depositId,
        bytes32 paymentMethod,
        address owner,
        address to,
        uint256 amount,
        bytes32 fiatCurrency,
        uint256 conversionRate,
        uint256 timestamp
    );

    uint256 internal constant CHAIN_ID = 1;
    uint256 internal constant INTENT_AMOUNT = 50e6;
    uint256 internal constant CONVERSION_RATE = 1.02e18;
    uint256 internal constant CIRCOM_PRIME_FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;
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
    OrchestratorV2 internal orchestrator;
    OrchestratorRegistry internal orchestratorRegistry;
    WhitelistPreIntentHook internal whitelistHook;
    PreIntentHookMock internal genericHook;

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
        orchestrator = new OrchestratorV2(
            address(this),
            CHAIN_ID,
            address(escrowRegistry),
            address(paymentVerifierRegistry),
            address(new RelayerRegistry()),
            0,
            address(this)
        );
        orchestrator.setAllowMultipleIntents(true);
        orchestratorRegistry.addOrchestrator(address(orchestrator));
        verifier.setVerificationContext(address(orchestrator), address(escrow));
        whitelistHook = new WhitelistPreIntentHook(address(orchestratorRegistry));
        genericHook = new PreIntentHookMock();

        vm.startPrank(depositor);
        token.approve(address(escrow), 10_000e6);
        _createDeposit();
        vm.stopPrank();
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

    function _addresses(address first, address second) internal pure returns (address[] memory values) {
        values = new address[](2);
        values[0] = first;
        values[1] = second;
    }

    function _address(address value) internal pure returns (address[] memory values) {
        values = new address[](1);
        values[0] = value;
    }

    function _add(address caller, address escrowAddress, address[] memory takers) internal {
        vm.prank(caller);
        whitelistHook.addToWhitelist(escrowAddress, 0, takers);
    }

    function _remove(address caller, address escrowAddress, address[] memory takers) internal {
        vm.prank(caller);
        whitelistHook.removeFromWhitelist(escrowAddress, 0, takers);
    }

    function _setWhitelistHook(address caller, address escrowAddress, IPreIntentHook hook) internal {
        vm.prank(caller);
        orchestrator.setDepositWhitelistHook(escrowAddress, 0, hook);
    }

    function _setGenericHook(address caller, IPreIntentHook hook) internal {
        vm.prank(caller);
        orchestrator.setDepositPreIntentHook(address(escrow), 0, hook);
    }

    function _signalParams() internal view returns (IOrchestratorV2.SignalIntentParams memory params) {
        IReferralFee.ReferralFee[] memory referralFees = new IReferralFee.ReferralFee[](0);
        params = IOrchestratorV2.SignalIntentParams({
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

    function _signal() internal returns (bytes32 intentHash) {
        _signalCall();
        bytes32[] memory accountIntents = orchestrator.getAccountIntents(taker);
        return accountIntents[accountIntents.length - 1];
    }

    function _expectedIntentHash(uint256 counter) internal view returns (bytes32) {
        return bytes32(uint256(keccak256(abi.encodePacked(address(orchestrator), counter))) % CIRCOM_PRIME_FIELD);
    }

    function _configureWhitelist() internal {
        _setWhitelistHook(depositor, address(escrow), whitelistHook);
    }

    function _configureBothHooks() internal {
        _setGenericHook(depositor, genericHook);
        _configureWhitelist();
    }

    function test_ConstructorRejectsZeroOrchestratorRegistry() public {
        vm.expectRevert(WhitelistPreIntentHook.ZeroAddress.selector);
        new WhitelistPreIntentHook(address(0));
    }

    function test_ConstructorStoresOrchestratorRegistry() public view {
        assertEq(address(whitelistHook.orchestratorRegistry()), address(orchestratorRegistry));
    }

    function test_DepositorWhitelistsTakersAndEmitsPerTaker() public {
        vm.expectEmit(true, true, true, true, address(whitelistHook));
        emit TakerWhitelisted(address(escrow), 0, taker);
        vm.expectEmit(true, true, true, true, address(whitelistHook));
        emit TakerWhitelisted(address(escrow), 0, takerTwo);
        _add(depositor, address(escrow), _addresses(taker, takerTwo));
        assertTrue(whitelistHook.isWhitelisted(address(escrow), 0, taker));
        assertTrue(whitelistHook.isWhitelisted(address(escrow), 0, takerTwo));
        assertFalse(whitelistHook.isWhitelisted(address(escrow), 0, unauthorized));
    }

    function test_DelegateCanWhitelistTakers() public {
        _add(delegate, address(escrow), _addresses(taker, takerTwo));
        assertTrue(whitelistHook.isWhitelisted(address(escrow), 0, taker));
        assertTrue(whitelistHook.isWhitelisted(address(escrow), 0, takerTwo));
    }

    function test_UnauthorizedCallerCannotWhitelistTakers() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                WhitelistPreIntentHook.UnauthorizedCallerOrDelegate.selector, unauthorized, depositor, delegate
            )
        );
        _add(unauthorized, address(escrow), _address(taker));
    }

    function test_ZeroEscrowCannotWhitelistTakers() public {
        vm.expectRevert(WhitelistPreIntentHook.ZeroAddress.selector);
        _add(depositor, address(0), _address(taker));
    }

    function test_EmptyArrayCannotWhitelistTakers() public {
        vm.expectRevert(WhitelistPreIntentHook.EmptyArray.selector);
        _add(depositor, address(escrow), new address[](0));
    }

    function test_ZeroTakerRevertsEntireWhitelistBatch() public {
        vm.expectRevert(WhitelistPreIntentHook.ZeroAddress.selector);
        _add(depositor, address(escrow), _addresses(taker, address(0)));
        assertFalse(whitelistHook.isWhitelisted(address(escrow), 0, taker));
    }

    function test_DepositorRemovesTakerAndEmitsWithoutAffectingOthers() public {
        _add(depositor, address(escrow), _addresses(taker, takerTwo));
        vm.expectEmit(true, true, true, true, address(whitelistHook));
        emit TakerRemovedFromWhitelist(address(escrow), 0, taker);
        _remove(depositor, address(escrow), _address(taker));
        assertFalse(whitelistHook.isWhitelisted(address(escrow), 0, taker));
        assertTrue(whitelistHook.isWhitelisted(address(escrow), 0, takerTwo));
    }

    function test_DelegateCanRemoveTaker() public {
        _add(depositor, address(escrow), _addresses(taker, takerTwo));
        _remove(delegate, address(escrow), _address(taker));
        assertFalse(whitelistHook.isWhitelisted(address(escrow), 0, taker));
    }

    function test_UnauthorizedCallerCannotRemoveTaker() public {
        _add(depositor, address(escrow), _address(taker));
        vm.expectRevert(
            abi.encodeWithSelector(
                WhitelistPreIntentHook.UnauthorizedCallerOrDelegate.selector, unauthorized, depositor, delegate
            )
        );
        _remove(unauthorized, address(escrow), _address(taker));
    }

    function test_ZeroEscrowCannotRemoveTaker() public {
        vm.expectRevert(WhitelistPreIntentHook.ZeroAddress.selector);
        _remove(depositor, address(0), _address(taker));
    }

    function test_EmptyArrayCannotRemoveTakers() public {
        vm.expectRevert(WhitelistPreIntentHook.EmptyArray.selector);
        _remove(depositor, address(escrow), new address[](0));
    }

    function test_NonWhitelistedTakerCannotBeRemoved() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                WhitelistPreIntentHook.TakerNotInWhitelist.selector, unauthorized, address(escrow), 0
            )
        );
        _remove(depositor, address(escrow), _address(unauthorized));
    }

    function test_DepositorSetsWhitelistHookAndEmits() public {
        vm.expectEmit(true, true, true, true, address(orchestrator));
        emit DepositWhitelistHookSet(address(escrow), 0, address(whitelistHook), depositor);
        _configureWhitelist();
        assertEq(address(orchestrator.getDepositWhitelistHook(address(escrow), 0)), address(whitelistHook));
    }

    function test_DelegateCanSetWhitelistHook() public {
        vm.expectEmit(true, true, true, true, address(orchestrator));
        emit DepositWhitelistHookSet(address(escrow), 0, address(whitelistHook), delegate);
        _setWhitelistHook(delegate, address(escrow), whitelistHook);
        assertEq(address(orchestrator.getDepositWhitelistHook(address(escrow), 0)), address(whitelistHook));
    }

    function test_ZeroHookRemovesWhitelistHookAndEmits() public {
        _configureWhitelist();
        vm.expectEmit(true, true, true, true, address(orchestrator));
        emit DepositWhitelistHookSet(address(escrow), 0, address(0), depositor);
        _setWhitelistHook(depositor, address(escrow), IPreIntentHook(address(0)));
        assertEq(address(orchestrator.getDepositWhitelistHook(address(escrow), 0)), address(0));
    }

    function test_UnauthorizedCallerCannotSetWhitelistHook() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IOrchestratorV2.UnauthorizedCallerOrDelegate.selector, unauthorized, depositor, delegate
            )
        );
        _setWhitelistHook(unauthorized, address(escrow), whitelistHook);
    }

    function test_ZeroEscrowCannotSetWhitelistHook() public {
        vm.expectRevert(IOrchestratorV2.ZeroAddress.selector);
        _setWhitelistHook(depositor, address(0), whitelistHook);
    }

    function test_EoaCannotBeConfiguredAsWhitelistHook() public {
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV2.InvalidPreIntentHook.selector, taker));
        _setWhitelistHook(depositor, address(escrow), IPreIntentHook(taker));
    }

    function test_WhitelistedTakerCanSignalAndEmitsIntent() public {
        _configureWhitelist();
        _add(depositor, address(escrow), _address(taker));
        bytes32 expectedHash = _expectedIntentHash(0);
        vm.expectEmit(true, true, true, true, address(orchestrator));
        emit IntentSignaled(
            expectedHash, address(escrow), 0, METHOD, taker, taker, INTENT_AMOUNT, USD, CONVERSION_RATE, block.timestamp
        );
        assertEq(_signal(), expectedHash);
        assertEq(orchestrator.getAccountIntents(taker).length, 1);
    }

    function test_NonWhitelistedTakerCannotSignal() public {
        _configureWhitelist();
        vm.expectRevert(
            abi.encodeWithSelector(WhitelistPreIntentHook.TakerNotWhitelisted.selector, taker, address(escrow), 0)
        );
        _signalCall();
        assertEq(orchestrator.getAccountIntents(taker).length, 0);
    }

    function test_RemovedTakerCannotSignal() public {
        _configureWhitelist();
        _add(depositor, address(escrow), _address(taker));
        _remove(depositor, address(escrow), _address(taker));
        vm.expectRevert(
            abi.encodeWithSelector(WhitelistPreIntentHook.TakerNotWhitelisted.selector, taker, address(escrow), 0)
        );
        _signalCall();
    }

    function test_DirectValidationCallRejectsNonOrchestrator() public {
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
        vm.expectRevert(abi.encodeWithSelector(WhitelistPreIntentHook.UnauthorizedOrchestratorCaller.selector, taker));
        vm.prank(taker);
        whitelistHook.validateSignalIntent(context);
    }

    function test_GenericAndWhitelistHooksAreStoredIndependently() public {
        _configureBothHooks();
        assertEq(address(orchestrator.getDepositPreIntentHook(address(escrow), 0)), address(genericHook));
        assertEq(address(orchestrator.getDepositWhitelistHook(address(escrow), 0)), address(whitelistHook));
    }

    function test_SignalCallsBothHooksWhenTakerIsWhitelisted() public {
        _configureBothHooks();
        _add(depositor, address(escrow), _address(taker));
        assertNotEq(_signal(), bytes32(0));
        assertEq(genericHook.callCount(), 1);
        assertTrue(whitelistHook.isWhitelisted(address(escrow), 0, taker));
    }

    function test_WhitelistRejectionRevertsGenericHookStateToo() public {
        _configureBothHooks();
        vm.expectRevert(
            abi.encodeWithSelector(WhitelistPreIntentHook.TakerNotWhitelisted.selector, taker, address(escrow), 0)
        );
        _signalCall();
        assertEq(genericHook.callCount(), 0);
        assertEq(orchestrator.getAccountIntents(taker).length, 0);
    }

    function test_RemovingWhitelistHookLeavesGenericHookIntact() public {
        _configureBothHooks();
        _setWhitelistHook(depositor, address(escrow), IPreIntentHook(address(0)));
        assertEq(address(orchestrator.getDepositPreIntentHook(address(escrow), 0)), address(genericHook));
        assertEq(address(orchestrator.getDepositWhitelistHook(address(escrow), 0)), address(0));
    }

    function test_RemovingGenericHookLeavesWhitelistHookIntact() public {
        _configureBothHooks();
        _setGenericHook(depositor, IPreIntentHook(address(0)));
        assertEq(address(orchestrator.getDepositPreIntentHook(address(escrow), 0)), address(0));
        assertEq(address(orchestrator.getDepositWhitelistHook(address(escrow), 0)), address(whitelistHook));
    }
}

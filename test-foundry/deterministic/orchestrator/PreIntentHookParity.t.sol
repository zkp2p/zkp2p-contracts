// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {EscrowV2} from "contracts/EscrowV2.sol";
import {OrchestratorV2} from "contracts/OrchestratorV2.sol";
import {SignatureGatingPreIntentHook} from "contracts/hooks/SignatureGatingPreIntentHook.sol";
import {PaymentVerifierMock} from "contracts/mocks/PaymentVerifierMock.sol";
import {PreIntentHookMock} from "contracts/mocks/PreIntentHookMock.sol";
import {ReentrantPreIntentHookMock} from "contracts/mocks/ReentrantPreIntentHookMock.sol";
import {ReentrantSignalIntentCallerV2Mock} from "contracts/mocks/ReentrantSignalIntentCallerV2Mock.sol";
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

contract PreIntentHookParityTest is Test {
    event DepositPreIntentHookSet(
        address indexed escrow, uint256 indexed depositId, address indexed hook, address setter
    );
    event DepositSignerSet(address indexed escrow, uint256 indexed depositId, address indexed signer, address setter);

    uint256 internal constant DELEGATE_KEY = 0xD311;
    uint256 internal constant UNAUTHORIZED_KEY = 0xBAD;
    uint256 internal constant CHAIN_ID = 1;
    uint256 internal constant INTENT_AMOUNT = 50e6;
    uint256 internal constant CONVERSION_RATE = 1.02e18;
    bytes32 internal constant METHOD = keccak256("venmo");
    bytes32 internal constant USD = keccak256("USD");
    bytes32 internal constant PAYEE = keccak256("payeeDetails");

    address internal depositor;
    address internal delegate;
    address internal taker;
    address internal unauthorized;
    USDCMock internal token;
    EscrowV2 internal escrow;
    OrchestratorV2 internal orchestrator;
    OrchestratorRegistry internal orchestratorRegistry;
    PreIntentHookMock internal hookMock;
    ReentrantSignalIntentCallerV2Mock internal reentrantCaller;
    ReentrantPreIntentHookMock internal reentrantHook;
    SignatureGatingPreIntentHook internal signatureHook;

    function setUp() public {
        depositor = makeAddr("depositor");
        delegate = vm.addr(DELEGATE_KEY);
        taker = makeAddr("taker");
        unauthorized = vm.addr(UNAUTHORIZED_KEY);
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
        hookMock = new PreIntentHookMock();
        reentrantCaller = new ReentrantSignalIntentCallerV2Mock(address(orchestrator));
        reentrantHook = new ReentrantPreIntentHookMock(address(reentrantCaller));
        signatureHook = new SignatureGatingPreIntentHook(address(orchestratorRegistry), CHAIN_ID);

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

    function _params(address to, bytes memory persistedData, bytes memory preHookData)
        internal
        pure
        returns (IOrchestratorV2.SignalIntentParams memory params)
    {
        IReferralFee.ReferralFee[] memory referralFees = new IReferralFee.ReferralFee[](0);
        params = IOrchestratorV2.SignalIntentParams({
            escrow: address(0),
            depositId: 0,
            amount: INTENT_AMOUNT,
            to: to,
            paymentMethod: METHOD,
            fiatCurrency: USD,
            conversionRate: CONVERSION_RATE,
            referralFees: referralFees,
            gatingServiceSignature: "",
            signatureExpiration: 0,
            postIntentHook: IPostIntentHookV2(address(0)),
            preIntentHookData: preHookData,
            data: persistedData
        });
    }

    function _signalParams(address to, bytes memory persistedData, bytes memory preHookData)
        internal
        view
        returns (IOrchestratorV2.SignalIntentParams memory params)
    {
        params = _params(to, persistedData, preHookData);
        params.escrow = address(escrow);
    }

    function _signal(address caller, bytes memory persistedData, bytes memory preHookData) internal returns (bytes32) {
        _signalCall(caller, persistedData, preHookData);
        bytes32[] memory hashes = orchestrator.getAccountIntents(caller);
        return hashes[hashes.length - 1];
    }

    function _signalCall(address caller, bytes memory persistedData, bytes memory preHookData) internal {
        IOrchestratorV2.SignalIntentParams memory params = _signalParams(taker, persistedData, preHookData);
        vm.prank(caller);
        orchestrator.signalIntent(params);
    }

    function _setHook(address caller, address escrowAddress, uint256 depositId, IPreIntentHook hook) internal {
        vm.prank(caller);
        orchestrator.setDepositPreIntentHook(escrowAddress, depositId, hook);
    }

    function test_DepositorCanSetPreIntentHookAndEmits() public {
        vm.expectEmit(true, true, true, true, address(orchestrator));
        emit DepositPreIntentHookSet(address(escrow), 0, address(hookMock), depositor);
        _setHook(depositor, address(escrow), 0, hookMock);
        assertEq(address(orchestrator.getDepositPreIntentHook(address(escrow), 0)), address(hookMock));
    }

    function test_DelegateCanSetPreIntentHookAndEmits() public {
        vm.expectEmit(true, true, true, true, address(orchestrator));
        emit DepositPreIntentHookSet(address(escrow), 0, address(hookMock), delegate);
        _setHook(delegate, address(escrow), 0, hookMock);
        assertEq(address(orchestrator.getDepositPreIntentHook(address(escrow), 0)), address(hookMock));
    }

    function test_UnauthorizedCallerCannotSetPreIntentHook() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IOrchestratorV2.UnauthorizedCallerOrDelegate.selector, unauthorized, depositor, delegate
            )
        );
        _setHook(unauthorized, address(escrow), 0, hookMock);
    }

    function test_ZeroHookRemovesPreIntentHookAndEmits() public {
        _setHook(depositor, address(escrow), 0, hookMock);
        vm.expectEmit(true, true, true, true, address(orchestrator));
        emit DepositPreIntentHookSet(address(escrow), 0, address(0), depositor);
        _setHook(depositor, address(escrow), 0, IPreIntentHook(address(0)));
        assertEq(address(orchestrator.getDepositPreIntentHook(address(escrow), 0)), address(0));
    }

    function test_EoaCannotBeConfiguredAsPreIntentHook() public {
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV2.InvalidPreIntentHook.selector, unauthorized));
        _setHook(depositor, address(escrow), 0, IPreIntentHook(unauthorized));
    }

    function test_MissingDepositCannotConfigurePreIntentHook() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IOrchestratorV2.UnauthorizedCallerOrDelegate.selector, depositor, address(0), address(0)
            )
        );
        _setHook(depositor, address(escrow), 1, hookMock);
    }

    function test_ZeroEscrowCannotConfigurePreIntentHook() public {
        vm.expectRevert(IOrchestratorV2.ZeroAddress.selector);
        _setHook(depositor, address(0), 0, hookMock);
    }

    function test_SignalPassesEphemeralHookDataWithoutPersistingIt() public {
        _setHook(depositor, address(escrow), 0, hookMock);
        bytes memory preHookData = abi.encode(uint256(7));
        bytes memory persistedData = abi.encode(uint256(42));
        bytes32 intentHash = _signal(taker, persistedData, preHookData);
        IOrchestratorV2.Intent memory intent = orchestrator.getIntent(intentHash);
        assertEq(hookMock.callCount(), 1);
        assertEq(hookMock.lastTaker(), taker);
        assertEq(hookMock.lastEscrow(), address(escrow));
        assertEq(hookMock.lastDepositId(), 0);
        assertEq(hookMock.lastPreIntentHookData(), preHookData);
        assertEq(intent.data, persistedData);
        assertNotEq(intent.data, preHookData);
    }

    function test_SignalRevertsAtomicallyWhenPreIntentHookRejects() public {
        _setHook(depositor, address(escrow), 0, hookMock);
        hookMock.setShouldRevert(true);
        vm.expectRevert(bytes("PreIntentHookMock: rejected"));
        _signalCall(taker, abi.encode(uint256(42)), abi.encode(uint256(7)));
        assertEq(orchestrator.getAccountIntents(taker).length, 0);
    }

    function test_SignalWorksWithoutConfiguredPreIntentHook() public {
        bytes32 intentHash = _signal(taker, abi.encode(uint256(42)), abi.encode(uint256(7)));
        assertNotEq(intentHash, bytes32(0));
        assertEq(orchestrator.getAccountIntents(taker).length, 1);
        assertEq(hookMock.callCount(), 0);
    }

    function test_SignalSkipsRemovedPreIntentHook() public {
        _setHook(depositor, address(escrow), 0, hookMock);
        _setHook(depositor, address(escrow), 0, IPreIntentHook(address(0)));
        _signal(taker, abi.encode(uint256(42)), abi.encode(uint256(7)));
        assertEq(hookMock.callCount(), 0);
    }

    function test_ReentrantHookCannotCreateSecondIntent() public {
        orchestrator.setAllowMultipleIntents(false);
        _setHook(depositor, address(escrow), 0, reentrantHook);
        IOrchestratorV2.SignalIntentParams memory params =
            _signalParams(address(reentrantCaller), abi.encode(uint256(42)), abi.encode(uint256(7)));
        reentrantCaller.setReentryParams(params);
        reentrantCaller.signalIntent(params);
        assertEq(reentrantHook.reentryAttemptCount(), 1);
        assertFalse(reentrantHook.lastReentrySucceeded());
        assertEq(orchestrator.getAccountIntents(address(reentrantCaller)).length, 1);
    }

    function test_SignatureHookConstructorRejectsZeroRegistry() public {
        vm.expectRevert(SignatureGatingPreIntentHook.ZeroAddress.selector);
        new SignatureGatingPreIntentHook(address(0), CHAIN_ID);
    }

    function test_DepositorCanSetDepositSignerAndEmits() public {
        vm.expectEmit(true, true, true, true, address(signatureHook));
        emit DepositSignerSet(address(escrow), 0, delegate, depositor);
        vm.prank(depositor);
        signatureHook.setDepositSigner(address(escrow), 0, delegate);
        assertEq(signatureHook.getDepositSigner(address(escrow), 0), delegate);
    }

    function test_DelegateCanSetDepositSignerAndEmits() public {
        vm.expectEmit(true, true, true, true, address(signatureHook));
        emit DepositSignerSet(address(escrow), 0, address(this), delegate);
        vm.prank(delegate);
        signatureHook.setDepositSigner(address(escrow), 0, address(this));
        assertEq(signatureHook.getDepositSigner(address(escrow), 0), address(this));
    }

    function test_UnauthorizedCallerCannotSetDepositSigner() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                SignatureGatingPreIntentHook.UnauthorizedCallerOrDelegate.selector, unauthorized, depositor, delegate
            )
        );
        vm.prank(unauthorized);
        signatureHook.setDepositSigner(address(escrow), 0, delegate);
    }

    function test_ZeroEscrowCannotSetDepositSigner() public {
        vm.expectRevert(SignatureGatingPreIntentHook.ZeroAddress.selector);
        vm.prank(depositor);
        signatureHook.setDepositSigner(address(0), 0, delegate);
    }

    function _emptyReferralHash() internal pure returns (bytes32) {
        bytes32[] memory feeHashes = new bytes32[](0);
        return keccak256(abi.encode(feeHashes));
    }

    function _signature(uint256 signerKey, address signedTaker, address to, uint256 expiration)
        internal
        view
        returns (bytes memory)
    {
        bytes32 messageHash = keccak256(
            abi.encodePacked(
                address(orchestrator),
                address(escrow),
                uint256(0),
                INTENT_AMOUNT,
                signedTaker,
                to,
                METHOD,
                USD,
                CONVERSION_RATE,
                _emptyReferralHash(),
                expiration,
                CHAIN_ID
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _configureSignatureHook() internal {
        vm.prank(depositor);
        signatureHook.setDepositSigner(address(escrow), 0, delegate);
        _setHook(depositor, address(escrow), 0, signatureHook);
    }

    function _signedHookData(uint256 signerKey, address signedTaker, address to, uint256 expiration)
        internal
        view
        returns (bytes memory)
    {
        return abi.encode(_signature(signerKey, signedTaker, to, expiration), expiration);
    }

    function test_SignatureHookAcceptsValidSignature() public {
        _configureSignatureHook();
        uint256 expiration = block.timestamp + 3600;
        bytes memory hookData = _signedHookData(DELEGATE_KEY, taker, taker, expiration);
        assertNotEq(_signal(taker, abi.encode("post-intent-signal-data"), hookData), bytes32(0));
    }

    function test_SignatureHookRejectsInvalidSigner() public {
        _configureSignatureHook();
        uint256 expiration = block.timestamp + 3600;
        bytes memory hookData = _signedHookData(UNAUTHORIZED_KEY, taker, taker, expiration);
        vm.expectRevert(SignatureGatingPreIntentHook.InvalidSignature.selector);
        _signalCall(taker, abi.encode("post-intent-signal-data"), hookData);
    }

    function test_SignatureHookRejectsDirectCaller() public {
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
            abi.encodeWithSelector(SignatureGatingPreIntentHook.UnauthorizedOrchestratorCaller.selector, taker)
        );
        vm.prank(taker);
        signatureHook.validateSignalIntent(context);
    }

    function test_SignatureHookRejectsDepositWithoutSigner() public {
        SignatureGatingPreIntentHook freshHook =
            new SignatureGatingPreIntentHook(address(orchestratorRegistry), CHAIN_ID);
        _setHook(depositor, address(escrow), 0, freshHook);
        uint256 expiration = block.timestamp + 3600;
        bytes memory hookData = _signedHookData(DELEGATE_KEY, taker, taker, expiration);
        vm.expectRevert(abi.encodeWithSelector(SignatureGatingPreIntentHook.SignerNotSet.selector, address(escrow), 0));
        _signalCall(taker, abi.encode("post-intent-signal-data"), hookData);
    }

    function test_SignatureHookBindsActualCallerAsTaker() public {
        _configureSignatureHook();
        uint256 expiration = block.timestamp + 3600;
        bytes memory hookData = _signedHookData(DELEGATE_KEY, taker, taker, expiration);
        vm.expectRevert(SignatureGatingPreIntentHook.InvalidSignature.selector);
        _signalCall(unauthorized, abi.encode("post-intent-signal-data"), hookData);
    }

    function test_SignatureHookRejectsExpiredSignature() public {
        _configureSignatureHook();
        vm.warp(1000);
        uint256 expiration = block.timestamp - 1;
        bytes memory hookData = _signedHookData(DELEGATE_KEY, taker, taker, expiration);
        vm.expectRevert(
            abi.encodeWithSelector(SignatureGatingPreIntentHook.SignatureExpired.selector, expiration, block.timestamp)
        );
        _signalCall(taker, abi.encode("post-intent-signal-data"), hookData);
    }
}

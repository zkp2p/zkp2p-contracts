// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {EscrowV2} from "contracts/EscrowV2.sol";
import {OrchestratorV2} from "contracts/OrchestratorV2.sol";
import {OrchestratorV3} from "contracts/OrchestratorV3.sol";
import {OrchestratorMock} from "contracts/mocks/OrchestratorMock.sol";
import {PartialPullPostIntentHookV2Mock} from "contracts/mocks/PartialPullPostIntentHookV2Mock.sol";
import {PaymentVerifierMock} from "contracts/mocks/PaymentVerifierMock.sol";
import {PostIntentHookV2Mock} from "contracts/mocks/PostIntentHookV2Mock.sol";
import {PreIntentHookMock} from "contracts/mocks/PreIntentHookMock.sol";
import {PushPostIntentHookV2Mock} from "contracts/mocks/PushPostIntentHookV2Mock.sol";
import {ReentrantPostIntentHookV2} from "contracts/mocks/ReentrantPostIntentHookV2.sol";
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
import {IReferralFee} from "contracts/interfaces/IReferralFee.sol";

abstract contract OrchestratorV2LegacyFixture is Test {
    uint256 internal constant CHAIN_ID = 1;
    uint256 internal constant INTENT_AMOUNT = 50e6;
    uint256 internal constant CONVERSION_RATE = 1e18;
    uint256 internal constant CIRCOM_PRIME_FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;
    bytes32 internal constant METHOD = keccak256("venmo");
    bytes32 internal constant USD = keccak256("USD");
    bytes32 internal constant PAYEE = keccak256("payee");

    uint256 internal gatingServiceKey;
    address internal depositor;
    address internal delegate;
    address internal taker;
    address internal other;
    address internal referrer;
    address internal protocolFeeRecipient;
    address internal gatingService;
    USDCMock internal token;
    EscrowV2 internal escrow;
    OrchestratorV2 internal orchestrator;
    EscrowRegistry internal escrowRegistry;
    OrchestratorRegistry internal orchestratorRegistry;
    PaymentVerifierRegistry internal paymentVerifierRegistry;
    RelayerRegistry internal relayerRegistry;
    PaymentVerifierMock internal verifier;
    PreIntentHookMock internal preIntentHook;
    PreIntentHookMock internal whitelistHook;
    PostIntentHookV2Mock internal postIntentHook;
    PartialPullPostIntentHookV2Mock internal partialPostIntentHook;
    PushPostIntentHookV2Mock internal pushPostIntentHook;
    ReentrantPostIntentHookV2 internal reentrantPostIntentHook;
    ReentrantSignalIntentCallerV2Mock internal reentrantSignalCaller;
    ReentrantPreIntentHookMock internal reentrantPreIntentHook;
    OrchestratorMock internal orchestratorMock;
    uint256 internal depositId;

    function setUp() public virtual {
        depositor = makeAddr("depositor");
        delegate = makeAddr("delegate");
        taker = makeAddr("taker");
        other = makeAddr("other");
        referrer = makeAddr("referrer");
        protocolFeeRecipient = makeAddr("protocolFeeRecipient");
        (gatingService, gatingServiceKey) = makeAddrAndKey("gatingService");

        token = new USDCMock(1_000_000_000e6, "USDC", "USDC");
        token.transfer(depositor, 100_000e6);
        paymentVerifierRegistry = new PaymentVerifierRegistry();
        escrowRegistry = new EscrowRegistry();
        orchestratorRegistry = new OrchestratorRegistry();
        relayerRegistry = new RelayerRegistry();
        verifier = new PaymentVerifierMock();
        preIntentHook = new PreIntentHookMock();
        whitelistHook = new PreIntentHookMock();
        bytes32[] memory currencies = new bytes32[](1);
        currencies[0] = USD;
        paymentVerifierRegistry.addPaymentMethod(METHOD, address(verifier), currencies);

        escrow = new EscrowV2(
            address(this),
            CHAIN_ID,
            address(orchestratorRegistry),
            address(paymentVerifierRegistry),
            address(this),
            0,
            20,
            1 hours
        );
        orchestrator = new OrchestratorV2(
            address(this),
            CHAIN_ID,
            address(escrowRegistry),
            address(paymentVerifierRegistry),
            address(relayerRegistry),
            0,
            protocolFeeRecipient
        );
        orchestrator.setAllowMultipleIntents(true);
        postIntentHook = new PostIntentHookV2Mock(address(token), address(orchestrator));
        partialPostIntentHook = new PartialPullPostIntentHookV2Mock(address(token), address(orchestrator));
        pushPostIntentHook = new PushPostIntentHookV2Mock(address(token), address(orchestrator));
        reentrantPostIntentHook = new ReentrantPostIntentHookV2(address(token), address(orchestrator));
        reentrantSignalCaller = new ReentrantSignalIntentCallerV2Mock(address(orchestrator));
        reentrantPreIntentHook = new ReentrantPreIntentHookMock(address(reentrantSignalCaller));
        orchestratorMock = new OrchestratorMock(address(escrow));
        token.transfer(address(pushPostIntentHook), 10e6);

        escrowRegistry.addEscrow(address(escrow));
        orchestratorRegistry.addOrchestrator(address(orchestrator));
        orchestratorRegistry.addOrchestrator(address(orchestratorMock));
        verifier.setVerificationContext(address(orchestrator), address(escrow));
        vm.startPrank(depositor);
        token.approve(address(escrow), 100_000e6);
        depositId = _createDeposit(address(0), delegate);
        vm.stopPrank();
    }

    function _emptyOracle() internal pure returns (IEscrowV2.OracleRateConfig memory) {
        return IEscrowV2.OracleRateConfig({adapter: address(0), adapterConfig: "", spreadBps: 0, maxStaleness: 0});
    }

    function _createDeposit(address intentGatingService, address depositDelegate) internal returns (uint256 id) {
        id = escrow.depositCounter();
        bytes32[] memory methods = new bytes32[](1);
        methods[0] = METHOD;
        IEscrowV2.DepositPaymentMethodData[] memory methodData = new IEscrowV2.DepositPaymentMethodData[](1);
        methodData[0] = IEscrowV2.DepositPaymentMethodData({
            intentGatingService: intentGatingService, payeeDetails: PAYEE, data: ""
        });
        IEscrowV2.Currency[][] memory currencies = new IEscrowV2.Currency[][](1);
        currencies[0] = new IEscrowV2.Currency[](1);
        currencies[0][0] =
            IEscrowV2.Currency({code: USD, minConversionRate: CONVERSION_RATE, oracleRateConfig: _emptyOracle()});
        escrow.createDeposit(
            IEscrowV2.CreateDepositParams({
                token: IERC20(address(token)),
                amount: 500e6,
                intentAmountRange: IEscrowV2.Range({min: 10e6, max: 200e6}),
                paymentMethods: methods,
                paymentMethodData: methodData,
                currencies: currencies,
                delegate: depositDelegate,
                intentGuardian: address(0),
                retainOnEmpty: false
            })
        );
    }

    function _emptyReferralFees() internal pure returns (IReferralFee.ReferralFee[] memory) {
        return new IReferralFee.ReferralFee[](0);
    }

    function _replaceOrchestratorWithStandaloneV3() internal {
        orchestrator = OrchestratorV2(
            address(
                new OrchestratorV3(
                    address(this),
                    CHAIN_ID,
                    address(escrowRegistry),
                    address(paymentVerifierRegistry),
                    0,
                    protocolFeeRecipient,
                    2_000_000
                )
            )
        );
        postIntentHook = new PostIntentHookV2Mock(address(token), address(orchestrator));
        partialPostIntentHook = new PartialPullPostIntentHookV2Mock(address(token), address(orchestrator));
        pushPostIntentHook = new PushPostIntentHookV2Mock(address(token), address(orchestrator));
        reentrantPostIntentHook = new ReentrantPostIntentHookV2(address(token), address(orchestrator));
        reentrantSignalCaller = new ReentrantSignalIntentCallerV2Mock(address(orchestrator));
        reentrantPreIntentHook = new ReentrantPreIntentHookMock(address(reentrantSignalCaller));
        token.transfer(address(pushPostIntentHook), 10e6);
        orchestratorRegistry.addOrchestrator(address(orchestrator));
        verifier.setVerificationContext(address(orchestrator), address(escrow));
    }

    function _twoReferralFees() internal view returns (IReferralFee.ReferralFee[] memory fees) {
        fees = new IReferralFee.ReferralFee[](2);
        fees[0] = IReferralFee.ReferralFee({recipient: referrer, fee: 3e15});
        fees[1] = IReferralFee.ReferralFee({recipient: other, fee: 2e15});
    }

    function _params(
        uint256 selectedDepositId,
        address to,
        uint256 amount,
        uint256 conversionRate,
        IReferralFee.ReferralFee[] memory referralFees,
        IPostIntentHookV2 hook,
        bytes memory data
    ) internal view returns (IOrchestratorV2.SignalIntentParams memory) {
        return IOrchestratorV2.SignalIntentParams({
            escrow: address(escrow),
            depositId: selectedDepositId,
            amount: amount,
            to: to,
            paymentMethod: METHOD,
            fiatCurrency: USD,
            conversionRate: conversionRate,
            referralFees: referralFees,
            gatingServiceSignature: "",
            signatureExpiration: block.timestamp + 1 days,
            postIntentHook: hook,
            preIntentHookData: "",
            data: data
        });
    }

    function _defaultParams() internal view returns (IOrchestratorV2.SignalIntentParams memory) {
        return _params(
            depositId, taker, INTENT_AMOUNT, CONVERSION_RATE, _emptyReferralFees(), IPostIntentHookV2(address(0)), ""
        );
    }

    function _intentHash(uint256 counter) internal view returns (bytes32) {
        return bytes32(uint256(keccak256(abi.encodePacked(address(orchestrator), counter))) % CIRCOM_PRIME_FIELD);
    }

    function _signal(address caller, IOrchestratorV2.SignalIntentParams memory params) internal returns (bytes32 hash) {
        hash = _intentHash(orchestrator.intentCounter());
        _signalCall(caller, params);
    }

    function _signalCall(address caller, IOrchestratorV2.SignalIntentParams memory params) internal {
        vm.prank(caller);
        orchestrator.signalIntent(params);
    }

    function _signalDefault() internal returns (bytes32) {
        return _signal(taker, _defaultParams());
    }

    function _paymentProof(bytes32 intentHash, uint256 releaseAmount, uint256 conversionRate)
        internal
        view
        returns (bytes memory)
    {
        uint256 fiatAmount = releaseAmount * conversionRate / 1e18;
        return abi.encode(fiatAmount, block.timestamp, PAYEE, USD, intentHash);
    }

    function _fulfill(bytes32 intentHash, uint256 releaseAmount, uint256 conversionRate) internal {
        orchestrator.fulfillIntent(
            IOrchestratorV2.FulfillIntentParams({
                paymentProof: _paymentProof(intentHash, releaseAmount, conversionRate),
                intentHash: intentHash,
                verificationData: "",
                postIntentHookData: ""
            })
        );
    }

    function _referralHash(IReferralFee.ReferralFee[] memory fees) internal pure returns (bytes32) {
        bytes32[] memory hashes = new bytes32[](fees.length);
        for (uint256 i; i < fees.length; ++i) {
            hashes[i] = keccak256(abi.encode(fees[i].recipient, fees[i].fee));
        }
        return keccak256(abi.encode(hashes));
    }

    function _gatingSignature(
        uint256 signerKey,
        address signedCaller,
        IOrchestratorV2.SignalIntentParams memory params,
        uint256 expiration
    ) internal view returns (bytes memory) {
        bytes32 messageHash;
        if (_usesStandaloneV3Format()) {
            messageHash = keccak256(
                abi.encodePacked(
                    address(orchestrator),
                    params.escrow,
                    params.depositId,
                    params.amount,
                    signedCaller,
                    params.to,
                    params.paymentMethod,
                    params.fiatCurrency,
                    params.conversionRate,
                    _referralHash(params.referralFees),
                    address(params.postIntentHook),
                    keccak256(params.data),
                    expiration,
                    CHAIN_ID
                )
            );
        } else {
            messageHash = keccak256(
                abi.encodePacked(
                    address(orchestrator),
                    params.escrow,
                    params.depositId,
                    params.amount,
                    signedCaller,
                    params.to,
                    params.paymentMethod,
                    params.fiatCurrency,
                    params.conversionRate,
                    _referralHash(params.referralFees),
                    expiration,
                    CHAIN_ID
                )
            );
        }
        bytes32 digest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _usesStandaloneV3Format() internal pure virtual returns (bool) {
        return false;
    }

    function _gatedParams(uint256 gatedDepositId, uint256 signerKey, address signedCaller, uint256 expiration)
        internal
        view
        returns (IOrchestratorV2.SignalIntentParams memory params)
    {
        params = _params(
            gatedDepositId,
            taker,
            INTENT_AMOUNT,
            CONVERSION_RATE,
            _emptyReferralFees(),
            IPostIntentHookV2(address(0)),
            ""
        );
        params.signatureExpiration = expiration;
        params.gatingServiceSignature = _gatingSignature(signerKey, signedCaller, params, expiration);
    }
}

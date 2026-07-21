// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {EscrowV2} from "contracts/EscrowV2.sol";
import {OrchestratorV2} from "contracts/OrchestratorV2.sol";
import {USDCMock} from "contracts/mocks/USDCMock.sol";
import {EscrowRegistry} from "contracts/registries/EscrowRegistry.sol";
import {NullifierRegistry} from "contracts/registries/NullifierRegistry.sol";
import {OrchestratorRegistry} from "contracts/registries/OrchestratorRegistry.sol";
import {PaymentVerifierRegistry} from "contracts/registries/PaymentVerifierRegistry.sol";
import {SimpleAttestationVerifier} from "contracts/unifiedVerifier/SimpleAttestationVerifier.sol";
import {UnifiedPaymentVerifier} from "contracts/unifiedVerifier/UnifiedPaymentVerifier.sol";
import {IEscrowV2} from "contracts/interfaces/IEscrowV2.sol";
import {IOrchestratorV2} from "contracts/interfaces/IOrchestratorV2.sol";
import {IPostIntentHookV2} from "contracts/interfaces/IPostIntentHookV2.sol";
import {IReferralFee} from "contracts/interfaces/IReferralFee.sol";

contract UnifiedPaymentVerifierV2CompatibilityParityTest is Test {
    event PaymentVerified(
        bytes32 indexed intentHash,
        bytes32 indexed method,
        bytes32 indexed currency,
        uint256 amount,
        uint256 timestamp,
        bytes32 paymentId,
        bytes32 payeeId
    );

    uint256 internal constant WITNESS_KEY = 0xA11CE;
    uint256 internal constant DEPOSIT_AMOUNT = 500e6;
    uint256 internal constant INTENT_AMOUNT = 50e6;
    uint256 internal constant CONVERSION_RATE = 1e18;
    bytes32 internal constant METHOD = keccak256("venmo");
    bytes32 internal constant USD = keccak256("USD");
    bytes32 internal constant PAYEE = keccak256("payee-v2");

    address internal maker;
    address internal taker;
    address internal fulfiller;
    address internal witness;
    USDCMock internal token;
    EscrowV2 internal escrow;
    OrchestratorV2 internal orchestrator;
    NullifierRegistry internal nullifierRegistry;
    UnifiedPaymentVerifier internal verifier;

    function setUp() public {
        maker = makeAddr("maker");
        taker = makeAddr("taker");
        fulfiller = makeAddr("fulfiller");
        witness = vm.addr(WITNESS_KEY);

        token = new USDCMock(1_000_000e6, "USDC", "USDC");
        EscrowRegistry escrowRegistry = new EscrowRegistry();
        OrchestratorRegistry orchestratorRegistry = new OrchestratorRegistry();
        PaymentVerifierRegistry paymentVerifierRegistry = new PaymentVerifierRegistry();
        nullifierRegistry = new NullifierRegistry();

        escrow = new EscrowV2(
            address(this),
            block.chainid,
            address(orchestratorRegistry),
            address(paymentVerifierRegistry),
            address(this),
            0,
            20,
            1 hours
        );
        orchestrator = new OrchestratorV2(
            address(this), block.chainid, address(escrowRegistry), address(paymentVerifierRegistry), 0, address(this)
        );
        SimpleAttestationVerifier attestationVerifier = new SimpleAttestationVerifier(witness);
        verifier = new UnifiedPaymentVerifier(orchestratorRegistry, nullifierRegistry, attestationVerifier);

        escrowRegistry.addEscrow(address(escrow));
        orchestratorRegistry.addOrchestrator(address(orchestrator));
        nullifierRegistry.addWritePermission(address(verifier));
        verifier.addPaymentMethod(METHOD);
        bytes32[] memory currencies = new bytes32[](1);
        currencies[0] = USD;
        paymentVerifierRegistry.addPaymentMethod(METHOD, address(verifier), currencies);

        token.transfer(maker, 1_000e6);
        vm.startPrank(maker);
        token.approve(address(escrow), 1_000e6);
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
            minConversionRate: CONVERSION_RATE,
            oracleRateConfig: IEscrowV2.OracleRateConfig({
                adapter: address(0), adapterConfig: "", spreadBps: 0, maxStaleness: 0
            })
        });
        escrow.createDeposit(
            IEscrowV2.CreateDepositParams({
                token: IERC20(address(token)),
                amount: DEPOSIT_AMOUNT,
                intentAmountRange: IEscrowV2.Range({min: 10e6, max: 200e6}),
                paymentMethods: methods,
                paymentMethodData: methodData,
                currencies: currencies,
                delegate: address(0),
                intentGuardian: address(0),
                retainOnEmpty: false
            })
        );
    }

    function _signalIntent() internal returns (bytes32 intentHash) {
        IReferralFee.ReferralFee[] memory referralFees = new IReferralFee.ReferralFee[](0);
        vm.prank(taker);
        orchestrator.signalIntent(
            IOrchestratorV2.SignalIntentParams({
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
            })
        );
        bytes32[] memory intentHashes = orchestrator.getAccountIntents(taker);
        return intentHashes[0];
    }

    function _proof(bytes32 intentHash, IOrchestratorV2.Intent memory intent, bytes32 paymentId)
        internal
        view
        returns (bytes memory)
    {
        UnifiedPaymentVerifier.PaymentDetails memory payment = UnifiedPaymentVerifier.PaymentDetails({
            method: METHOD,
            payeeId: PAYEE,
            amount: intent.amount,
            currency: USD,
            timestamp: block.timestamp * 1000,
            paymentId: paymentId
        });
        UnifiedPaymentVerifier.IntentSnapshot memory snapshot = UnifiedPaymentVerifier.IntentSnapshot({
            intentHash: intentHash,
            amount: intent.amount,
            paymentMethod: METHOD,
            fiatCurrency: USD,
            payeeDetails: PAYEE,
            conversionRate: intent.conversionRate,
            signalTimestamp: intent.timestamp,
            timestampBuffer: 0
        });
        bytes memory data = abi.encode(payment, snapshot);
        bytes32 dataHash = keccak256(data);
        bytes32 typeHash = keccak256("PaymentAttestation(bytes32 intentHash,uint256 releaseAmount,bytes32 dataHash)");
        bytes32 structHash = keccak256(abi.encode(typeHash, intentHash, intent.amount, dataHash));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", verifier.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(WITNESS_KEY, digest);
        bytes[] memory signatures = new bytes[](1);
        signatures[0] = abi.encodePacked(r, s, v);
        return abi.encode(
            UnifiedPaymentVerifier.PaymentAttestation({
                intentHash: intentHash,
                releaseAmount: intent.amount,
                dataHash: dataHash,
                signatures: signatures,
                data: data,
                metadata: ""
            })
        );
    }

    function test_FulfillsV2IntentWithUnifiedVerifierAndTransfersExactTokens() public {
        bytes32 intentHash = _signalIntent();
        IOrchestratorV2.Intent memory intent = orchestrator.getIntent(intentHash);
        bytes32 paymentId = keccak256("payment-v2");
        bytes memory proof = _proof(intentHash, intent, paymentId);
        uint256 balanceBefore = token.balanceOf(taker);

        vm.expectEmit(true, true, true, true, address(verifier));
        emit PaymentVerified(intentHash, METHOD, USD, intent.amount, block.timestamp * 1000, paymentId, PAYEE);
        vm.prank(fulfiller);
        orchestrator.fulfillIntent(
            IOrchestratorV2.FulfillIntentParams({
                paymentProof: proof, intentHash: intentHash, verificationData: "", postIntentHookData: ""
            })
        );

        assertEq(token.balanceOf(taker) - balanceBefore, INTENT_AMOUNT);
        assertEq(token.balanceOf(address(escrow)), DEPOSIT_AMOUNT - INTENT_AMOUNT);
        assertTrue(nullifierRegistry.isNullified(keccak256(abi.encodePacked(METHOD, paymentId))));
        assertEq(orchestrator.getIntent(intentHash).owner, address(0));
    }
}

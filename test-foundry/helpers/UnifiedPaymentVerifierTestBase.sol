// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { Escrow } from "../../contracts/Escrow.sol";
import { Orchestrator } from "../../contracts/Orchestrator.sol";
import { IEscrow } from "../../contracts/interfaces/IEscrow.sol";
import { IOrchestrator } from "../../contracts/interfaces/IOrchestrator.sol";
import { IPaymentVerifier } from "../../contracts/interfaces/IPaymentVerifier.sol";
import { IPostIntentHook } from "../../contracts/interfaces/IPostIntentHook.sol";
import { USDCMock } from "../../contracts/mocks/USDCMock.sol";
import { EscrowRegistry } from "../../contracts/registries/EscrowRegistry.sol";
import { NullifierRegistry } from "../../contracts/registries/NullifierRegistry.sol";
import { OrchestratorRegistry } from "../../contracts/registries/OrchestratorRegistry.sol";
import { PaymentVerifierRegistry } from "../../contracts/registries/PaymentVerifierRegistry.sol";
import { PostIntentHookRegistry } from "../../contracts/registries/PostIntentHookRegistry.sol";
import { RelayerRegistry } from "../../contracts/registries/RelayerRegistry.sol";
import { SimpleAttestationVerifier } from "../../contracts/unifiedVerifier/SimpleAttestationVerifier.sol";
import { UnifiedPaymentVerifier } from "../../contracts/unifiedVerifier/UnifiedPaymentVerifier.sol";

abstract contract UnifiedPaymentVerifierTestBase is Test {
    uint256 internal constant CIRCOM_PRIME_FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 internal constant DEPOSIT_AMOUNT = 100e6;
    uint256 internal constant INTENT_AMOUNT = 50e6;
    uint256 internal constant ONE_DAY_IN_SECONDS = 1 days;
    uint256 internal constant WITNESS_KEY = 0xBEEF;
    uint256 internal constant GATING_SERVICE_KEY = 0xCAFE;
    uint256 internal constant ATTACKER_KEY = 0xA11CE;

    bytes32 internal constant VENMO = keccak256("venmo");
    bytes32 internal constant USD = keccak256("USD");

    struct PaymentProofConfig {
        bytes32 paymentMethod;
        bytes32 payeeId;
        uint256 paymentAmount;
        bytes32 paymentCurrency;
        uint256 paymentTimestamp;
        bytes32 paymentId;
        bytes32 attestationIntentHash;
        uint256 attestationReleaseAmount;
        bytes32 snapshotIntentHash;
        uint256 snapshotIntentAmount;
        bytes32 snapshotIntentPaymentMethod;
        bytes32 snapshotIntentFiatCurrency;
        bytes32 snapshotIntentPayeeDetails;
        uint256 snapshotIntentConversionRate;
        uint256 snapshotIntentSignalTimestamp;
        uint256 snapshotIntentTimestampBuffer;
        uint256 attestationSignerKey;
        bytes attestationMetadata;
        bool useCustomAttestationData;
        bytes attestationData;
        bool useCustomAttestationDataHash;
        bytes32 attestationDataHash;
    }

    struct BuiltUnifiedPaymentProof {
        bytes paymentProof;
        bytes verificationData;
        UnifiedPaymentVerifier.PaymentAttestation attestation;
        UnifiedPaymentVerifier.PaymentDetails paymentDetails;
        UnifiedPaymentVerifier.IntentSnapshot intentSnapshot;
    }

    uint256 internal chainId;
    uint256 internal depositId;

    address internal owner;
    address internal attacker;
    address internal offRamper;
    address internal intentOwner;
    address internal receiver;
    address internal gatingService;
    address internal witness;
    address internal feeRecipient;

    bytes32 internal defaultPayeeId;
    bytes32 internal defaultPaymentId;
    bytes32 internal intentHash;

    USDCMock internal usdc;
    EscrowRegistry internal escrowRegistry;
    OrchestratorRegistry internal orchestratorRegistry;
    PaymentVerifierRegistry internal paymentVerifierRegistry;
    PostIntentHookRegistry internal postIntentHookRegistry;
    RelayerRegistry internal relayerRegistry;
    NullifierRegistry internal nullifierRegistry;
    Escrow internal escrow;
    Orchestrator internal orchestrator;
    SimpleAttestationVerifier internal attestationVerifier;
    UnifiedPaymentVerifier internal verifier;
    IOrchestrator.Intent internal intent;

    function _setUpUnifiedPaymentVerifier() internal {
        owner = makeAddr("owner");
        offRamper = makeAddr("offRamper");
        intentOwner = makeAddr("intentOwner");
        receiver = makeAddr("receiver");
        feeRecipient = makeAddr("feeRecipient");

        attacker = vm.addr(ATTACKER_KEY);
        witness = vm.addr(WITNESS_KEY);
        gatingService = vm.addr(GATING_SERVICE_KEY);

        vm.label(attacker, "attacker");
        vm.label(witness, "witness");
        vm.label(gatingService, "gatingService");

        chainId = block.chainid;
        defaultPayeeId = keccak256(bytes("payee-123"));
        defaultPaymentId = keccak256(bytes("payment-abc"));

        vm.startPrank(owner);
        usdc = new USDCMock(1_000_000_000e6, "USDC", "USDC");
        escrowRegistry = new EscrowRegistry();
        paymentVerifierRegistry = new PaymentVerifierRegistry();
        postIntentHookRegistry = new PostIntentHookRegistry();
        relayerRegistry = new RelayerRegistry();
        nullifierRegistry = new NullifierRegistry();

        escrow = new Escrow(
            owner,
            chainId,
            address(paymentVerifierRegistry),
            address(0),
            0,
            10,
            ONE_DAY_IN_SECONDS
        );
        escrowRegistry.addEscrow(address(escrow));

        orchestrator = new Orchestrator(
            owner,
            chainId,
            address(escrowRegistry),
            address(paymentVerifierRegistry),
            address(postIntentHookRegistry),
            address(relayerRegistry),
            0,
            feeRecipient
        );
        escrow.setOrchestrator(address(orchestrator));

        orchestratorRegistry = new OrchestratorRegistry();
        orchestratorRegistry.addOrchestrator(address(orchestrator));

        attestationVerifier = new SimpleAttestationVerifier(witness);
        verifier = new UnifiedPaymentVerifier(
            orchestratorRegistry,
            nullifierRegistry,
            attestationVerifier
        );

        nullifierRegistry.addWritePermission(address(verifier));
        verifier.addPaymentMethod(VENMO);
        paymentVerifierRegistry.addPaymentMethod(VENMO, address(verifier), _singleCurrencyCodes(USD));
        vm.stopPrank();

        vm.prank(owner);
        usdc.transfer(offRamper, DEPOSIT_AMOUNT);

        vm.prank(offRamper);
        usdc.approve(address(escrow), DEPOSIT_AMOUNT);

        depositId = _createDeposit();
        intentHash = _signalIntent(intentOwner, receiver, INTENT_AMOUNT);
        intent = orchestrator.getIntent(intentHash);
    }

    function _createDeposit() internal returns (uint256 createdDepositId) {
        IEscrow.CreateDepositParams memory params = IEscrow.CreateDepositParams({
            token: IERC20(address(usdc)),
            amount: DEPOSIT_AMOUNT,
            intentAmountRange: IEscrow.Range({ min: DEPOSIT_AMOUNT / 2, max: DEPOSIT_AMOUNT }),
            paymentMethods: _singlePaymentMethods(VENMO),
            paymentMethodData: _singlePaymentMethodData(gatingService, defaultPayeeId, ""),
            currencies: _singleDepositCurrencies(USD, 1e18),
            delegate: address(0),
            intentGuardian: address(0),
            retainOnEmpty: false
        });

        vm.prank(offRamper);
        escrow.createDeposit(params);

        createdDepositId = escrow.depositCounter() - 1;
    }

    function _signalIntent(address caller, address to, uint256 amount) internal returns (bytes32 createdIntentHash) {
        uint256 currentCounter = orchestrator.intentCounter();
        uint256 signatureExpiration = block.timestamp + ONE_DAY_IN_SECONDS;
        bytes memory gatingSignature = _generateGatingServiceSignature(amount, to, signatureExpiration);

        IOrchestrator.SignalIntentParams memory params = IOrchestrator.SignalIntentParams({
            escrow: address(escrow),
            depositId: depositId,
            amount: amount,
            to: to,
            paymentMethod: VENMO,
            fiatCurrency: USD,
            conversionRate: 1e18,
            referrer: address(0),
            referrerFee: 0,
            gatingServiceSignature: gatingSignature,
            signatureExpiration: signatureExpiration,
            postIntentHook: IPostIntentHook(address(0)),
            data: ""
        });

        vm.prank(caller);
        orchestrator.signalIntent(params);

        createdIntentHash = _calculateIntentHash(address(orchestrator), currentCounter);
    }

    function _defaultProofConfig(
        bytes32 targetIntentHash,
        IOrchestrator.Intent memory targetIntent,
        bytes32 paymentId
    ) internal pure returns (PaymentProofConfig memory config) {
        config = PaymentProofConfig({
            paymentMethod: VENMO,
            payeeId: targetIntent.payeeId,
            paymentAmount: targetIntent.amount,
            paymentCurrency: USD,
            paymentTimestamp: targetIntent.timestamp * 1000,
            paymentId: paymentId,
            attestationIntentHash: targetIntentHash,
            attestationReleaseAmount: targetIntent.amount,
            snapshotIntentHash: targetIntentHash,
            snapshotIntentAmount: targetIntent.amount,
            snapshotIntentPaymentMethod: targetIntent.paymentMethod,
            snapshotIntentFiatCurrency: targetIntent.fiatCurrency,
            snapshotIntentPayeeDetails: targetIntent.payeeId,
            snapshotIntentConversionRate: targetIntent.conversionRate,
            snapshotIntentSignalTimestamp: targetIntent.timestamp,
            snapshotIntentTimestampBuffer: 0,
            attestationSignerKey: WITNESS_KEY,
            attestationMetadata: "",
            useCustomAttestationData: false,
            attestationData: "",
            useCustomAttestationDataHash: false,
            attestationDataHash: bytes32(0)
        });
    }

    function _buildProof(PaymentProofConfig memory config) internal view returns (BuiltUnifiedPaymentProof memory built) {
        built.paymentDetails = UnifiedPaymentVerifier.PaymentDetails({
            method: config.paymentMethod,
            payeeId: config.payeeId,
            amount: config.paymentAmount,
            currency: config.paymentCurrency,
            timestamp: config.paymentTimestamp,
            paymentId: config.paymentId
        });

        built.intentSnapshot = UnifiedPaymentVerifier.IntentSnapshot({
            intentHash: config.snapshotIntentHash,
            amount: config.snapshotIntentAmount,
            paymentMethod: config.snapshotIntentPaymentMethod,
            fiatCurrency: config.snapshotIntentFiatCurrency,
            payeeDetails: config.snapshotIntentPayeeDetails,
            conversionRate: config.snapshotIntentConversionRate,
            signalTimestamp: config.snapshotIntentSignalTimestamp,
            timestampBuffer: config.snapshotIntentTimestampBuffer
        });

        bytes memory encodedPayload = _encodePayload(built.paymentDetails, built.intentSnapshot);
        bytes32 payloadHash = keccak256(encodedPayload);
        bytes memory attestationData = config.useCustomAttestationData ? config.attestationData : encodedPayload;
        bytes32 attestationDataHash = config.useCustomAttestationDataHash ? config.attestationDataHash : payloadHash;

        bytes[] memory signatures = new bytes[](1);
        signatures[0] = _signPaymentAttestation(
            config.attestationSignerKey,
            config.attestationIntentHash,
            config.attestationReleaseAmount,
            attestationDataHash
        );

        built.attestation = UnifiedPaymentVerifier.PaymentAttestation({
            intentHash: config.attestationIntentHash,
            releaseAmount: config.attestationReleaseAmount,
            dataHash: attestationDataHash,
            signatures: signatures,
            data: attestationData,
            metadata: config.attestationMetadata
        });

        built.paymentProof = abi.encode(built.attestation);
        built.verificationData = _buildVerificationDataForIntent(config.attestationIntentHash);
    }

    function _verifyAsOrchestrator(BuiltUnifiedPaymentProof memory built)
        internal
        returns (IPaymentVerifier.PaymentVerificationResult memory result)
    {
        vm.prank(address(orchestrator));
        result = verifier.verifyPayment(
            IPaymentVerifier.VerifyPaymentData({
                intentHash: built.attestation.intentHash,
                paymentProof: built.paymentProof,
                data: built.verificationData
            })
        );
    }

    function _buildVerificationDataForIntent(bytes32 targetIntentHash) internal view returns (bytes memory verificationData) {
        IOrchestrator.Intent memory currentIntent = orchestrator.getIntent(targetIntentHash);
        IEscrow.DepositPaymentMethodData memory depositMethod = escrow.getDepositPaymentMethodData(
            currentIntent.depositId,
            currentIntent.paymentMethod
        );

        verificationData = abi.encode(
            currentIntent.amount,
            currentIntent.conversionRate,
            currentIntent.timestamp,
            depositMethod.payeeDetails
        );
    }

    function _generateGatingServiceSignature(
        uint256 amount,
        address to,
        uint256 signatureExpiration
    ) internal view returns (bytes memory signature) {
        bytes32 messageHash = keccak256(
            abi.encodePacked(
                address(orchestrator),
                address(escrow),
                depositId,
                amount,
                to,
                VENMO,
                USD,
                uint256(1e18),
                signatureExpiration,
                chainId
            )
        );

        bytes32 digest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(GATING_SERVICE_KEY, digest);
        signature = abi.encodePacked(r, s, v);
    }

    function _signPaymentAttestation(
        uint256 signerKey,
        bytes32 targetIntentHash,
        uint256 releaseAmount,
        bytes32 dataHash
    ) internal view returns (bytes memory signature) {
        bytes32 digest = _paymentAttestationDigest(targetIntentHash, releaseAmount, dataHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        signature = abi.encodePacked(r, s, v);
    }

    function _paymentAttestationDigest(
        bytes32 targetIntentHash,
        uint256 releaseAmount,
        bytes32 dataHash
    ) internal view returns (bytes32 digest) {
        bytes32 paymentAttestationTypehash =
            keccak256("PaymentAttestation(bytes32 intentHash,uint256 releaseAmount,bytes32 dataHash)");
        bytes32 structHash = keccak256(
            abi.encode(
                paymentAttestationTypehash,
                targetIntentHash,
                releaseAmount,
                dataHash
            )
        );

        digest = keccak256(abi.encodePacked("\x19\x01", verifier.DOMAIN_SEPARATOR(), structHash));
    }

    function _encodePayload(
        UnifiedPaymentVerifier.PaymentDetails memory paymentDetails,
        UnifiedPaymentVerifier.IntentSnapshot memory intentSnapshot
    ) internal pure returns (bytes memory payload) {
        payload = abi.encode(paymentDetails, intentSnapshot);
    }

    function _calculateIntentHash(address targetOrchestrator, uint256 intentCounter)
        internal
        pure
        returns (bytes32 calculatedIntentHash)
    {
        uint256 intermediateHash = uint256(keccak256(abi.encodePacked(targetOrchestrator, intentCounter)));
        calculatedIntentHash = bytes32(intermediateHash % CIRCOM_PRIME_FIELD);
    }

    function _singleCurrencyCodes(bytes32 currencyCode) internal pure returns (bytes32[] memory currencies) {
        currencies = new bytes32[](1);
        currencies[0] = currencyCode;
    }

    function _singlePaymentMethods(bytes32 paymentMethod) internal pure returns (bytes32[] memory paymentMethods) {
        paymentMethods = new bytes32[](1);
        paymentMethods[0] = paymentMethod;
    }

    function _singlePaymentMethodData(
        address intentGatingService,
        bytes32 payeeDetails,
        bytes memory rawData
    ) internal pure returns (IEscrow.DepositPaymentMethodData[] memory paymentMethodData) {
        paymentMethodData = new IEscrow.DepositPaymentMethodData[](1);
        paymentMethodData[0] = IEscrow.DepositPaymentMethodData({
            intentGatingService: intentGatingService,
            payeeDetails: payeeDetails,
            data: rawData
        });
    }

    function _singleDepositCurrencies(
        bytes32 currencyCode,
        uint256 minConversionRate
    ) internal pure returns (IEscrow.Currency[][] memory currenciesByMethod) {
        IEscrow.Currency[] memory currencies = new IEscrow.Currency[](1);
        currencies[0] = IEscrow.Currency({ code: currencyCode, minConversionRate: minConversionRate });

        currenciesByMethod = new IEscrow.Currency[][](1);
        currenciesByMethod[0] = currencies;
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {EscrowV2} from "contracts/EscrowV2.sol";
import {OrchestratorV3} from "contracts/OrchestratorV3.sol";
import {RiskManager} from "contracts/RiskManager.sol";
import {StakeVault} from "contracts/StakeVault.sol";
import {AttestationVerifierMock} from "contracts/mocks/AttestationVerifierMock.sol";
import {PaymentVerifierMock} from "contracts/mocks/PaymentVerifierMock.sol";
import {USDCMock} from "contracts/mocks/USDCMock.sol";
import {EscrowRegistry} from "contracts/registries/EscrowRegistry.sol";
import {OrchestratorRegistry} from "contracts/registries/OrchestratorRegistry.sol";
import {PaymentVerifierRegistry} from "contracts/registries/PaymentVerifierRegistry.sol";
import {NullifierRegistry} from "contracts/registries/NullifierRegistry.sol";
import {NullifierRegistryV2} from "contracts/registries/NullifierRegistryV2.sol";
import {IEscrowV2} from "contracts/interfaces/IEscrowV2.sol";
import {IIntentRiskHook} from "contracts/interfaces/IIntentRiskHook.sol";
import {IOrchestratorV3} from "contracts/interfaces/IOrchestratorV3.sol";
import {IPostIntentHookV2} from "contracts/interfaces/IPostIntentHookV2.sol";
import {IReferralFee} from "contracts/interfaces/IReferralFee.sol";
import {IRiskManager} from "contracts/interfaces/IRiskManager.sol";
import {IStakeVault} from "contracts/interfaces/IStakeVault.sol";
import {IAttestationVerifier} from "contracts/interfaces/IAttestationVerifier.sol";
import {INullifierRegistryV2} from "contracts/interfaces/INullifierRegistryV2.sol";

abstract contract RiskManagerIntegrationFixture is Test {
    uint256 internal constant CHAIN_ID = 1;
    uint64 internal constant HOUR = 1 hours;
    uint64 internal constant DAY = 1 days;
    uint64 internal constant BASE_INTENT_PERIOD = 1 hours;
    uint32 internal constant EXTENSION_SLOPE = 10;
    uint256 internal constant CIRCOM_PRIME_FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;
    bytes32 internal constant PAYPAL = keccak256("paypal");
    bytes32 internal constant ZELLE = keccak256("zelle");
    bytes32 internal constant USD = keccak256("USD");
    bytes32 internal constant PAYEE = keccak256("maker-payee");

    address internal maker;
    address internal makerDelegate;
    address internal taker;
    address internal secondTaker;
    address internal recipient;
    address internal other;

    USDCMock internal token;
    PaymentVerifierRegistry internal paymentVerifierRegistry;
    EscrowRegistry internal escrowRegistry;
    OrchestratorRegistry internal orchestratorRegistry;
    NullifierRegistry internal legacyNullifierRegistry;
    NullifierRegistryV2 internal nullifierRegistry;
    PaymentVerifierMock internal verifier;
    AttestationVerifierMock internal attestationVerifier;
    EscrowV2 internal escrow;
    OrchestratorV3 internal orchestrator;
    StakeVault internal vault;
    RiskManager internal manager;

    function setUp() public virtual {
        maker = makeAddr("riskMaker");
        makerDelegate = makeAddr("riskMakerDelegate");
        taker = makeAddr("riskTaker");
        secondTaker = makeAddr("riskSecondTaker");
        recipient = makeAddr("riskRecipient");
        other = makeAddr("riskOther");

        token = new USDCMock(1_000_000e6, "USD Coin", "USDC");
        paymentVerifierRegistry = new PaymentVerifierRegistry();
        escrowRegistry = new EscrowRegistry();
        orchestratorRegistry = new OrchestratorRegistry();
        legacyNullifierRegistry = new NullifierRegistry();
        nullifierRegistry = new NullifierRegistryV2(legacyNullifierRegistry);
        verifier = new PaymentVerifierMock();
        attestationVerifier = new AttestationVerifierMock();
        bytes32[] memory currencies = new bytes32[](1);
        currencies[0] = USD;
        paymentVerifierRegistry.addPaymentMethod(PAYPAL, address(verifier), currencies);
        paymentVerifierRegistry.addPaymentMethod(ZELLE, address(verifier), currencies);

        escrow = new EscrowV2(
            address(this),
            CHAIN_ID,
            address(orchestratorRegistry),
            address(paymentVerifierRegistry),
            address(this),
            0,
            100,
            BASE_INTENT_PERIOD
        );
        orchestrator = new OrchestratorV3(
            address(this),
            CHAIN_ID,
            address(escrowRegistry),
            address(paymentVerifierRegistry),
            0,
            address(this),
            2_000_000
        );
        vault = new StakeVault(address(this), token, address(this), 30 days, DAY);
        manager = new RiskManager(
            address(this),
            IOrchestratorV3(address(orchestrator)),
            IStakeVault(address(vault)),
            IAttestationVerifier(address(attestationVerifier)),
            INullifierRegistryV2(address(nullifierRegistry))
        );
        nullifierRegistry.addWritePermission(address(this));
        vault.proposeController(address(manager));
        vm.warp(block.timestamp + DAY);
        manager.acceptVaultController();

        escrowRegistry.addEscrow(address(escrow));
        orchestratorRegistry.addOrchestrator(address(orchestrator));
        verifier.setShouldVerifyPayment(true);
        verifier.setVerificationContext(address(orchestrator), address(escrow));
        manager.setPlatformRiskConfig(ZELLE, _platformConfig(false, false, 0, 0, EXTENSION_SLOPE));
        manager.setPlatformRiskConfig(PAYPAL, _platformConfig(true, false, 10_000, 30 days, EXTENSION_SLOPE));

        token.transfer(maker, 100_000e6);
        token.transfer(taker, 20_000e6);
        token.transfer(secondTaker, 20_000e6);
        vm.prank(maker);
        token.approve(address(escrow), type(uint256).max);
        vm.prank(taker);
        token.approve(address(vault), type(uint256).max);
        vm.prank(secondTaker);
        token.approve(address(vault), type(uint256).max);

        vm.prank(maker);
        escrow.createDeposit(_depositParams());
        vm.prank(maker);
        orchestrator.setDepositRiskHook(address(escrow), 0, IIntentRiskHook(address(manager)));
    }

    function _platformConfig(
        bool chargebackable,
        bool deferredPayoutEnabled,
        uint16 reserveBps,
        uint64 riskWindow,
        uint32 slope
    ) internal pure returns (IRiskManager.PlatformRiskConfig memory) {
        return IRiskManager.PlatformRiskConfig({
            enabled: true,
            chargeback: IRiskManager.ChargebackConfig({
                chargebackable: chargebackable,
                deferredPayoutEnabled: deferredPayoutEnabled,
                reserveBps: reserveBps,
                riskWindow: riskWindow
            }),
            intentExtension: IRiskManager.IntentExtensionConfig({extensionPenaltyBpsPerHour: slope})
        });
    }

    function _emptyOracle() internal pure returns (IEscrowV2.OracleRateConfig memory) {
        return IEscrowV2.OracleRateConfig({adapter: address(0), adapterConfig: "", spreadBps: 0, maxStaleness: 0});
    }

    function _depositParams() internal view returns (IEscrowV2.CreateDepositParams memory params) {
        bytes32[] memory methods = new bytes32[](2);
        methods[0] = PAYPAL;
        methods[1] = ZELLE;
        IEscrowV2.DepositPaymentMethodData[] memory methodData = new IEscrowV2.DepositPaymentMethodData[](2);
        methodData[0] =
            IEscrowV2.DepositPaymentMethodData({intentGatingService: address(0), payeeDetails: PAYEE, data: ""});
        methodData[1] = methodData[0];
        IEscrowV2.Currency[][] memory currencies = new IEscrowV2.Currency[][](2);
        currencies[0] = new IEscrowV2.Currency[](1);
        currencies[1] = new IEscrowV2.Currency[](1);
        currencies[0][0] = IEscrowV2.Currency({code: USD, minConversionRate: 1e18, oracleRateConfig: _emptyOracle()});
        currencies[1][0] = currencies[0][0];
        params = IEscrowV2.CreateDepositParams({
            token: IERC20(address(token)),
            amount: 50_000e6,
            intentAmountRange: IEscrowV2.Range({min: 1e6, max: 10_000e6}),
            paymentMethods: methods,
            paymentMethodData: methodData,
            currencies: currencies,
            delegate: makerDelegate,
            intentGuardian: address(manager),
            retainOnEmpty: true
        });
    }

    function _emptyReferralFees() internal pure returns (IReferralFee.ReferralFee[] memory) {
        return new IReferralFee.ReferralFee[](0);
    }

    function _signalParams(address payoutRecipient, uint256 amount, bytes32 paymentMethod)
        internal
        view
        returns (IOrchestratorV3.SignalIntentParams memory)
    {
        return IOrchestratorV3.SignalIntentParams({
            escrow: address(escrow),
            depositId: 0,
            amount: amount,
            to: payoutRecipient,
            paymentMethod: paymentMethod,
            fiatCurrency: USD,
            conversionRate: 1e18,
            referralFees: _emptyReferralFees(),
            gatingServiceSignature: "",
            signatureExpiration: 0,
            postIntentHook: IPostIntentHookV2(address(0)),
            preIntentHookData: "",
            data: ""
        });
    }

    function _nextIntentHash() internal view returns (bytes32) {
        return bytes32(
            uint256(keccak256(abi.encodePacked(address(orchestrator), orchestrator.intentCounter())))
                % CIRCOM_PRIME_FIELD
        );
    }

    function _signal(address caller, address payoutRecipient, uint256 amount, bytes32 paymentMethod)
        internal
        returns (bytes32 intentHash)
    {
        intentHash = _nextIntentHash();
        vm.prank(caller);
        orchestrator.signalIntent(_signalParams(payoutRecipient, amount, paymentMethod));
    }

    function _signalDefault(address caller, uint256 amount, bytes32 paymentMethod) internal returns (bytes32) {
        return _signal(caller, caller, amount, paymentMethod);
    }

    function _paymentProof(bytes32 intentHash, uint256 releaseAmount) internal view returns (bytes memory) {
        return abi.encode(releaseAmount, block.timestamp, PAYEE, USD, intentHash);
    }

    function _fulfill(bytes32 intentHash, uint256 releaseAmount) internal {
        orchestrator.fulfillIntent(
            IOrchestratorV3.FulfillIntentParams({
                paymentProof: _paymentProof(intentHash, releaseAmount),
                intentHash: intentHash,
                verificationData: "",
                postIntentHookData: ""
            })
        );
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Escrow} from "contracts/Escrow.sol";
import {Orchestrator} from "contracts/Orchestrator.sol";
import {ProtocolViewer} from "contracts/ProtocolViewer.sol";
import {OrchestratorMock} from "contracts/mocks/OrchestratorMock.sol";
import {PaymentVerifierMock} from "contracts/mocks/PaymentVerifierMock.sol";
import {PostIntentHookMock} from "contracts/mocks/PostIntentHookMock.sol";
import {ReentrantOrchestratorMock} from "contracts/mocks/ReentrantOrchestratorMock.sol";
import {USDCMock} from "contracts/mocks/USDCMock.sol";
import {EscrowRegistry} from "contracts/registries/EscrowRegistry.sol";
import {PaymentVerifierRegistry} from "contracts/registries/PaymentVerifierRegistry.sol";
import {PostIntentHookRegistry} from "contracts/registries/PostIntentHookRegistry.sol";
import {RelayerRegistry} from "contracts/registries/RelayerRegistry.sol";
import {IEscrow} from "contracts/interfaces/IEscrow.sol";
import {IOrchestrator} from "contracts/interfaces/IOrchestrator.sol";
import {IPostIntentHook} from "contracts/interfaces/IPostIntentHook.sol";

abstract contract EscrowLegacyFixture is Test {
    uint256 internal constant CHAIN_ID = 1;
    uint256 internal constant GATING_KEY = 0xA11CE;
    bytes32 internal constant VENMO = keccak256("venmo");
    bytes32 internal constant PAYPAL = keccak256("paypal");
    bytes32 internal constant USD = keccak256("USD");
    bytes32 internal constant EUR = keccak256("EUR");
    bytes32 internal constant AED = keccak256("AED");
    bytes32 internal constant PAYEE = keccak256("PaymentService1payeeDetails");

    address internal offRamper;
    address internal offRamperDelegate;
    address internal offRamperNewAccount;
    address internal onRamper;
    address internal onRamperOtherAddress;
    address internal onRamperTwo;
    address internal receiver;
    address internal maliciousOnRamper;
    address internal feeRecipient;
    address internal gatingService;
    address internal witness;
    address internal dustRecipient;
    address internal intentGuardian;

    USDCMock internal token;
    Escrow internal escrow;
    Orchestrator internal orchestrator;
    ProtocolViewer internal viewer;
    PaymentVerifierRegistry internal paymentVerifierRegistry;
    PostIntentHookRegistry internal postIntentHookRegistry;
    EscrowRegistry internal escrowRegistry;
    RelayerRegistry internal relayerRegistry;
    PaymentVerifierMock internal verifier;
    PaymentVerifierMock internal otherVerifier;
    PostIntentHookMock internal postIntentHookMock;
    OrchestratorMock internal orchestratorMock;
    ReentrantOrchestratorMock internal reentrantOrchestratorMock;
    uint256 internal intentCounter;

    function setUp() public virtual {
        offRamper = makeAddr("offRamper");
        offRamperDelegate = makeAddr("offRamperDelegate");
        offRamperNewAccount = makeAddr("offRamperNewAccount");
        onRamper = makeAddr("onRamper");
        onRamperOtherAddress = makeAddr("onRamperOtherAddress");
        onRamperTwo = makeAddr("onRamperTwo");
        receiver = makeAddr("receiver");
        maliciousOnRamper = makeAddr("maliciousOnRamper");
        feeRecipient = makeAddr("feeRecipient");
        gatingService = vm.addr(GATING_KEY);
        witness = makeAddr("witness");
        dustRecipient = makeAddr("dustRecipient");
        intentGuardian = makeAddr("intentGuardian");

        token = new USDCMock(1_000_000_000e6, "USDC", "USDC");
        token.transfer(offRamper, 10_000e6);
        paymentVerifierRegistry = new PaymentVerifierRegistry();
        postIntentHookRegistry = new PostIntentHookRegistry();
        escrowRegistry = new EscrowRegistry();
        relayerRegistry = new RelayerRegistry();

        escrow = new Escrow(address(this), CHAIN_ID, address(paymentVerifierRegistry), dustRecipient, 0, 3, 1 days);
        escrowRegistry.addEscrow(address(escrow));
        orchestrator = new Orchestrator(
            address(this),
            CHAIN_ID,
            address(escrowRegistry),
            address(paymentVerifierRegistry),
            address(postIntentHookRegistry),
            address(relayerRegistry),
            0,
            feeRecipient
        );
        escrow.setOrchestrator(address(orchestrator));
        viewer = new ProtocolViewer(address(escrow), address(orchestrator));

        verifier = new PaymentVerifierMock();
        otherVerifier = new PaymentVerifierMock();
        verifier.setVerificationContext(address(orchestrator), address(escrow));
        otherVerifier.setVerificationContext(address(orchestrator), address(escrow));
        bytes32[] memory supportedCurrencies = new bytes32[](2);
        supportedCurrencies[0] = USD;
        supportedCurrencies[1] = EUR;
        paymentVerifierRegistry.addPaymentMethod(VENMO, address(verifier), supportedCurrencies);
        paymentVerifierRegistry.addPaymentMethod(PAYPAL, address(otherVerifier), supportedCurrencies);

        postIntentHookMock = new PostIntentHookMock(address(token), address(escrow));
        orchestratorMock = new OrchestratorMock(address(escrow));
        reentrantOrchestratorMock = new ReentrantOrchestratorMock(address(escrow));

        vm.prank(offRamper);
        token.approve(address(escrow), 10_000e6);
    }

    function _baseCreateParams() internal view returns (IEscrow.CreateDepositParams memory params) {
        bytes32[] memory methods = new bytes32[](1);
        methods[0] = VENMO;
        IEscrow.DepositPaymentMethodData[] memory methodData = new IEscrow.DepositPaymentMethodData[](1);
        methodData[0] =
            IEscrow.DepositPaymentMethodData({intentGatingService: gatingService, payeeDetails: PAYEE, data: ""});
        IEscrow.Currency[][] memory currencies = new IEscrow.Currency[][](1);
        currencies[0] = new IEscrow.Currency[](2);
        currencies[0][0] = IEscrow.Currency({code: USD, minConversionRate: 1.01e18});
        currencies[0][1] = IEscrow.Currency({code: EUR, minConversionRate: 0.95e18});
        params = IEscrow.CreateDepositParams({
            token: IERC20(address(token)),
            amount: 100e6,
            intentAmountRange: IEscrow.Range({min: 10e6, max: 200e6}),
            paymentMethods: methods,
            paymentMethodData: methodData,
            currencies: currencies,
            delegate: offRamperDelegate,
            intentGuardian: address(0),
            retainOnEmpty: true
        });
    }

    function _createBaseDeposit() internal returns (uint256 id) {
        id = escrow.depositCounter();
        escrow.createDeposit(_baseCreateParams());
    }

    function _createAsOffRamper(IEscrow.CreateDepositParams memory params) internal {
        vm.prank(offRamper);
        escrow.createDeposit(params);
    }

    function _gatingSignature(
        uint256 depositId,
        uint256 amount,
        address taker,
        bytes32 paymentMethod,
        bytes32 currency,
        uint256 conversionRate,
        uint256 expiration
    ) internal view returns (bytes memory) {
        bytes32 messageHash = keccak256(
            abi.encodePacked(
                address(orchestrator),
                address(escrow),
                depositId,
                amount,
                taker,
                paymentMethod,
                currency,
                conversionRate,
                expiration,
                CHAIN_ID
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(GATING_KEY, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signalIntentCall(uint256 depositId, uint256 amount, uint256 conversionRate) internal {
        uint256 expiration = block.timestamp + 1 days;
        bytes memory gatingSignature =
            _gatingSignature(depositId, amount, onRamper, VENMO, USD, conversionRate, expiration);
        vm.prank(onRamper);
        orchestrator.signalIntent(
            IOrchestrator.SignalIntentParams({
                escrow: address(escrow),
                depositId: depositId,
                amount: amount,
                to: onRamper,
                paymentMethod: VENMO,
                fiatCurrency: USD,
                conversionRate: conversionRate,
                referrer: address(0),
                referrerFee: 0,
                gatingServiceSignature: gatingSignature,
                signatureExpiration: expiration,
                postIntentHook: IPostIntentHook(address(0)),
                data: ""
            })
        );
    }

    function _signalIntent(uint256 depositId, uint256 amount, uint256 conversionRate)
        internal
        returns (bytes32 intentHash)
    {
        _signalIntentCall(depositId, amount, conversionRate);
        bytes32[] memory accountIntents = orchestrator.getAccountIntents(onRamper);
        intentHash = accountIntents[accountIntents.length - 1];
    }
}

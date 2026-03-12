// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { Test } from "forge-std/Test.sol";
import { Vm } from "forge-std/Vm.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { Orchestrator } from "../../contracts/Orchestrator.sol";
import { Escrow } from "../../contracts/Escrow.sol";
import { IOrchestrator } from "../../contracts/interfaces/IOrchestrator.sol";
import { IEscrow } from "../../contracts/interfaces/IEscrow.sol";
import { IPostIntentHook } from "../../contracts/interfaces/IPostIntentHook.sol";
import { USDCMock } from "../../contracts/mocks/USDCMock.sol";
import { PaymentVerifierMock } from "../../contracts/mocks/PaymentVerifierMock.sol";
import { EscrowRegistry } from "../../contracts/registries/EscrowRegistry.sol";
import { PaymentVerifierRegistry } from "../../contracts/registries/PaymentVerifierRegistry.sol";
import { PostIntentHookRegistry } from "../../contracts/registries/PostIntentHookRegistry.sol";
import { RelayerRegistry } from "../../contracts/registries/RelayerRegistry.sol";

abstract contract ProtocolV1TestBase is Test {
    bytes32 internal constant VENMO = keccak256("VENMO");
    bytes32 internal constant USD = keccak256("USD");
    uint256 internal constant CHAIN_ID = 1;
    uint256 internal constant INTENT_EXPIRATION_PERIOD = 7 days;

    Orchestrator internal orchestrator;
    Escrow internal escrow;
    USDCMock internal usdc;
    PaymentVerifierRegistry internal paymentVerifierRegistry;
    EscrowRegistry internal escrowRegistry;
    PostIntentHookRegistry internal postIntentHookRegistry;
    RelayerRegistry internal relayerRegistry;
    PaymentVerifierMock internal venmoVerifier;

    address internal owner;
    address internal depositor;
    address internal takerA;
    address internal takerB;
    address internal protocolFeeRecipient;

    function _setUpV1Core() internal {
        owner = makeAddr("owner");
        depositor = makeAddr("depositor");
        takerA = makeAddr("takerA");
        takerB = makeAddr("takerB");
        protocolFeeRecipient = makeAddr("protocolFeeRecipient");

        usdc = new USDCMock(100000000e6, "USDC", "USDC");

        vm.startPrank(owner);
        escrowRegistry = new EscrowRegistry();
        paymentVerifierRegistry = new PaymentVerifierRegistry();
        postIntentHookRegistry = new PostIntentHookRegistry();
        relayerRegistry = new RelayerRegistry();
        vm.stopPrank();

        vm.prank(owner);
        orchestrator = new Orchestrator(
            owner,
            CHAIN_ID,
            address(escrowRegistry),
            address(paymentVerifierRegistry),
            address(postIntentHookRegistry),
            address(relayerRegistry),
            0,
            protocolFeeRecipient
        );

        vm.prank(owner);
        escrow = new Escrow(
            owner,
            CHAIN_ID,
            address(paymentVerifierRegistry),
            protocolFeeRecipient,
            1e4,
            100,
            INTENT_EXPIRATION_PERIOD
        );

        vm.prank(owner);
        escrow.setOrchestrator(address(orchestrator));

        venmoVerifier = new PaymentVerifierMock();
        venmoVerifier.setShouldVerifyPayment(true);
        venmoVerifier.setVerificationContext(address(orchestrator), address(escrow));

        _registerPaymentMethod(VENMO, address(venmoVerifier), _singleCurrencyCodes(USD));

        vm.prank(owner);
        escrowRegistry.addEscrow(address(escrow));

        vm.prank(owner);
        orchestrator.setAllowMultipleIntents(true);

        deal(address(usdc), depositor, 200_000_000e6);
        vm.prank(depositor);
        usdc.approve(address(escrow), type(uint256).max);
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

    function _registerPaymentMethod(
        bytes32 paymentMethod,
        address verifier,
        bytes32[] memory currencies
    ) internal {
        vm.prank(owner);
        paymentVerifierRegistry.addPaymentMethod(paymentMethod, verifier, currencies);
    }

    function _createDeposit(uint256 amount, uint256 minAmount, uint256 maxAmount) internal returns (uint256 depositId) {
        IEscrow.CreateDepositParams memory params = IEscrow.CreateDepositParams({
            token: IERC20(address(usdc)),
            amount: amount,
            intentAmountRange: IEscrow.Range({ min: minAmount, max: maxAmount }),
            paymentMethods: _singlePaymentMethods(VENMO),
            paymentMethodData: _singlePaymentMethodData(address(0), keccak256("payee"), ""),
            currencies: _singleDepositCurrencies(USD, 1e18),
            delegate: address(0),
            intentGuardian: address(0),
            retainOnEmpty: false
        });

        vm.prank(depositor);
        escrow.createDeposit(params);
        depositId = escrow.depositCounter() - 1;
    }

    function _signal(address taker, uint256 depositId, uint256 amount) internal returns (bytes32 intentHash) {
        vm.recordLogs();
        IOrchestrator.SignalIntentParams memory params = IOrchestrator.SignalIntentParams({
            escrow: address(escrow),
            depositId: depositId,
            amount: amount,
            to: taker,
            paymentMethod: VENMO,
            fiatCurrency: USD,
            conversionRate: 1e18,
            referrer: address(0),
            referrerFee: 0,
            gatingServiceSignature: "",
            signatureExpiration: 0,
            postIntentHook: IPostIntentHook(address(0)),
            data: ""
        });

        vm.prank(taker);
        orchestrator.signalIntent(params);

        return _extractIntentHash(vm.getRecordedLogs());
    }

    function _extractIntentHash(Vm.Log[] memory entries) internal view returns (bytes32 intentHash) {
        bytes32 signalEventSig = keccak256(
            "IntentSignaled(bytes32,address,uint256,bytes32,address,address,uint256,bytes32,uint256,uint256)"
        );

        for (uint256 index = 0; index < entries.length; index++) {
            if (
                entries[index].emitter == address(orchestrator)
                    && entries[index].topics.length > 0
                    && entries[index].topics[0] == signalEventSig
            ) {
                return entries[index].topics[1];
            }
        }

        revert("IntentSignaled not found");
    }
}

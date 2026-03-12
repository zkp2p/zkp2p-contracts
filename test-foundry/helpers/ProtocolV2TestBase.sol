// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { EscrowV2 } from "../../contracts/EscrowV2.sol";
import { OrchestratorV2 } from "../../contracts/OrchestratorV2.sol";
import { IReferralFee } from "../../contracts/interfaces/IReferralFee.sol";
import { IEscrowV2 } from "../../contracts/interfaces/IEscrowV2.sol";
import { IOrchestratorV2 } from "../../contracts/interfaces/IOrchestratorV2.sol";
import { IPostIntentHookV2 } from "../../contracts/interfaces/IPostIntentHookV2.sol";
import { USDCMock } from "../../contracts/mocks/USDCMock.sol";
import { PaymentVerifierMock } from "../../contracts/mocks/PaymentVerifierMock.sol";
import { OrchestratorRegistry } from "../../contracts/registries/OrchestratorRegistry.sol";
import { PaymentVerifierRegistry } from "../../contracts/registries/PaymentVerifierRegistry.sol";
import { RelayerRegistry } from "../../contracts/registries/RelayerRegistry.sol";
import { EscrowRegistry } from "../../contracts/registries/EscrowRegistry.sol";

abstract contract ProtocolV2TestBase is Test {
    bytes32 internal constant VENMO = keccak256("venmo");
    bytes32 internal constant USD = keccak256("USD");
    uint256 internal constant CHAIN_ID = 1;

    OrchestratorV2 internal orchestrator;
    EscrowV2 internal escrow;
    USDCMock internal usdc;
    PaymentVerifierRegistry internal paymentVerifierRegistry;
    OrchestratorRegistry internal orchestratorRegistry;
    RelayerRegistry internal relayerRegistry;
    EscrowRegistry internal escrowRegistry;
    PaymentVerifierMock internal verifier;

    address internal owner;
    address internal depositor;
    address internal delegate;
    address internal takerA;
    address internal takerB;
    address internal unauthorizedCaller;
    address internal feeRecipient;

    function _setUpV2Core() internal {
        owner = makeAddr("owner");
        depositor = makeAddr("depositor");
        delegate = makeAddr("delegate");
        takerA = makeAddr("takerA");
        takerB = makeAddr("takerB");
        unauthorizedCaller = makeAddr("unauthorizedCaller");
        feeRecipient = makeAddr("feeRecipient");

        vm.startPrank(owner);
        usdc = new USDCMock(1_000_000_000e6, "USDC", "USDC");
        escrowRegistry = new EscrowRegistry();
        paymentVerifierRegistry = new PaymentVerifierRegistry();
        relayerRegistry = new RelayerRegistry();
        orchestratorRegistry = new OrchestratorRegistry();
        escrow = new EscrowV2(
            owner,
            CHAIN_ID,
            address(orchestratorRegistry),
            address(paymentVerifierRegistry),
            address(0),
            0,
            10,
            1 hours
        );
        orchestrator = new OrchestratorV2(
            owner,
            CHAIN_ID,
            address(escrowRegistry),
            address(paymentVerifierRegistry),
            address(relayerRegistry),
            0,
            feeRecipient
        );
        escrowRegistry.addEscrow(address(escrow));
        orchestratorRegistry.addOrchestrator(address(orchestrator));
        verifier = new PaymentVerifierMock();
        verifier.setVerificationContext(address(orchestrator), address(escrow));
        paymentVerifierRegistry.addPaymentMethod(VENMO, address(verifier), _singleCurrencyCodes(USD));
        vm.stopPrank();

        vm.prank(owner);
        usdc.transfer(depositor, 10_000e6);

        vm.prank(depositor);
        usdc.approve(address(escrow), type(uint256).max);
    }

    function _createDeposit() internal returns (uint256 depositId) {
        IEscrowV2.CreateDepositParams memory params = IEscrowV2.CreateDepositParams({
            token: IERC20(address(usdc)),
            amount: 100e6,
            intentAmountRange: IEscrowV2.Range({ min: 10e6, max: 200e6 }),
            paymentMethods: _singlePaymentMethods(VENMO),
            paymentMethodData: _singlePaymentMethodData(address(0), keccak256("payeeDetails"), ""),
            currencies: _singleDepositCurrencies(USD, 1.01e18),
            delegate: delegate,
            intentGuardian: address(0),
            retainOnEmpty: false
        });

        vm.prank(depositor);
        escrow.createDeposit(params);
        depositId = escrow.depositCounter() - 1;
    }

    function _defaultSignalIntentParams(address caller)
        internal
        view
        returns (IOrchestratorV2.SignalIntentParams memory params)
    {
        params = IOrchestratorV2.SignalIntentParams({
            escrow: address(escrow),
            depositId: 0,
            amount: 50e6,
            to: caller,
            paymentMethod: VENMO,
            fiatCurrency: USD,
            conversionRate: 1.02e18,
            referralFees: _emptyReferralFees(),
            gatingServiceSignature: "",
            signatureExpiration: 0,
            postIntentHook: IPostIntentHookV2(address(0)),
            preIntentHookData: "",
            data: ""
        });
    }

    function _emptyReferralFees() internal pure returns (IReferralFee.ReferralFee[] memory referralFees) {
        referralFees = new IReferralFee.ReferralFee[](0);
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
    ) internal pure returns (IEscrowV2.DepositPaymentMethodData[] memory paymentMethodData) {
        paymentMethodData = new IEscrowV2.DepositPaymentMethodData[](1);
        paymentMethodData[0] = IEscrowV2.DepositPaymentMethodData({
            intentGatingService: intentGatingService,
            payeeDetails: payeeDetails,
            data: rawData
        });
    }

    function _singleDepositCurrencies(
        bytes32 currencyCode,
        uint256 minConversionRate
    ) internal pure returns (IEscrowV2.Currency[][] memory currenciesByMethod) {
        IEscrowV2.Currency[] memory currencies = new IEscrowV2.Currency[](1);
        currencies[0] = IEscrowV2.Currency({
            code: currencyCode,
            minConversionRate: minConversionRate,
            oracleRateConfig: IEscrowV2.OracleRateConfig({
                adapter: address(0),
                adapterConfig: "",
                spreadBps: 0,
                maxStaleness: 0
            })
        });

        currenciesByMethod = new IEscrowV2.Currency[][](1);
        currenciesByMethod[0] = currencies;
    }
}

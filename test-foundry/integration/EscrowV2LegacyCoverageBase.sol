// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Vm } from "forge-std/Vm.sol";

import { EscrowV2 } from "../../contracts/EscrowV2.sol";
import { IEscrowV2 } from "../../contracts/interfaces/IEscrowV2.sol";
import { OrchestratorMock } from "../../contracts/mocks/OrchestratorMock.sol";
import { PaymentVerifierMock } from "../../contracts/mocks/PaymentVerifierMock.sol";
import { RateManagerMock } from "../../contracts/mocks/RateManagerMock.sol";
import { RevertingOracleAdapterMock } from "../../contracts/mocks/RevertingOracleAdapterMock.sol";
import { RevertingPruneOrchestratorMock } from "../../contracts/mocks/RevertingPruneOrchestratorMock.sol";
import { StaticOracleAdapterMock } from "../../contracts/mocks/StaticOracleAdapterMock.sol";
import { USDCMock } from "../../contracts/mocks/USDCMock.sol";
import { OrchestratorRegistry } from "../../contracts/registries/OrchestratorRegistry.sol";
import { PaymentVerifierRegistry } from "../../contracts/registries/PaymentVerifierRegistry.sol";
import { ProtocolV2TestBase } from "../helpers/ProtocolV2TestBase.sol";

interface ILockingOrchestrator {
    function lockFunds(uint256 depositId, bytes32 intentHash, uint256 amount) external;
}

abstract contract EscrowV2LegacyCoverageBase is ProtocolV2TestBase {
    bytes32 internal constant PAYPAL = keccak256("paypal");
    bytes32 internal constant EUR = keccak256("EUR");
    bytes32 internal constant JPY = bytes32("JPY");
    bytes32 internal constant PAYEE_DETAILS = keccak256("payee");
    bytes32 internal constant RATE_MANAGER_ID = bytes32("manager-1");

    uint256 internal constant INTENT_ORCHESTRATOR_SLOT = 15;
    bytes32 internal constant DEPOSIT_ACCEPTING_INTENTS_UPDATED_TOPIC =
        keccak256("DepositAcceptingIntentsUpdated(uint256,bool)");

    event DepositReceived(
        uint256 indexed depositId,
        address indexed depositor,
        IERC20 indexed token,
        uint256 amount,
        IEscrowV2.Range intentAmountRange,
        address delegate,
        address intentGuardian
    );
    event DepositPaymentMethodAdded(
        uint256 indexed depositId,
        bytes32 indexed paymentMethod,
        bytes32 indexed payeeDetails,
        address intentGatingService
    );
    event DepositPaymentMethodActiveUpdated(uint256 indexed depositId, bytes32 indexed paymentMethod, bool active);
    event DepositCurrencyAdded(
        uint256 indexed depositId,
        bytes32 indexed paymentMethod,
        bytes32 indexed currency,
        uint256 minConversionRate
    );
    event DepositMinConversionRateUpdated(
        uint256 indexed depositId,
        bytes32 indexed paymentMethod,
        bytes32 indexed currency,
        uint256 newMinConversionRate
    );
    event DepositFundsAdded(uint256 indexed depositId, address indexed depositor, uint256 amount);
    event DepositWithdrawn(uint256 indexed depositId, address indexed depositor, uint256 amount);
    event DepositClosed(uint256 depositId, address depositor);
    event DepositAcceptingIntentsUpdated(uint256 indexed depositId, bool acceptingIntents);
    event DepositIntentAmountRangeUpdated(uint256 indexed depositId, IEscrowV2.Range intentAmountRange);
    event DepositRetainOnEmptyUpdated(uint256 indexed depositId, bool retainOnEmpty);
    event DepositDelegateSet(uint256 indexed depositId, address indexed depositor, address indexed delegate);
    event DepositDelegateRemoved(uint256 indexed depositId, address indexed depositor);
    event FundsUnlocked(uint256 indexed depositId, bytes32 indexed intentHash, uint256 amount);
    event FundsUnlockedAndTransferred(
        uint256 indexed depositId,
        bytes32 indexed intentHash,
        uint256 unlockedAmount,
        uint256 transferredAmount,
        address to
    );
    event DustCollected(uint256 indexed depositId, uint256 dustAmount, address indexed dustRecipient);
    event IntentExpiryExtended(uint256 indexed depositId, bytes32 indexed intentHash, uint256 newExpiryTime);
    event DepositOracleRateConfigSet(
        uint256 indexed depositId,
        bytes32 indexed paymentMethod,
        bytes32 indexed currencyCode,
        address adapter,
        bytes adapterConfig,
        int16 spreadBps,
        uint32 maxStaleness
    );
    event OrchestratorRegistryUpdated(address indexed orchestratorRegistry);
    event PaymentVerifierRegistryUpdated(address indexed paymentVerifierRegistry);
    event DustRecipientUpdated(address indexed dustRecipient);
    event DustThresholdUpdated(uint256 dustThreshold);
    event MaxIntentsPerDepositUpdated(uint256 maxIntentsPerDeposit);
    event IntentExpirationPeriodUpdated(uint256 intentExpirationPeriod);

    PaymentVerifierMock internal otherVerifier;
    OrchestratorMock internal orchestratorMock;
    OrchestratorMock internal secondaryOrchestratorMock;
    RevertingPruneOrchestratorMock internal revertingPruneOrchestrator;
    StaticOracleAdapterMock internal staticOracleAdapter;
    RevertingOracleAdapterMock internal revertingOracleAdapter;
    RateManagerMock internal rateManagerMock;

    address internal other;
    address internal intentGuardian;
    address internal dustRecipient;

    uint256 internal depositId;
    uint256 internal intentCounter;

    function _setUpLegacyFixture() internal {
        owner = makeAddr("owner");
        depositor = makeAddr("depositor");
        delegate = makeAddr("delegate");
        other = makeAddr("other");
        intentGuardian = makeAddr("intentGuardian");
        dustRecipient = makeAddr("dustRecipient");
        unauthorizedCaller = makeAddr("unauthorizedCaller");
        feeRecipient = makeAddr("feeRecipient");
        intentCounter = 0;

        vm.startPrank(owner);
        usdc = new USDCMock(1_000_000_000e6, "USDC", "USDC");
        paymentVerifierRegistry = new PaymentVerifierRegistry();
        orchestratorRegistry = new OrchestratorRegistry();

        verifier = new PaymentVerifierMock();
        otherVerifier = new PaymentVerifierMock();
        staticOracleAdapter = new StaticOracleAdapterMock();
        revertingOracleAdapter = new RevertingOracleAdapterMock();
        rateManagerMock = new RateManagerMock();

        paymentVerifierRegistry.addPaymentMethod(VENMO, address(verifier), _pairCurrencyCodes(USD, EUR));
        paymentVerifierRegistry.addPaymentMethod(PAYPAL, address(otherVerifier), _pairCurrencyCodes(USD, EUR));

        escrow = new EscrowV2(
            owner,
            CHAIN_ID,
            address(orchestratorRegistry),
            address(paymentVerifierRegistry),
            dustRecipient,
            0,
            3,
            1 hours
        );

        orchestratorMock = new OrchestratorMock(address(escrow));
        secondaryOrchestratorMock = new OrchestratorMock(address(escrow));
        revertingPruneOrchestrator = new RevertingPruneOrchestratorMock(address(escrow));

        orchestratorRegistry.addOrchestrator(address(orchestratorMock));
        orchestratorRegistry.addOrchestrator(address(secondaryOrchestratorMock));
        orchestratorRegistry.addOrchestrator(address(revertingPruneOrchestrator));
        vm.stopPrank();

        vm.prank(owner);
        usdc.transfer(depositor, 100_000e6);
        vm.prank(owner);
        usdc.transfer(other, 10_000e6);

        vm.prank(depositor);
        usdc.approve(address(escrow), type(uint256).max);
        vm.prank(other);
        usdc.approve(address(escrow), type(uint256).max);

        depositId = _createDefaultDeposit();
    }

    function _createDefaultDeposit() internal returns (uint256 createdDepositId) {
        IEscrowV2.CreateDepositParams memory params = IEscrowV2.CreateDepositParams({
            token: IERC20(address(usdc)),
            amount: 500e6,
            intentAmountRange: IEscrowV2.Range({ min: 10e6, max: 200e6 }),
            paymentMethods: _singlePaymentMethods(VENMO),
            paymentMethodData: _singlePaymentMethodData(address(0), PAYEE_DETAILS, ""),
            currencies: _singleDepositCurrencies(USD, 1e18),
            delegate: delegate,
            intentGuardian: intentGuardian,
            retainOnEmpty: false
        });

        vm.prank(depositor);
        escrow.createDeposit(params);
        createdDepositId = escrow.depositCounter() - 1;
    }

    function _pairCurrencyCodes(bytes32 first, bytes32 second) internal pure returns (bytes32[] memory codes) {
        codes = new bytes32[](2);
        codes[0] = first;
        codes[1] = second;
    }

    function _currencyList(bytes32 code, uint256 minConversionRate)
        internal
        pure
        returns (IEscrowV2.Currency[] memory currencies)
    {
        currencies = new IEscrowV2.Currency[](1);
        currencies[0] = IEscrowV2.Currency({
            code: code,
            minConversionRate: minConversionRate,
            oracleRateConfig: _emptyOracleRateConfig()
        });
    }

    function _currencyListWithConfig(
        bytes32 code,
        uint256 minConversionRate,
        IEscrowV2.OracleRateConfig memory config
    ) internal pure returns (IEscrowV2.Currency[] memory currencies) {
        currencies = new IEscrowV2.Currency[](1);
        currencies[0] = IEscrowV2.Currency({ code: code, minConversionRate: minConversionRate, oracleRateConfig: config });
    }

    function _emptyOracleRateConfig() internal pure returns (IEscrowV2.OracleRateConfig memory config) {
        config = IEscrowV2.OracleRateConfig({
            adapter: address(0),
            adapterConfig: "",
            spreadBps: 0,
            maxStaleness: 0
        });
    }

    function _oracleRateConfig(
        address adapter,
        bytes memory adapterConfig,
        int16 spreadBps,
        uint32 maxStaleness
    ) internal pure returns (IEscrowV2.OracleRateConfig memory config) {
        config = IEscrowV2.OracleRateConfig({
            adapter: adapter,
            adapterConfig: adapterConfig,
            spreadBps: spreadBps,
            maxStaleness: maxStaleness
        });
    }

    function _buildOracleAdapterConfig(bool isValid, uint256 marketRate, uint256 updatedAt)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(isValid, marketRate, updatedAt);
    }

    function _advanceTime(uint256 secondsForward) internal {
        vm.warp(block.timestamp + secondsForward);
        vm.roll(block.number + 1);
    }

    function _createIntentWith(address orchestratorAddress, uint256 amount) internal returns (bytes32 intentHash) {
        unchecked {
            ++intentCounter;
        }

        intentHash = keccak256(abi.encodePacked("intent-", intentCounter));
        ILockingOrchestrator(orchestratorAddress).lockFunds(depositId, intentHash, amount);
    }

    function _getIntentOrchestrator(bytes32 intentHash) internal view returns (address) {
        bytes32 storageSlot = keccak256(abi.encode(intentHash, INTENT_ORCHESTRATOR_SLOT));
        return address(uint160(uint256(vm.load(address(escrow), storageSlot))));
    }

    function _clearIntentOrchestrator(bytes32 intentHash) internal {
        bytes32 storageSlot = keccak256(abi.encode(intentHash, INTENT_ORCHESTRATOR_SLOT));
        vm.store(address(escrow), storageSlot, bytes32(0));
    }

    function _countLogs(Vm.Log[] memory entries, bytes32 topic0) internal view returns (uint256 count) {
        for (uint256 i = 0; i < entries.length; ++i) {
            if (entries[i].emitter == address(escrow) && entries[i].topics.length > 0 && entries[i].topics[0] == topic0) {
                unchecked {
                    ++count;
                }
            }
        }
    }

    function _assertSingleBytes32ArrayValue(bytes32[] memory values, bytes32 expected) internal pure {
        assertEq(values.length, 1);
        assertEq(values[0], expected);
    }
}

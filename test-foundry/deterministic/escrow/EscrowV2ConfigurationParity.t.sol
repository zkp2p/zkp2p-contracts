// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {EscrowV2LegacyFixture} from "../helpers/EscrowV2LegacyFixture.sol";
import {OrchestratorRegistry} from "contracts/registries/OrchestratorRegistry.sol";
import {PaymentVerifierRegistry} from "contracts/registries/PaymentVerifierRegistry.sol";
import {IEscrowV2} from "contracts/interfaces/IEscrowV2.sol";

contract EscrowV2ConfigurationParityTest is EscrowV2LegacyFixture {
    event DepositMinConversionRateUpdated(
        uint256 indexed depositId, bytes32 indexed paymentMethod, bytes32 indexed currency, uint256 newRate
    );
    event DepositOracleRateConfigSet(
        uint256 indexed depositId,
        bytes32 indexed paymentMethod,
        bytes32 indexed currency,
        address adapter,
        bytes adapterConfig,
        int16 spreadBps,
        uint32 maxStaleness
    );
    event DepositOracleRateConfigRemoved(
        uint256 indexed depositId, bytes32 indexed paymentMethod, bytes32 indexed currency
    );
    event DepositRateManagerSet(uint256 indexed depositId, address indexed rateManager, bytes32 indexed managerId);
    event DepositRateManagerCleared(uint256 indexed depositId, address indexed rateManager, bytes32 indexed managerId);
    event OrchestratorRegistryUpdated(address indexed registry);
    event PaymentVerifierRegistryUpdated(address indexed registry);
    event DustRecipientUpdated(address indexed recipient);
    event DustThresholdUpdated(uint256 threshold);
    event MaxIntentsPerDepositUpdated(uint256 maximum);
    event IntentExpirationPeriodUpdated(uint256 period);

    function _addEur() internal {
        IEscrowV2.Currency[] memory currencies = new IEscrowV2.Currency[](1);
        currencies[0] = IEscrowV2.Currency({code: EUR, minConversionRate: 0.9e18, oracleRateConfig: _emptyOracle()});
        vm.prank(depositor);
        escrow.addCurrencies(0, VENMO, currencies);
    }

    function test_SetCurrencyMinRateUpdatesFixedFloorAndEmits() public {
        uint256 newFloor = 1.15e18;
        vm.expectEmit(true, true, true, true, address(escrow));
        emit DepositMinConversionRateUpdated(0, VENMO, USD, newFloor);
        vm.prank(depositor);
        escrow.setCurrencyMinRate(0, VENMO, USD, newFloor);
        assertEq(escrow.getDepositCurrencyMinRate(0, VENMO, USD), newFloor);
    }

    function test_SetOracleRateConfigComputesSpreadFloor() public {
        vm.prank(depositor);
        escrow.setCurrencyMinRate(0, VENMO, USD, 0);
        uint256 marketRate = 1.2e18;
        IEscrowV2.OracleRateConfig memory config =
            _oracleConfig(address(adapter), true, marketRate, block.timestamp, 100);
        vm.expectEmit(true, true, true, true, address(escrow));
        emit DepositOracleRateConfigSet(
            0, VENMO, USD, address(adapter), config.adapterConfig, config.spreadBps, config.maxStaleness
        );
        vm.prank(depositor);
        escrow.setOracleRateConfig(0, VENMO, USD, config);
        assertEq(escrow.getDepositCurrencyMinRate(0, VENMO, USD), (marketRate * 10_100 + 9_999) / 10_000);
        assertEq(escrow.getDepositOracleRateConfig(0, VENMO, USD).adapter, address(adapter));
    }

    function test_SetOracleRateConfigBatchUpdatesEveryTuple() public {
        _addEur();
        bytes32[] memory methods = new bytes32[](1);
        methods[0] = VENMO;
        bytes32[][] memory currencies = new bytes32[][](1);
        currencies[0] = new bytes32[](2);
        currencies[0][0] = USD;
        currencies[0][1] = EUR;
        IEscrowV2.OracleRateConfig[][] memory configs = new IEscrowV2.OracleRateConfig[][](1);
        configs[0] = new IEscrowV2.OracleRateConfig[](2);
        configs[0][0] = _oracleConfig(address(adapter), true, 1.1e18, block.timestamp, 50);
        configs[0][1] = _oracleConfig(address(adapter), true, 1e18, block.timestamp, 25);
        vm.prank(depositor);
        escrow.setOracleRateConfigBatch(0, methods, currencies, configs);
        assertEq(escrow.getDepositOracleRateConfig(0, VENMO, USD).spreadBps, 50);
        assertEq(escrow.getDepositOracleRateConfig(0, VENMO, EUR).spreadBps, 25);
    }

    function test_SetOracleRateConfigBatchRejectsOuterArrayMismatch() public {
        bytes32[] memory methods = new bytes32[](1);
        methods[0] = VENMO;
        bytes32[][] memory currencies = new bytes32[][](0);
        IEscrowV2.OracleRateConfig[][] memory configs = new IEscrowV2.OracleRateConfig[][](0);
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.ArrayLengthMismatch.selector, 1, 0));
        vm.prank(depositor);
        escrow.setOracleRateConfigBatch(0, methods, currencies, configs);
    }

    function test_RemoveOracleConfigAndDeactivateCurrencyCleanUpOracleAndFloor() public {
        IEscrowV2.OracleRateConfig memory config = _oracleConfig(address(adapter), true, 1.2e18, block.timestamp, 0);
        vm.prank(depositor);
        escrow.setOracleRateConfig(0, VENMO, USD, config);
        vm.expectEmit(true, true, true, false, address(escrow));
        emit DepositOracleRateConfigRemoved(0, VENMO, USD);
        vm.prank(depositor);
        escrow.removeOracleRateConfig(0, VENMO, USD);
        assertEq(escrow.getDepositOracleRateConfig(0, VENMO, USD).adapter, address(0));

        vm.prank(depositor);
        escrow.setOracleRateConfig(0, VENMO, USD, config);
        vm.expectEmit(true, true, true, false, address(escrow));
        emit DepositOracleRateConfigRemoved(0, VENMO, USD);
        vm.expectEmit(true, true, true, true, address(escrow));
        emit DepositMinConversionRateUpdated(0, VENMO, USD, 0);
        vm.prank(depositor);
        escrow.deactivateCurrency(0, VENMO, USD);
        assertEq(escrow.getDepositCurrencyMinRate(0, VENMO, USD), 0);
        assertEq(escrow.getDepositOracleRateConfig(0, VENMO, USD).adapter, address(0));
    }

    function test_RateManagerProvidesRateAndFeeWithSafeFallbacks() public {
        rateManagerMock.setManager(MANAGER_ID, true);
        rateManagerMock.setRate(MANAGER_ID, address(escrow), 0, VENMO, USD, 1.22e18);
        rateManagerMock.setFee(MANAGER_ID, dustRecipient, 0.01e18);
        vm.expectEmit(true, true, true, false, address(escrow));
        emit DepositRateManagerSet(0, address(rateManagerMock), MANAGER_ID);
        vm.prank(depositor);
        escrow.setRateManager(0, address(rateManagerMock), MANAGER_ID);
        (address configuredManager, bytes32 configuredId) = escrow.getDepositRateManager(0);
        assertEq(configuredManager, address(rateManagerMock));
        assertEq(configuredId, MANAGER_ID);
        assertEq(escrow.getEffectiveRate(0, VENMO, USD), 1.22e18);
        (address feeRecipient, uint256 fee) = escrow.getManagerFee(0);
        assertEq(feeRecipient, dustRecipient);
        assertEq(fee, 0.01e18);

        rateManagerMock.setShouldRevertOnGetRate(true);
        rateManagerMock.setShouldRevertOnGetFee(true);
        assertEq(escrow.getEffectiveRate(0, VENMO, USD), 1e18);
        (feeRecipient, fee) = escrow.getManagerFee(0);
        assertEq(feeRecipient, address(0));
        assertEq(fee, 0);
    }

    function test_ClearRateManagerRemovesDelegationAndEmits() public {
        rateManagerMock.setManager(MANAGER_ID, true);
        vm.prank(depositor);
        escrow.setRateManager(0, address(rateManagerMock), MANAGER_ID);
        vm.expectEmit(true, true, true, false, address(escrow));
        emit DepositRateManagerCleared(0, address(rateManagerMock), MANAGER_ID);
        vm.prank(depositor);
        escrow.clearRateManager(0);
        (address configuredManager, bytes32 configuredId) = escrow.getDepositRateManager(0);
        assertEq(configuredManager, address(0));
        assertEq(configuredId, bytes32(0));
    }

    function test_OracleAdapterRevertHaltsRateAtZero() public {
        IEscrowV2.OracleRateConfig memory config =
            _oracleConfig(address(revertingAdapter), true, 1.2e18, block.timestamp, 100);
        vm.prank(depositor);
        escrow.setOracleRateConfig(0, VENMO, USD, config);
        assertEq(escrow.getDepositCurrencyMinRate(0, VENMO, USD), 0);
    }

    function test_InvalidOracleQuoteHaltsRateAtZero() public {
        IEscrowV2.OracleRateConfig memory config = _oracleConfig(address(adapter), false, 1.2e18, block.timestamp, 100);
        vm.prank(depositor);
        escrow.setOracleRateConfig(0, VENMO, USD, config);
        assertEq(escrow.getDepositCurrencyMinRate(0, VENMO, USD), 0);
    }

    function test_FutureOracleTimestampHaltsRateAtZero() public {
        IEscrowV2.OracleRateConfig memory config =
            _oracleConfig(address(adapter), true, 1.2e18, block.timestamp + 120, 100);
        vm.prank(depositor);
        escrow.setOracleRateConfig(0, VENMO, USD, config);
        assertEq(escrow.getDepositCurrencyMinRate(0, VENMO, USD), 0);
    }

    function test_StaleOracleTimestampHaltsRateAtZero() public {
        vm.warp(1_000);
        IEscrowV2.OracleRateConfig memory config = _oracleConfig(address(adapter), true, 1.2e18, 800, 100);
        config.maxStaleness = 30;
        vm.prank(depositor);
        escrow.setOracleRateConfig(0, VENMO, USD, config);
        assertEq(escrow.getDepositCurrencyMinRate(0, VENMO, USD), 0);
    }

    function test_GovernanceUpdatesEveryOwnerControlledFieldAndPauseState() public {
        OrchestratorRegistry newOrchestratorRegistry = new OrchestratorRegistry();
        PaymentVerifierRegistry newPaymentVerifierRegistry = new PaymentVerifierRegistry();
        vm.expectEmit(true, false, false, false, address(escrow));
        emit OrchestratorRegistryUpdated(address(newOrchestratorRegistry));
        escrow.setOrchestratorRegistry(address(newOrchestratorRegistry));
        vm.expectEmit(true, false, false, false, address(escrow));
        emit PaymentVerifierRegistryUpdated(address(newPaymentVerifierRegistry));
        escrow.setPaymentVerifierRegistry(address(newPaymentVerifierRegistry));
        vm.expectEmit(true, false, false, false, address(escrow));
        emit DustRecipientUpdated(other);
        escrow.setDustRecipient(other);
        vm.expectEmit(false, false, false, true, address(escrow));
        emit DustThresholdUpdated(1e6);
        escrow.setDustThreshold(1e6);
        vm.expectEmit(false, false, false, true, address(escrow));
        emit MaxIntentsPerDepositUpdated(10);
        escrow.setMaxIntentsPerDeposit(10);
        vm.expectEmit(false, false, false, true, address(escrow));
        emit IntentExpirationPeriodUpdated(7200);
        escrow.setIntentExpirationPeriod(7200);

        assertEq(address(escrow.orchestratorRegistry()), address(newOrchestratorRegistry));
        assertEq(address(escrow.paymentVerifierRegistry()), address(newPaymentVerifierRegistry));
        assertEq(escrow.dustRecipient(), other);
        assertEq(escrow.dustThreshold(), 1e6);
        assertEq(escrow.maxIntentsPerDeposit(), 10);
        assertEq(escrow.intentExpirationPeriod(), 7200);
        escrow.pauseEscrow();
        assertTrue(escrow.paused());
        escrow.unpauseEscrow();
        assertFalse(escrow.paused());
    }

    function test_ViewGettersReturnAllStoredDepositAndIntentValues() public {
        bytes32 intentHash = _lock(address(orchestratorMock), 20e6);
        bytes32[] memory intentHashes = escrow.getDepositIntentHashes(0);
        assertEq(intentHashes.length, 1);
        assertEq(intentHashes[0], intentHash);
        assertEq(escrow.getDepositIntent(0, intentHash).intentHash, intentHash);
        bytes32[] memory methods = escrow.getDepositPaymentMethods(0);
        assertEq(methods.length, 1);
        assertEq(methods[0], VENMO);
        bytes32[] memory currencies = escrow.getDepositCurrencies(0, VENMO);
        assertEq(currencies.length, 1);
        assertEq(currencies[0], USD);
        assertTrue(escrow.getDepositCurrencyListed(0, VENMO, USD));
        assertTrue(escrow.getDepositPaymentMethodListed(0, VENMO));
        assertEq(escrow.getDepositPaymentMethodData(0, VENMO).payeeDetails, PAYEE);
        assertTrue(escrow.getDepositPaymentMethodActive(0, VENMO));
        assertEq(escrow.getDepositGatingService(0, VENMO), address(0));
        vm.warp(block.timestamp + 3601);
        (bytes32[] memory expired, uint256 reclaimable) = escrow.getExpiredIntents(0);
        assertEq(expired.length, 1);
        assertEq(expired[0], intentHash);
        assertEq(reclaimable, 20e6);
    }
}

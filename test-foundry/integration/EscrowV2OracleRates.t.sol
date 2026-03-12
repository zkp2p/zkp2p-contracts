// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Vm } from "forge-std/Vm.sol";

import { IEscrowV2 } from "../../contracts/interfaces/IEscrowV2.sol";
import { RevertingOracleAdapterMock } from "../../contracts/mocks/RevertingOracleAdapterMock.sol";
import { StaticOracleAdapterMock } from "../../contracts/mocks/StaticOracleAdapterMock.sol";
import { ProtocolV2TestBase } from "../helpers/ProtocolV2TestBase.sol";

contract EscrowV2OracleRatesTest is ProtocolV2TestBase {
    bytes32 internal constant EUR = keccak256("EUR");
    bytes32 internal constant JPY = bytes32("JPY");
    bytes32 internal constant DEPOSIT_ORACLE_RATE_CONFIG_SET_TOPIC =
        keccak256(
            "DepositOracleRateConfigSet(uint256,bytes32,bytes32,address,bytes,int16,uint32)"
        );
    bytes32 internal constant DEPOSIT_ORACLE_RATE_CONFIG_REMOVED_TOPIC =
        keccak256("DepositOracleRateConfigRemoved(uint256,bytes32,bytes32)");

    event DepositMinConversionRateUpdated(
        uint256 indexed depositId,
        bytes32 indexed paymentMethod,
        bytes32 indexed currency,
        uint256 newMinConversionRate
    );
    event DepositOracleRateConfigSet(
        uint256 indexed depositId,
        bytes32 indexed paymentMethod,
        bytes32 indexed currencyCode,
        address adapter,
        bytes adapterConfig,
        int16 spreadBps,
        uint32 maxStaleness
    );
    event DepositOracleRateConfigRemoved(
        uint256 indexed depositId,
        bytes32 indexed paymentMethod,
        bytes32 indexed currencyCode
    );

    StaticOracleAdapterMock internal staticOracleAdapter;
    RevertingOracleAdapterMock internal revertingOracleAdapter;

    function setUp() public {
        _setUpV2Core();

        staticOracleAdapter = new StaticOracleAdapterMock();
        revertingOracleAdapter = new RevertingOracleAdapterMock();

        bytes32[] memory extraCurrencies = new bytes32[](1);
        extraCurrencies[0] = EUR;

        vm.prank(owner);
        paymentVerifierRegistry.addCurrencies(VENMO, extraCurrencies);

        _createDefaultDeposit();
    }

    function test_createDepositWithInlineOracleRateConfigStoresConfigAndEmitsEvent() public {
        vm.warp(1_000);
        bytes memory adapterConfig = _encodeStaticAdapterConfig(true, 1.05e18, block.timestamp);

        vm.recordLogs();
        uint256 depositId = _createDepositWithInlineOracleRateConfig(
            200e6,
            1e18,
            _oracleRateConfig(address(staticOracleAdapter), adapterConfig, 50, 3600)
        );

        Vm.Log[] memory entries = vm.getRecordedLogs();

        assertEq(depositId, 1);
        assertEq(_countLogs(entries, DEPOSIT_ORACLE_RATE_CONFIG_SET_TOPIC), 1);

        IEscrowV2.OracleRateConfig memory storedConfig = escrow.getDepositOracleRateConfig(depositId, VENMO, USD);
        assertEq(storedConfig.adapter, address(staticOracleAdapter));
        assertEq(storedConfig.adapterConfig, adapterConfig);
        assertEq(storedConfig.spreadBps, 50);
        assertEq(storedConfig.maxStaleness, 3600);
        assertEq(escrow.getDepositCurrencyMinRate(depositId, VENMO, USD), _applySpread(1.05e18, 50));
    }

    function test_createDepositWithInlineOracleRateConfigAllowsZeroFixedFloor() public {
        vm.warp(1_000);
        bytes memory adapterConfig = _encodeStaticAdapterConfig(true, 1.05e18, block.timestamp);

        uint256 depositId = _createDepositWithInlineOracleRateConfig(
            200e6,
            0,
            _oracleRateConfig(address(staticOracleAdapter), adapterConfig, 50, 3600)
        );

        assertEq(escrow.getDepositCurrencyMinRate(depositId, VENMO, USD), _applySpread(1.05e18, 50));
    }

    function test_createDepositWithInlineOracleRateConfigSkipsStorageWhenAdapterIsZero() public {
        vm.recordLogs();
        uint256 depositId = _createDepositWithInlineOracleRateConfig(200e6, 1e18, _emptyOracleRateConfig());

        Vm.Log[] memory entries = vm.getRecordedLogs();
        IEscrowV2.OracleRateConfig memory storedConfig = escrow.getDepositOracleRateConfig(depositId, VENMO, USD);

        assertEq(_countLogs(entries, DEPOSIT_ORACLE_RATE_CONFIG_SET_TOPIC), 0);
        assertEq(storedConfig.adapter, address(0));
    }

    function test_setOracleRateConfigSetsSpreadFloorAndEmitsEvent() public {
        vm.warp(1_000);
        bytes memory adapterConfig = _encodeStaticAdapterConfig(true, 1e18, block.timestamp);

        vm.expectEmit(true, true, true, true);
        emit DepositOracleRateConfigSet(0, VENMO, USD, address(staticOracleAdapter), adapterConfig, 50, 3600);

        vm.prank(depositor);
        escrow.setOracleRateConfig(
            0,
            VENMO,
            USD,
            _oracleRateConfig(address(staticOracleAdapter), adapterConfig, 50, 3600)
        );

        assertEq(escrow.getDepositCurrencyMinRate(0, VENMO, USD), _applySpread(1e18, 50));
    }

    function test_setOracleRateConfigSupportsNegativeSpreadsBelowMarket() public {
        vm.warp(1_000);
        bytes memory adapterConfig = _encodeStaticAdapterConfig(true, 1e18, block.timestamp);

        vm.prank(depositor);
        escrow.setOracleRateConfig(
            0,
            VENMO,
            USD,
            _oracleRateConfig(address(staticOracleAdapter), adapterConfig, -250, 3600)
        );

        vm.prank(depositor);
        escrow.setCurrencyMinRate(0, VENMO, USD, 0);

        assertEq(escrow.getDepositCurrencyMinRate(0, VENMO, USD), _applySpread(1e18, -250));
    }

    function test_setOracleRateConfigAllowsPositiveSpreadsAboveTenThousandBps() public {
        vm.warp(1_000);
        bytes memory adapterConfig = _encodeStaticAdapterConfig(true, 1e18, block.timestamp);

        vm.prank(depositor);
        escrow.setOracleRateConfig(
            0,
            VENMO,
            USD,
            _oracleRateConfig(address(staticOracleAdapter), adapterConfig, 32_767, 3600)
        );

        vm.prank(depositor);
        escrow.setCurrencyMinRate(0, VENMO, USD, 0);

        assertEq(escrow.getDepositCurrencyMinRate(0, VENMO, USD), _applySpread(1e18, 32_767));
    }

    function test_setOracleRateConfigReturnsMaxOfFixedAndSpreadRate() public {
        vm.warp(1_000);
        bytes memory adapterConfig = _encodeStaticAdapterConfig(true, 1e18, block.timestamp);

        vm.prank(depositor);
        escrow.setCurrencyMinRate(0, VENMO, USD, 1.02e18);
        vm.prank(depositor);
        escrow.setOracleRateConfig(
            0,
            VENMO,
            USD,
            _oracleRateConfig(address(staticOracleAdapter), adapterConfig, 50, 3600)
        );

        assertEq(escrow.getDepositCurrencyMinRate(0, VENMO, USD), 1.02e18);
    }

    function test_setOracleRateConfigReturnsZeroWhenOracleIsStale() public {
        vm.warp(10_000);
        bytes memory adapterConfig = _encodeStaticAdapterConfig(true, 1e18, block.timestamp - 10_000);

        vm.prank(depositor);
        escrow.setOracleRateConfig(
            0,
            VENMO,
            USD,
            _oracleRateConfig(address(staticOracleAdapter), adapterConfig, 50, 10)
        );

        assertEq(escrow.getDepositCurrencyMinRate(0, VENMO, USD), 0);
    }

    function test_setOracleRateConfigReturnsZeroWhenOracleQuoteIsInvalid() public {
        vm.warp(1_000);
        bytes memory adapterConfig = _encodeStaticAdapterConfig(true, 0, block.timestamp);

        vm.prank(depositor);
        escrow.setOracleRateConfig(
            0,
            VENMO,
            USD,
            _oracleRateConfig(address(staticOracleAdapter), adapterConfig, 50, 3600)
        );

        assertEq(escrow.getDepositCurrencyMinRate(0, VENMO, USD), 0);
    }

    function test_setOracleRateConfigReturnsZeroWhenOracleTimestampIsInFuture() public {
        vm.warp(1_000);
        bytes memory adapterConfig = _encodeStaticAdapterConfig(true, 1e18, block.timestamp + 300);

        vm.prank(depositor);
        escrow.setOracleRateConfig(
            0,
            VENMO,
            USD,
            _oracleRateConfig(address(staticOracleAdapter), adapterConfig, 50, 3600)
        );

        assertEq(escrow.getDepositCurrencyMinRate(0, VENMO, USD), 0);
    }

    function test_setOracleRateConfigReturnsZeroWhenOracleAdapterReverts() public {
        vm.warp(1_000);
        bytes memory adapterConfig = _encodeStaticAdapterConfig(true, 1e18, block.timestamp);

        vm.prank(depositor);
        escrow.setOracleRateConfig(
            0,
            VENMO,
            USD,
            _oracleRateConfig(address(revertingOracleAdapter), adapterConfig, 50, 3600)
        );

        assertEq(escrow.getDepositCurrencyMinRate(0, VENMO, USD), 0);
    }

    function test_setOracleRateConfigAllowsDelegateToSetConfig() public {
        vm.warp(1_000);
        bytes memory adapterConfig = _encodeStaticAdapterConfig(true, 1e18, block.timestamp);

        vm.expectEmit(true, true, true, true);
        emit DepositOracleRateConfigSet(0, VENMO, USD, address(staticOracleAdapter), adapterConfig, 50, 3600);

        vm.prank(delegate);
        escrow.setOracleRateConfig(
            0,
            VENMO,
            USD,
            _oracleRateConfig(address(staticOracleAdapter), adapterConfig, 50, 3600)
        );
    }

    function test_setOracleRateConfigRevertsForUnauthorizedCaller() public {
        vm.warp(1_000);
        bytes memory adapterConfig = _encodeStaticAdapterConfig(true, 1e18, block.timestamp);

        vm.prank(unauthorizedCaller);
        vm.expectRevert(
            abi.encodeWithSelector(
                IEscrowV2.UnauthorizedCallerOrDelegate.selector,
                unauthorizedCaller,
                depositor,
                delegate
            )
        );
        escrow.setOracleRateConfig(
            0,
            VENMO,
            USD,
            _oracleRateConfig(address(staticOracleAdapter), adapterConfig, 50, 3600)
        );
    }

    function test_setOracleRateConfigRevertsWhenNormalizedAdapterConfigIsTooLong() public {
        bytes memory oversizedConfig = new bytes(257);

        vm.prank(depositor);
        vm.expectRevert(
            abi.encodeWithSelector(IEscrowV2.AdapterConfigTooLong.selector, uint256(257), uint256(256))
        );
        escrow.setOracleRateConfig(
            0,
            VENMO,
            USD,
            _oracleRateConfig(address(staticOracleAdapter), oversizedConfig, 50, 3600)
        );
    }

    function test_setOracleRateConfigRevertsWhenSpreadIsAtOrBelowNegativeTenThousandBps() public {
        vm.warp(1_000);
        bytes memory adapterConfig = _encodeStaticAdapterConfig(true, 1e18, block.timestamp);

        vm.prank(depositor);
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.InvalidSpread.selector, int16(-10_000)));
        escrow.setOracleRateConfig(
            0,
            VENMO,
            USD,
            _oracleRateConfig(address(staticOracleAdapter), adapterConfig, -10_000, 3600)
        );
    }

    function test_removeOracleRateConfigFallsBackToFixedRate() public {
        vm.warp(1_000);
        bytes memory adapterConfig = _encodeStaticAdapterConfig(true, 1.2e18, block.timestamp);
        _setOracleRateConfigAs(depositor, USD, address(staticOracleAdapter), adapterConfig, 0, 3600);

        assertEq(escrow.getDepositCurrencyMinRate(0, VENMO, USD), 1.2e18);

        vm.expectEmit(true, true, true, true);
        emit DepositOracleRateConfigRemoved(0, VENMO, USD);

        vm.prank(depositor);
        escrow.removeOracleRateConfig(0, VENMO, USD);

        assertEq(escrow.getDepositCurrencyMinRate(0, VENMO, USD), 1e18);
    }

    function test_removeOracleRateConfigRevertsWhenTupleIsNotListed() public {
        vm.prank(depositor);
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.CurrencyNotSupported.selector, VENMO, JPY));
        escrow.removeOracleRateConfig(0, VENMO, JPY);
    }

    function test_setOracleRateConfigBatchSetsMultipleConfigsInOneCall() public {
        vm.warp(1_000);

        bytes32[] memory paymentMethods = _singlePaymentMethods(VENMO);
        bytes32[][] memory currencyCodes = new bytes32[][](1);
        currencyCodes[0] = new bytes32[](2);
        currencyCodes[0][0] = USD;
        currencyCodes[0][1] = EUR;

        IEscrowV2.OracleRateConfig[][] memory configs = new IEscrowV2.OracleRateConfig[][](1);
        configs[0] = new IEscrowV2.OracleRateConfig[](2);
        configs[0][0] = _oracleRateConfig(
            address(staticOracleAdapter),
            _encodeStaticAdapterConfig(true, 1e18, block.timestamp),
            100,
            3600
        );
        configs[0][1] = _oracleRateConfig(
            address(staticOracleAdapter),
            _encodeStaticAdapterConfig(true, 1.2e18, block.timestamp),
            50,
            3600
        );

        vm.prank(depositor);
        escrow.setOracleRateConfigBatch(0, paymentMethods, currencyCodes, configs);

        assertEq(escrow.getDepositCurrencyMinRate(0, VENMO, USD), _applySpread(1e18, 100));
        assertEq(escrow.getDepositCurrencyMinRate(0, VENMO, EUR), _applySpread(1.2e18, 50));
    }

    function test_setOracleRateConfigBatchRevertsWhenPaymentMethodsAndCurrencyCodesLengthMismatch() public {
        bytes32[] memory paymentMethods = _singlePaymentMethods(VENMO);
        bytes32[][] memory currencyCodes = new bytes32[][](0);
        IEscrowV2.OracleRateConfig[][] memory configs = new IEscrowV2.OracleRateConfig[][](1);
        configs[0] = new IEscrowV2.OracleRateConfig[](1);
        configs[0][0] = _oracleRateConfig(address(staticOracleAdapter), hex"", 100, 3600);

        vm.prank(depositor);
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.ArrayLengthMismatch.selector, uint256(1), uint256(0)));
        escrow.setOracleRateConfigBatch(0, paymentMethods, currencyCodes, configs);
    }

    function test_setOracleRateConfigBatchRevertsWhenPaymentMethodsAndConfigsLengthMismatch() public {
        bytes32[] memory paymentMethods = _singlePaymentMethods(VENMO);
        bytes32[][] memory currencyCodes = new bytes32[][](1);
        currencyCodes[0] = _singleCurrencyCodes(USD);
        IEscrowV2.OracleRateConfig[][] memory configs = new IEscrowV2.OracleRateConfig[][](0);

        vm.prank(depositor);
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.ArrayLengthMismatch.selector, uint256(1), uint256(0)));
        escrow.setOracleRateConfigBatch(0, paymentMethods, currencyCodes, configs);
    }

    function test_setOracleRateConfigBatchRevertsWhenNestedLengthsMismatch() public {
        bytes32[] memory paymentMethods = _singlePaymentMethods(VENMO);
        bytes32[][] memory currencyCodes = new bytes32[][](1);
        currencyCodes[0] = new bytes32[](2);
        currencyCodes[0][0] = USD;
        currencyCodes[0][1] = EUR;

        IEscrowV2.OracleRateConfig[][] memory configs = new IEscrowV2.OracleRateConfig[][](1);
        configs[0] = new IEscrowV2.OracleRateConfig[](1);
        configs[0][0] = _oracleRateConfig(address(staticOracleAdapter), hex"", 100, 3600);

        vm.prank(depositor);
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.ArrayLengthMismatch.selector, uint256(2), uint256(1)));
        escrow.setOracleRateConfigBatch(0, paymentMethods, currencyCodes, configs);
    }

    function test_updateCurrencyConfigBatchUpdatesFixedFloorsAndOracleConfig() public {
        vm.warp(1_000);

        bytes32[] memory paymentMethods = _singlePaymentMethods(VENMO);
        IEscrowV2.CurrencyRateUpdate[][] memory updates = new IEscrowV2.CurrencyRateUpdate[][](1);
        updates[0] = new IEscrowV2.CurrencyRateUpdate[](2);
        updates[0][0] = IEscrowV2.CurrencyRateUpdate({
            code: USD,
            minConversionRate: 1.01e18,
            updateOracle: true,
            oracleRateConfig: _oracleRateConfig(
                address(staticOracleAdapter),
                _encodeStaticAdapterConfig(true, 1.04e18, block.timestamp),
                50,
                3600
            )
        });
        updates[0][1] = IEscrowV2.CurrencyRateUpdate({
            code: EUR,
            minConversionRate: 0.97e18,
            updateOracle: false,
            oracleRateConfig: _emptyOracleRateConfig()
        });

        vm.expectEmit(true, true, true, true);
        emit DepositMinConversionRateUpdated(0, VENMO, USD, 1.01e18);
        vm.expectEmit(true, true, true, true);
        emit DepositOracleRateConfigSet(
            0,
            VENMO,
            USD,
            address(staticOracleAdapter),
            _encodeStaticAdapterConfig(true, 1.04e18, block.timestamp),
            50,
            3600
        );
        vm.expectEmit(true, true, true, true);
        emit DepositMinConversionRateUpdated(0, VENMO, EUR, 0.97e18);

        vm.prank(depositor);
        escrow.updateCurrencyConfigBatch(0, paymentMethods, updates);

        assertEq(escrow.getDepositCurrencyMinRate(0, VENMO, USD), _applySpread(1.04e18, 50));
        assertEq(escrow.getDepositCurrencyMinRate(0, VENMO, EUR), 0.97e18);
    }

    function test_updateCurrencyConfigBatchRemovesOracleConfigWhenAdapterIsZero() public {
        vm.warp(1_000);
        bytes memory adapterConfig = _encodeStaticAdapterConfig(true, 1.2e18, block.timestamp);
        _setOracleRateConfigAs(depositor, USD, address(staticOracleAdapter), adapterConfig, 0, 3600);

        bytes32[] memory paymentMethods = _singlePaymentMethods(VENMO);
        IEscrowV2.CurrencyRateUpdate[][] memory updates = new IEscrowV2.CurrencyRateUpdate[][](1);
        updates[0] = new IEscrowV2.CurrencyRateUpdate[](1);
        updates[0][0] = IEscrowV2.CurrencyRateUpdate({
            code: USD,
            minConversionRate: 1.15e18,
            updateOracle: true,
            oracleRateConfig: _emptyOracleRateConfig()
        });

        vm.expectEmit(true, true, true, true);
        emit DepositMinConversionRateUpdated(0, VENMO, USD, 1.15e18);
        vm.expectEmit(true, true, true, true);
        emit DepositOracleRateConfigRemoved(0, VENMO, USD);

        vm.prank(depositor);
        escrow.updateCurrencyConfigBatch(0, paymentMethods, updates);

        IEscrowV2.OracleRateConfig memory storedConfig = escrow.getDepositOracleRateConfig(0, VENMO, USD);
        assertEq(escrow.getDepositCurrencyMinRate(0, VENMO, USD), 1.15e18);
        assertEq(storedConfig.adapter, address(0));
    }

    function test_updateCurrencyConfigBatchDoesNotEmitOracleRemovalWhenNoConfigExists() public {
        bytes32[] memory paymentMethods = _singlePaymentMethods(VENMO);
        IEscrowV2.CurrencyRateUpdate[][] memory updates = new IEscrowV2.CurrencyRateUpdate[][](1);
        updates[0] = new IEscrowV2.CurrencyRateUpdate[](1);
        updates[0][0] = IEscrowV2.CurrencyRateUpdate({
            code: EUR,
            minConversionRate: 0.95e18,
            updateOracle: true,
            oracleRateConfig: _emptyOracleRateConfig()
        });

        vm.recordLogs();
        vm.prank(depositor);
        escrow.updateCurrencyConfigBatch(0, paymentMethods, updates);

        Vm.Log[] memory entries = vm.getRecordedLogs();
        IEscrowV2.OracleRateConfig memory storedConfig = escrow.getDepositOracleRateConfig(0, VENMO, EUR);

        assertEq(_countLogs(entries, DEPOSIT_ORACLE_RATE_CONFIG_REMOVED_TOPIC), 0);
        assertEq(escrow.getDepositCurrencyMinRate(0, VENMO, EUR), 0.95e18);
        assertEq(storedConfig.adapter, address(0));
    }

    function test_updateCurrencyConfigBatchRevertsWhenPaymentMethodsAndUpdatesLengthMismatch() public {
        bytes32[] memory paymentMethods = _singlePaymentMethods(VENMO);
        IEscrowV2.CurrencyRateUpdate[][] memory updates = new IEscrowV2.CurrencyRateUpdate[][](0);

        vm.prank(depositor);
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.ArrayLengthMismatch.selector, uint256(1), uint256(0)));
        escrow.updateCurrencyConfigBatch(0, paymentMethods, updates);
    }

    function test_deactivateCurrenciesBatchDeactivatesCurrenciesAndRemovesOracleConfigWhenPresent() public {
        vm.warp(1_000);
        bytes memory adapterConfig = _encodeStaticAdapterConfig(true, 1.2e18, block.timestamp);
        _setOracleRateConfigAs(depositor, USD, address(staticOracleAdapter), adapterConfig, 0, 3600);

        bytes32[] memory paymentMethods = _singlePaymentMethods(VENMO);
        bytes32[][] memory currencyCodes = new bytes32[][](1);
        currencyCodes[0] = new bytes32[](2);
        currencyCodes[0][0] = USD;
        currencyCodes[0][1] = EUR;

        vm.recordLogs();
        vm.prank(depositor);
        escrow.deactivateCurrenciesBatch(0, paymentMethods, currencyCodes);

        Vm.Log[] memory entries = vm.getRecordedLogs();
        IEscrowV2.OracleRateConfig memory storedConfig = escrow.getDepositOracleRateConfig(0, VENMO, USD);

        assertEq(_countLogs(entries, DEPOSIT_ORACLE_RATE_CONFIG_REMOVED_TOPIC), 1);
        assertTrue(_hasRemovedOracleConfig(entries, 0, VENMO, USD));
        assertEq(escrow.getDepositCurrencyMinRate(0, VENMO, USD), 0);
        assertEq(escrow.getDepositCurrencyMinRate(0, VENMO, EUR), 0);
        assertEq(storedConfig.adapter, address(0));
    }

    function test_deactivateCurrenciesBatchRevertsWhenPaymentMethodIsNotActive() public {
        vm.prank(depositor);
        escrow.setPaymentMethodActive(0, VENMO, false);

        bytes32[] memory paymentMethods = _singlePaymentMethods(VENMO);
        bytes32[][] memory currencyCodes = new bytes32[][](1);
        currencyCodes[0] = _singleCurrencyCodes(USD);

        vm.prank(depositor);
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.PaymentMethodNotActive.selector, uint256(0), VENMO));
        escrow.deactivateCurrenciesBatch(0, paymentMethods, currencyCodes);
    }

    function test_deactivateCurrenciesBatchRevertsWhenPaymentMethodsAndCurrencyCodesLengthMismatch() public {
        bytes32[] memory paymentMethods = _singlePaymentMethods(VENMO);
        bytes32[][] memory currencyCodes = new bytes32[][](0);

        vm.prank(depositor);
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.ArrayLengthMismatch.selector, uint256(1), uint256(0)));
        escrow.deactivateCurrenciesBatch(0, paymentMethods, currencyCodes);
    }

    function test_setOracleRateConfigRevertsWhenCurrencyIsNotListedForPaymentMethod() public {
        vm.warp(1_000);
        bytes memory adapterConfig = _encodeStaticAdapterConfig(true, 1e18, block.timestamp);

        vm.prank(depositor);
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.CurrencyNotSupported.selector, VENMO, JPY));
        escrow.setOracleRateConfig(
            0,
            VENMO,
            JPY,
            _oracleRateConfig(address(staticOracleAdapter), adapterConfig, 50, 3600)
        );
    }

    function _createDefaultDeposit() internal returns (uint256 depositId) {
        IEscrowV2.Currency[] memory currencies = new IEscrowV2.Currency[](2);
        currencies[0] = IEscrowV2.Currency({
            code: USD,
            minConversionRate: 1e18,
            oracleRateConfig: _emptyOracleRateConfig()
        });
        currencies[1] = IEscrowV2.Currency({
            code: EUR,
            minConversionRate: 1e18,
            oracleRateConfig: _emptyOracleRateConfig()
        });

        IEscrowV2.Currency[][] memory currenciesByMethod = new IEscrowV2.Currency[][](1);
        currenciesByMethod[0] = currencies;

        IEscrowV2.CreateDepositParams memory params = IEscrowV2.CreateDepositParams({
            token: IERC20(address(usdc)),
            amount: 500e6,
            intentAmountRange: IEscrowV2.Range({ min: 10e6, max: 200e6 }),
            paymentMethods: _singlePaymentMethods(VENMO),
            paymentMethodData: _singlePaymentMethodData(address(0), keccak256("payee"), ""),
            currencies: currenciesByMethod,
            delegate: delegate,
            intentGuardian: address(0),
            retainOnEmpty: false
        });

        vm.prank(depositor);
        escrow.createDeposit(params);
        depositId = escrow.depositCounter() - 1;
    }

    function _createDepositWithInlineOracleRateConfig(
        uint256 amount,
        uint256 minConversionRate,
        IEscrowV2.OracleRateConfig memory oracleRateConfig
    ) internal returns (uint256 depositId) {
        IEscrowV2.Currency[] memory currencies = new IEscrowV2.Currency[](1);
        currencies[0] = IEscrowV2.Currency({
            code: USD,
            minConversionRate: minConversionRate,
            oracleRateConfig: oracleRateConfig
        });

        IEscrowV2.Currency[][] memory currenciesByMethod = new IEscrowV2.Currency[][](1);
        currenciesByMethod[0] = currencies;

        IEscrowV2.CreateDepositParams memory params = IEscrowV2.CreateDepositParams({
            token: IERC20(address(usdc)),
            amount: amount,
            intentAmountRange: IEscrowV2.Range({ min: 10e6, max: 200e6 }),
            paymentMethods: _singlePaymentMethods(VENMO),
            paymentMethodData: _singlePaymentMethodData(address(0), keccak256("payee"), ""),
            currencies: currenciesByMethod,
            delegate: address(0),
            intentGuardian: address(0),
            retainOnEmpty: false
        });

        vm.prank(depositor);
        escrow.createDeposit(params);
        depositId = escrow.depositCounter() - 1;
    }

    function _setOracleRateConfigAs(
        address caller,
        bytes32 currencyCode,
        address adapter,
        bytes memory adapterConfig,
        int16 spreadBps,
        uint32 maxStaleness
    ) internal {
        vm.prank(caller);
        escrow.setOracleRateConfig(
            0,
            VENMO,
            currencyCode,
            _oracleRateConfig(adapter, adapterConfig, spreadBps, maxStaleness)
        );
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

    function _emptyOracleRateConfig() internal pure returns (IEscrowV2.OracleRateConfig memory config) {
        config = IEscrowV2.OracleRateConfig({
            adapter: address(0),
            adapterConfig: "",
            spreadBps: 0,
            maxStaleness: 0
        });
    }

    function _encodeStaticAdapterConfig(
        bool validQuote,
        uint256 rate,
        uint256 updatedAt
    ) internal pure returns (bytes memory) {
        return abi.encode(validQuote, rate, updatedAt);
    }

    function _applySpread(uint256 rate, int16 spreadBps) internal pure returns (uint256) {
        return (rate * uint256(int256(uint256(10_000)) + spreadBps) + 9_999) / 10_000;
    }

    function _countLogs(Vm.Log[] memory entries, bytes32 topic0) internal pure returns (uint256 count) {
        for (uint256 i = 0; i < entries.length; i++) {
            if (entries[i].topics.length != 0 && entries[i].topics[0] == topic0) {
                count++;
            }
        }
    }

    function _hasRemovedOracleConfig(
        Vm.Log[] memory entries,
        uint256 depositId,
        bytes32 paymentMethod,
        bytes32 currencyCode
    ) internal pure returns (bool) {
        for (uint256 i = 0; i < entries.length; i++) {
            if (
                entries[i].topics.length == 4 &&
                entries[i].topics[0] == DEPOSIT_ORACLE_RATE_CONFIG_REMOVED_TOPIC &&
                entries[i].topics[1] == bytes32(depositId) &&
                entries[i].topics[2] == paymentMethod &&
                entries[i].topics[3] == currencyCode
            ) {
                return true;
            }
        }

        return false;
    }
}

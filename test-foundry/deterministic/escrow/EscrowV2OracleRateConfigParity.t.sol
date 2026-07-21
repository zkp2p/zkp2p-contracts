// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {EscrowV2} from "contracts/EscrowV2.sol";
import {PaymentVerifierMock} from "contracts/mocks/PaymentVerifierMock.sol";
import {RevertingOracleAdapterMock} from "contracts/mocks/RevertingOracleAdapterMock.sol";
import {StaticOracleAdapterMock} from "contracts/mocks/StaticOracleAdapterMock.sol";
import {USDCMock} from "contracts/mocks/USDCMock.sol";
import {OrchestratorRegistry} from "contracts/registries/OrchestratorRegistry.sol";
import {PaymentVerifierRegistry} from "contracts/registries/PaymentVerifierRegistry.sol";
import {IEscrowV2} from "contracts/interfaces/IEscrowV2.sol";

contract EscrowV2OracleRateConfigParityTest is Test {
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
        uint256 indexed depositId, bytes32 indexed paymentMethod, bytes32 indexed currencyCode
    );
    event DepositMinConversionRateUpdated(
        uint256 indexed depositId, bytes32 indexed paymentMethod, bytes32 indexed currency, uint256 rate
    );

    bytes32 internal constant METHOD = keccak256("venmo");
    bytes32 internal constant USD = keccak256("USD");
    bytes32 internal constant EUR = keccak256("EUR");
    bytes32 internal constant JPY = bytes32("JPY");
    bytes32 internal constant PAYEE = keccak256("payee");
    bytes32 internal constant ORACLE_REMOVED_TOPIC =
        keccak256("DepositOracleRateConfigRemoved(uint256,bytes32,bytes32)");

    address internal depositor;
    address internal delegate;
    address internal other;
    EscrowV2 internal escrow;
    StaticOracleAdapterMock internal adapter;
    RevertingOracleAdapterMock internal revertingAdapter;
    USDCMock internal token;

    function setUp() public {
        depositor = makeAddr("depositor");
        delegate = makeAddr("delegate");
        other = makeAddr("other");
        token = new USDCMock(1_000_000_000e6, "USDC", "USDC");
        token.transfer(depositor, 100_000e6);
        PaymentVerifierRegistry paymentVerifierRegistry = new PaymentVerifierRegistry();
        OrchestratorRegistry orchestratorRegistry = new OrchestratorRegistry();
        PaymentVerifierMock verifier = new PaymentVerifierMock();
        adapter = new StaticOracleAdapterMock();
        revertingAdapter = new RevertingOracleAdapterMock();
        bytes32[] memory currencies = new bytes32[](2);
        currencies[0] = USD;
        currencies[1] = EUR;
        paymentVerifierRegistry.addPaymentMethod(METHOD, address(verifier), currencies);
        escrow = new EscrowV2(
            address(this),
            1,
            address(orchestratorRegistry),
            address(paymentVerifierRegistry),
            address(this),
            0,
            20,
            1 hours
        );
        vm.startPrank(depositor);
        token.approve(address(escrow), 100_000e6);
        _createBaseDeposit();
        vm.stopPrank();
    }

    function _emptyOracle() internal pure returns (IEscrowV2.OracleRateConfig memory) {
        return IEscrowV2.OracleRateConfig({adapter: address(0), adapterConfig: "", spreadBps: 0, maxStaleness: 0});
    }

    function _config(address configAdapter, uint256 rate, uint256 updatedAt, int16 spread, uint32 staleness)
        internal
        pure
        returns (IEscrowV2.OracleRateConfig memory)
    {
        return IEscrowV2.OracleRateConfig({
            adapter: configAdapter,
            adapterConfig: abi.encode(true, rate, updatedAt),
            spreadBps: spread,
            maxStaleness: staleness
        });
    }

    function _createBaseDeposit() internal {
        bytes32[] memory methods = new bytes32[](1);
        methods[0] = METHOD;
        IEscrowV2.DepositPaymentMethodData[] memory methodData = new IEscrowV2.DepositPaymentMethodData[](1);
        methodData[0] =
            IEscrowV2.DepositPaymentMethodData({intentGatingService: address(0), payeeDetails: PAYEE, data: ""});
        IEscrowV2.Currency[][] memory currencies = new IEscrowV2.Currency[][](1);
        currencies[0] = new IEscrowV2.Currency[](2);
        currencies[0][0] = IEscrowV2.Currency({code: USD, minConversionRate: 1e18, oracleRateConfig: _emptyOracle()});
        currencies[0][1] = IEscrowV2.Currency({code: EUR, minConversionRate: 1e18, oracleRateConfig: _emptyOracle()});
        escrow.createDeposit(
            IEscrowV2.CreateDepositParams({
                token: IERC20(address(token)),
                amount: 500e6,
                intentAmountRange: IEscrowV2.Range({min: 10e6, max: 200e6}),
                paymentMethods: methods,
                paymentMethodData: methodData,
                currencies: currencies,
                delegate: delegate,
                intentGuardian: address(0),
                retainOnEmpty: false
            })
        );
    }

    function _createInline(uint256 fixedFloor, IEscrowV2.OracleRateConfig memory oracle) internal {
        bytes32[] memory methods = new bytes32[](1);
        methods[0] = METHOD;
        IEscrowV2.DepositPaymentMethodData[] memory methodData = new IEscrowV2.DepositPaymentMethodData[](1);
        methodData[0] =
            IEscrowV2.DepositPaymentMethodData({intentGatingService: address(0), payeeDetails: PAYEE, data: ""});
        IEscrowV2.Currency[][] memory currencies = new IEscrowV2.Currency[][](1);
        currencies[0] = new IEscrowV2.Currency[](1);
        currencies[0][0] = IEscrowV2.Currency({code: USD, minConversionRate: fixedFloor, oracleRateConfig: oracle});
        vm.prank(depositor);
        escrow.createDeposit(
            IEscrowV2.CreateDepositParams({
                token: IERC20(address(token)),
                amount: 200e6,
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

    function _set(address caller, bytes32 currency, IEscrowV2.OracleRateConfig memory config) internal {
        vm.prank(caller);
        escrow.setOracleRateConfig(0, METHOD, currency, config);
    }

    function _spread(uint256 rate, uint256 multiplier) internal pure returns (uint256) {
        return (rate * multiplier + 9_999) / 10_000;
    }

    function _containsTopic(Vm.Log[] memory logs, bytes32 topic) internal pure returns (uint256 count) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics.length > 0 && logs[i].topics[0] == topic) ++count;
        }
    }

    function test_CreateDepositStoresInlineOracleConfigAndEmits() public {
        IEscrowV2.OracleRateConfig memory config = _config(address(adapter), 1.05e18, block.timestamp, 50, 3600);
        vm.expectEmit(true, true, true, true, address(escrow));
        emit DepositOracleRateConfigSet(1, METHOD, USD, address(adapter), config.adapterConfig, 50, 3600);
        _createInline(1e18, config);
        IEscrowV2.OracleRateConfig memory stored = escrow.getDepositOracleRateConfig(1, METHOD, USD);
        assertEq(stored.adapter, address(adapter));
        assertEq(stored.spreadBps, 50);
        assertEq(stored.maxStaleness, 3600);
        assertEq(escrow.getDepositCurrencyMinRate(1, METHOD, USD), _spread(1.05e18, 10_050));
    }

    function test_CreateDepositAllowsZeroFixedFloorWithInlineOracle() public {
        _createInline(0, _config(address(adapter), 1.05e18, block.timestamp, 50, 3600));
        assertEq(escrow.getDepositCurrencyMinRate(1, METHOD, USD), _spread(1.05e18, 10_050));
    }

    function test_CreateDepositSkipsEmptyInlineOracleConfig() public {
        vm.recordLogs();
        _createInline(1e18, _emptyOracle());
        assertEq(
            _containsTopic(
                vm.getRecordedLogs(),
                keccak256("DepositOracleRateConfigSet(uint256,bytes32,bytes32,address,bytes,int16,uint32)")
            ),
            0
        );
        assertEq(escrow.getDepositOracleRateConfig(1, METHOD, USD).adapter, address(0));
    }

    function test_SetOracleConfigComputesPositiveSpreadFloor() public {
        _set(depositor, USD, _config(address(adapter), 1e18, block.timestamp, 50, 3600));
        assertEq(escrow.getDepositCurrencyMinRate(0, METHOD, USD), _spread(1e18, 10_050));
    }

    function test_SetOracleConfigSupportsNegativeSpread() public {
        _set(depositor, USD, _config(address(adapter), 1e18, block.timestamp, -250, 3600));
        vm.prank(depositor);
        escrow.setCurrencyMinRate(0, METHOD, USD, 0);
        assertEq(escrow.getDepositCurrencyMinRate(0, METHOD, USD), _spread(1e18, 9_750));
    }

    function test_SetOracleConfigAllowsInt16MaximumPositiveSpread() public {
        _set(depositor, USD, _config(address(adapter), 1e18, block.timestamp, 32_767, 3600));
        vm.prank(depositor);
        escrow.setCurrencyMinRate(0, METHOD, USD, 0);
        assertEq(escrow.getDepositCurrencyMinRate(0, METHOD, USD), _spread(1e18, 42_767));
    }

    function test_EffectiveRateReturnsMaximumOfFixedAndSpread() public {
        vm.prank(depositor);
        escrow.setCurrencyMinRate(0, METHOD, USD, 1.02e18);
        _set(depositor, USD, _config(address(adapter), 1e18, block.timestamp, 50, 3600));
        assertEq(escrow.getDepositCurrencyMinRate(0, METHOD, USD), 1.02e18);
    }

    function test_StaleOracleHaltsRateAtZero() public {
        vm.warp(10_000);
        _set(depositor, USD, _config(address(adapter), 1e18, block.timestamp - 100, 0, 10));
        assertEq(escrow.getDepositCurrencyMinRate(0, METHOD, USD), 0);
    }

    function test_InvalidZeroOracleQuoteHaltsRateAtZero() public {
        _set(depositor, USD, _config(address(adapter), 0, block.timestamp, 0, 3600));
        assertEq(escrow.getDepositCurrencyMinRate(0, METHOD, USD), 0);
    }

    function test_FutureOracleTimestampHaltsRateAtZero() public {
        _set(depositor, USD, _config(address(adapter), 1e18, block.timestamp + 300, 0, 3600));
        assertEq(escrow.getDepositCurrencyMinRate(0, METHOD, USD), 0);
    }

    function test_RevertingOracleAdapterHaltsRateAtZero() public {
        _set(depositor, USD, _config(address(revertingAdapter), 1e18, block.timestamp, 0, 3600));
        assertEq(escrow.getDepositCurrencyMinRate(0, METHOD, USD), 0);
    }

    function test_DelegateCanSetOracleConfig() public {
        _set(delegate, USD, _config(address(adapter), 1e18, block.timestamp, 50, 3600));
        assertEq(escrow.getDepositOracleRateConfig(0, METHOD, USD).adapter, address(adapter));
    }

    function test_UnauthorizedCallerCannotSetOracleConfig() public {
        vm.expectRevert(
            abi.encodeWithSelector(IEscrowV2.UnauthorizedCallerOrDelegate.selector, other, depositor, delegate)
        );
        _set(other, USD, _config(address(adapter), 1e18, block.timestamp, 50, 3600));
    }

    function test_NormalizedAdapterConfigAbove256BytesIsRejected() public {
        IEscrowV2.OracleRateConfig memory config = IEscrowV2.OracleRateConfig({
            adapter: address(adapter), adapterConfig: new bytes(257), spreadBps: 50, maxStaleness: 3600
        });
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.AdapterConfigTooLong.selector, 257, 256));
        _set(depositor, USD, config);
    }

    function test_SpreadAtNegativeTenThousandIsRejected() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.InvalidSpread.selector, int16(-10_000)));
        _set(depositor, USD, _config(address(adapter), 1e18, block.timestamp, -10_000, 3600));
    }

    function test_RemoveOracleConfigFallsBackToFixedRateAndEmits() public {
        _set(depositor, USD, _config(address(adapter), 1.2e18, block.timestamp, 0, 3600));
        vm.expectEmit(true, true, true, false, address(escrow));
        emit DepositOracleRateConfigRemoved(0, METHOD, USD);
        vm.prank(depositor);
        escrow.removeOracleRateConfig(0, METHOD, USD);
        assertEq(escrow.getDepositCurrencyMinRate(0, METHOD, USD), 1e18);
    }

    function test_RemoveOracleConfigRejectsUnlistedTuple() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.CurrencyNotSupported.selector, METHOD, JPY));
        vm.prank(depositor);
        escrow.removeOracleRateConfig(0, METHOD, JPY);
    }

    function _batchInputs()
        internal
        view
        returns (bytes32[] memory methods, bytes32[][] memory currencies, IEscrowV2.OracleRateConfig[][] memory configs)
    {
        methods = new bytes32[](1);
        methods[0] = METHOD;
        currencies = new bytes32[][](1);
        currencies[0] = new bytes32[](2);
        currencies[0][0] = USD;
        currencies[0][1] = EUR;
        configs = new IEscrowV2.OracleRateConfig[][](1);
        configs[0] = new IEscrowV2.OracleRateConfig[](2);
        configs[0][0] = _config(address(adapter), 1e18, block.timestamp, 100, 3600);
        configs[0][1] = _config(address(adapter), 1.2e18, block.timestamp, 50, 3600);
    }

    function test_SetOracleConfigBatchSetsMultipleConfigs() public {
        (bytes32[] memory methods, bytes32[][] memory currencies, IEscrowV2.OracleRateConfig[][] memory configs) =
            _batchInputs();
        vm.prank(depositor);
        escrow.setOracleRateConfigBatch(0, methods, currencies, configs);
        assertEq(escrow.getDepositCurrencyMinRate(0, METHOD, USD), _spread(1e18, 10_100));
        assertEq(escrow.getDepositCurrencyMinRate(0, METHOD, EUR), _spread(1.2e18, 10_050));
    }

    function test_SetOracleConfigBatchRejectsMethodCurrencyLengthMismatch() public {
        (bytes32[] memory methods,, IEscrowV2.OracleRateConfig[][] memory configs) = _batchInputs();
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.ArrayLengthMismatch.selector, 1, 0));
        vm.prank(depositor);
        escrow.setOracleRateConfigBatch(0, methods, new bytes32[][](0), configs);
    }

    function test_SetOracleConfigBatchRejectsMethodConfigLengthMismatch() public {
        (bytes32[] memory methods, bytes32[][] memory currencies,) = _batchInputs();
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.ArrayLengthMismatch.selector, 1, 0));
        vm.prank(depositor);
        escrow.setOracleRateConfigBatch(0, methods, currencies, new IEscrowV2.OracleRateConfig[][](0));
    }

    function test_SetOracleConfigBatchRejectsNestedLengthMismatch() public {
        (bytes32[] memory methods, bytes32[][] memory currencies, IEscrowV2.OracleRateConfig[][] memory configs) =
            _batchInputs();
        configs[0] = new IEscrowV2.OracleRateConfig[](1);
        configs[0][0] = _config(address(adapter), 1e18, block.timestamp, 100, 3600);
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.ArrayLengthMismatch.selector, 2, 1));
        vm.prank(depositor);
        escrow.setOracleRateConfigBatch(0, methods, currencies, configs);
    }

    function _updates(IEscrowV2.CurrencyRateUpdate[] memory inner)
        internal
        pure
        returns (bytes32[] memory methods, IEscrowV2.CurrencyRateUpdate[][] memory updates)
    {
        methods = new bytes32[](1);
        methods[0] = METHOD;
        updates = new IEscrowV2.CurrencyRateUpdate[][](1);
        updates[0] = inner;
    }

    function test_UpdateCurrencyBatchUpdatesFloorsAndOptionalOracle() public {
        IEscrowV2.CurrencyRateUpdate[] memory inner = new IEscrowV2.CurrencyRateUpdate[](2);
        inner[0] = IEscrowV2.CurrencyRateUpdate({
            code: USD,
            minConversionRate: 1.01e18,
            updateOracle: true,
            oracleRateConfig: _config(address(adapter), 1.04e18, block.timestamp, 50, 3600)
        });
        inner[1] = IEscrowV2.CurrencyRateUpdate({
            code: EUR, minConversionRate: 0.97e18, updateOracle: false, oracleRateConfig: _emptyOracle()
        });
        (bytes32[] memory methods, IEscrowV2.CurrencyRateUpdate[][] memory updates) = _updates(inner);
        vm.prank(depositor);
        escrow.updateCurrencyConfigBatch(0, methods, updates);
        assertEq(escrow.getDepositCurrencyMinRate(0, METHOD, USD), _spread(1.04e18, 10_050));
        assertEq(escrow.getDepositCurrencyMinRate(0, METHOD, EUR), 0.97e18);
    }

    function test_UpdateCurrencyBatchRemovesExistingOracleWhenRequested() public {
        _set(depositor, USD, _config(address(adapter), 1.2e18, block.timestamp, 0, 3600));
        IEscrowV2.CurrencyRateUpdate[] memory inner = new IEscrowV2.CurrencyRateUpdate[](1);
        inner[0] = IEscrowV2.CurrencyRateUpdate({
            code: USD, minConversionRate: 1.15e18, updateOracle: true, oracleRateConfig: _emptyOracle()
        });
        (bytes32[] memory methods, IEscrowV2.CurrencyRateUpdate[][] memory updates) = _updates(inner);
        vm.prank(depositor);
        escrow.updateCurrencyConfigBatch(0, methods, updates);
        assertEq(escrow.getDepositCurrencyMinRate(0, METHOD, USD), 1.15e18);
        assertEq(escrow.getDepositOracleRateConfig(0, METHOD, USD).adapter, address(0));
    }

    function test_UpdateCurrencyBatchDoesNotEmitRemovalForAbsentOracle() public {
        IEscrowV2.CurrencyRateUpdate[] memory inner = new IEscrowV2.CurrencyRateUpdate[](1);
        inner[0] = IEscrowV2.CurrencyRateUpdate({
            code: EUR, minConversionRate: 0.95e18, updateOracle: true, oracleRateConfig: _emptyOracle()
        });
        (bytes32[] memory methods, IEscrowV2.CurrencyRateUpdate[][] memory updates) = _updates(inner);
        vm.recordLogs();
        vm.prank(depositor);
        escrow.updateCurrencyConfigBatch(0, methods, updates);
        assertEq(_containsTopic(vm.getRecordedLogs(), ORACLE_REMOVED_TOPIC), 0);
        assertEq(escrow.getDepositCurrencyMinRate(0, METHOD, EUR), 0.95e18);
    }

    function test_UpdateCurrencyBatchRejectsOuterLengthMismatch() public {
        bytes32[] memory methods = new bytes32[](1);
        methods[0] = METHOD;
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.ArrayLengthMismatch.selector, 1, 0));
        vm.prank(depositor);
        escrow.updateCurrencyConfigBatch(0, methods, new IEscrowV2.CurrencyRateUpdate[][](0));
    }

    function _currencyBatch(bytes32 first, bytes32 second)
        internal
        pure
        returns (bytes32[] memory methods, bytes32[][] memory currencies)
    {
        methods = new bytes32[](1);
        methods[0] = METHOD;
        currencies = new bytes32[][](1);
        currencies[0] = new bytes32[](2);
        currencies[0][0] = first;
        currencies[0][1] = second;
    }

    function test_DeactivateCurrenciesBatchClearsRatesAndOnlyExistingOracle() public {
        _set(depositor, USD, _config(address(adapter), 1.2e18, block.timestamp, 0, 3600));
        (bytes32[] memory methods, bytes32[][] memory currencies) = _currencyBatch(USD, EUR);
        vm.recordLogs();
        vm.prank(depositor);
        escrow.deactivateCurrenciesBatch(0, methods, currencies);
        assertEq(_containsTopic(vm.getRecordedLogs(), ORACLE_REMOVED_TOPIC), 1);
        assertEq(escrow.getDepositCurrencyMinRate(0, METHOD, USD), 0);
        assertEq(escrow.getDepositCurrencyMinRate(0, METHOD, EUR), 0);
        assertEq(escrow.getDepositOracleRateConfig(0, METHOD, USD).adapter, address(0));
    }

    function test_DeactivateCurrenciesBatchRejectsInactivePaymentMethod() public {
        vm.prank(depositor);
        escrow.setPaymentMethodActive(0, METHOD, false);
        bytes32[] memory methods = new bytes32[](1);
        methods[0] = METHOD;
        bytes32[][] memory currencies = new bytes32[][](1);
        currencies[0] = new bytes32[](1);
        currencies[0][0] = USD;
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.PaymentMethodNotActive.selector, 0, METHOD));
        vm.prank(depositor);
        escrow.deactivateCurrenciesBatch(0, methods, currencies);
    }

    function test_DeactivateCurrenciesBatchRejectsOuterLengthMismatch() public {
        bytes32[] memory methods = new bytes32[](1);
        methods[0] = METHOD;
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.ArrayLengthMismatch.selector, 1, 0));
        vm.prank(depositor);
        escrow.deactivateCurrenciesBatch(0, methods, new bytes32[][](0));
    }

    function test_SetOracleConfigRejectsUnlistedCurrency() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.CurrencyNotSupported.selector, METHOD, JPY));
        _set(depositor, JPY, _config(address(adapter), 1e18, block.timestamp, 50, 3600));
    }
}

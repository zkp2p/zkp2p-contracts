// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Vm } from "forge-std/Vm.sol";

import { IEscrowV2 } from "../../contracts/interfaces/IEscrowV2.sol";
import { OrchestratorRegistry } from "../../contracts/registries/OrchestratorRegistry.sol";
import { PaymentVerifierRegistry } from "../../contracts/registries/PaymentVerifierRegistry.sol";
import { EscrowV2LegacyCoverageBase } from "./EscrowV2LegacyCoverageBase.sol";

contract EscrowV2LegacyStateManagementTest is EscrowV2LegacyCoverageBase {
    bytes32 internal constant DEPOSIT_ORACLE_RATE_CONFIG_SET_TOPIC =
        keccak256("DepositOracleRateConfigSet(uint256,bytes32,bytes32,address,bytes,int16,uint32)");

    function setUp() public {
        _setUpLegacyFixture();
    }

    function test_createDepositRevertsWhenMinIsGreaterThanMax() public {
        IEscrowV2.CreateDepositParams memory params = _defaultCreateDepositParams();
        params.intentAmountRange = IEscrowV2.Range({ min: 100e6, max: 10e6 });

        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.InvalidRange.selector, 100e6, 10e6));
        vm.prank(depositor);
        escrow.createDeposit(params);
    }

    function test_createDepositRevertsWhenAmountIsBelowMin() public {
        IEscrowV2.CreateDepositParams memory params = _defaultCreateDepositParams();
        params.amount = 10e6;
        params.intentAmountRange = IEscrowV2.Range({ min: 20e6, max: 100e6 });

        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.AmountBelowMin.selector, 10e6, 20e6));
        vm.prank(depositor);
        escrow.createDeposit(params);
    }

    function test_createDepositAllowsCurrencyMinConversionRateZero() public {
        IEscrowV2.CreateDepositParams memory params = _defaultCreateDepositParams();
        params.currencies = _singleDepositCurrencies(USD, 0);

        vm.expectEmit(true, true, true, true, address(escrow));
        emit DepositCurrencyAdded(1, VENMO, USD, 0);

        vm.prank(depositor);
        escrow.createDeposit(params);

        assertEq(escrow.getDepositCurrencyMinRate(1, VENMO, USD), 0);
    }

    function test_depositToCreatesDepositForSpecifiedOwnerWhilePullingFromCaller() public {
        IEscrowV2.Range memory range = IEscrowV2.Range({ min: 10e6, max: 100e6 });
        IEscrowV2.CreateDepositParams memory params = _defaultCreateDepositParams();
        params.amount = 30e6;
        params.intentAmountRange = range;

        uint256 callerBalanceBefore = usdc.balanceOf(other);
        uint256 ownerBalanceBefore = usdc.balanceOf(depositor);
        uint256 escrowBalanceBefore = usdc.balanceOf(address(escrow));

        vm.expectEmit(true, true, true, true, address(escrow));
        emit DepositReceived(1, depositor, IERC20(address(usdc)), 30e6, range, delegate, intentGuardian);

        vm.prank(other);
        escrow.depositTo(depositor, params);

        IEscrowV2.Deposit memory createdDeposit = escrow.getDeposit(1);
        assertEq(createdDeposit.depositor, depositor);
        assertEq(createdDeposit.remainingDeposits, 30e6);
        assertEq(callerBalanceBefore - usdc.balanceOf(other), 30e6);
        assertEq(usdc.balanceOf(depositor), ownerBalanceBefore);
        assertEq(usdc.balanceOf(address(escrow)) - escrowBalanceBefore, 30e6);
    }

    function test_addFundsAddsFundsAndEmitsEvent() public {
        IEscrowV2.Deposit memory beforeDeposit = escrow.getDeposit(depositId);

        vm.expectEmit(true, true, false, true, address(escrow));
        emit DepositFundsAdded(depositId, other, 25e6);

        vm.prank(other);
        escrow.addFunds(depositId, 25e6);

        IEscrowV2.Deposit memory afterDeposit = escrow.getDeposit(depositId);
        assertEq(afterDeposit.remainingDeposits - beforeDeposit.remainingDeposits, 25e6);
    }

    function test_addFundsDoesNotChangeAcceptingIntents() public {
        vm.prank(depositor);
        escrow.setAcceptingIntents(depositId, false);

        vm.recordLogs();
        vm.prank(depositor);
        escrow.addFunds(depositId, 10e6);

        Vm.Log[] memory entries = vm.getRecordedLogs();
        IEscrowV2.Deposit memory updatedDeposit = escrow.getDeposit(depositId);

        assertEq(_countLogs(entries, DEPOSIT_ACCEPTING_INTENTS_UPDATED_TOPIC), 0);
        assertEq(updatedDeposit.remainingDeposits, 510e6);
        assertFalse(updatedDeposit.acceptingIntents);
    }

    function test_addFundsRevertsWhenDepositDoesNotExist() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.DepositNotFound.selector, 999));
        vm.prank(other);
        escrow.addFunds(999, 25e6);
    }

    function test_addFundsRevertsWhenAmountIsZero() public {
        vm.expectRevert(IEscrowV2.ZeroValue.selector);
        vm.prank(other);
        escrow.addFunds(depositId, 0);
    }

    function test_removeFundsRemovesFundsAndEmitsEvent() public {
        IEscrowV2.Deposit memory beforeDeposit = escrow.getDeposit(depositId);

        vm.expectEmit(true, true, false, true, address(escrow));
        emit DepositWithdrawn(depositId, depositor, 40e6);

        vm.prank(depositor);
        escrow.removeFunds(depositId, 40e6);

        IEscrowV2.Deposit memory afterDeposit = escrow.getDeposit(depositId);
        assertEq(beforeDeposit.remainingDeposits - afterDeposit.remainingDeposits, 40e6);
    }

    function test_removeFundsReclaimsExpiredIntentLiquidityAndPrunes() public {
        bytes32 intentHash = _createIntentWith(address(orchestratorMock), 20e6);
        _advanceTime(3601);

        vm.prank(depositor);
        escrow.removeFunds(depositId, 490e6);

        bytes32[] memory pruned = orchestratorMock.getLastPrunedIntents();
        _assertSingleBytes32ArrayValue(pruned, intentHash);
    }

    function test_removeFundsDoesNotAutoDisableAcceptingIntentsWhenRemainingFallsBelowMin() public {
        vm.recordLogs();
        vm.prank(depositor);
        escrow.removeFunds(depositId, 495e6);

        Vm.Log[] memory entries = vm.getRecordedLogs();
        IEscrowV2.Deposit memory deposit = escrow.getDeposit(depositId);

        assertEq(_countLogs(entries, DEPOSIT_ACCEPTING_INTENTS_UPDATED_TOPIC), 0);
        assertEq(deposit.remainingDeposits, 5e6);
        assertTrue(deposit.acceptingIntents);
    }

    function test_removeFundsRevertsWhenRequestedRemovalExceedsAvailableLiquidity() public {
        _createIntentWith(address(orchestratorMock), 20e6);

        vm.expectRevert(
            abi.encodeWithSelector(IEscrowV2.InsufficientDepositLiquidity.selector, depositId, 480e6, 490e6)
        );
        vm.prank(depositor);
        escrow.removeFunds(depositId, 490e6);
    }

    function test_removeFundsRevertsWhenCallerIsNotDepositor() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.UnauthorizedCaller.selector, other, depositor));
        vm.prank(other);
        escrow.removeFunds(depositId, 40e6);
    }

    function test_withdrawDepositPrunesExpiredIntentsAndClosesDeposit() public {
        _createIntentWith(address(orchestratorMock), 20e6);
        _advanceTime(3601);

        vm.expectEmit(false, false, false, true, address(escrow));
        emit DepositClosed(depositId, depositor);

        vm.prank(depositor);
        escrow.withdrawDeposit(depositId);

        IEscrowV2.Deposit memory deposit = escrow.getDeposit(depositId);
        bytes32[] memory paymentMethods = escrow.getDepositPaymentMethods(depositId);

        assertEq(deposit.depositor, address(0));
        assertEq(paymentMethods.length, 0);
    }

    function test_withdrawDepositEmitsAcceptingIntentUpdateWhenTransitioningFromAccepting() public {
        _createIntentWith(address(orchestratorMock), 20e6);

        vm.expectEmit(true, false, false, true, address(escrow));
        emit DepositAcceptingIntentsUpdated(depositId, false);

        vm.prank(depositor);
        escrow.withdrawDeposit(depositId);
    }

    function test_withdrawDepositDoesNotEmitAcceptingIntentUpdateWhenAlreadyDisabled() public {
        vm.prank(depositor);
        escrow.setAcceptingIntents(depositId, false);

        vm.recordLogs();
        vm.prank(depositor);
        escrow.withdrawDeposit(depositId);

        Vm.Log[] memory entries = vm.getRecordedLogs();
        assertEq(_countLogs(entries, DEPOSIT_ACCEPTING_INTENTS_UPDATED_TOPIC), 0);
    }

    function test_setDelegateStoresDelegateAndEmitsEvent() public {
        vm.expectEmit(true, true, true, true, address(escrow));
        emit DepositDelegateSet(depositId, depositor, other);

        vm.prank(depositor);
        escrow.setDelegate(depositId, other);

        IEscrowV2.Deposit memory deposit = escrow.getDeposit(depositId);
        assertEq(deposit.delegate, other);
    }

    function test_setDelegateRevertsWhenCallerIsNotDepositor() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.UnauthorizedCaller.selector, other, depositor));
        vm.prank(other);
        escrow.setDelegate(depositId, other);
    }

    function test_removeDelegateClearsDelegateAndEmitsEvent() public {
        vm.expectEmit(true, true, false, true, address(escrow));
        emit DepositDelegateRemoved(depositId, depositor);

        vm.prank(depositor);
        escrow.removeDelegate(depositId);

        IEscrowV2.Deposit memory deposit = escrow.getDeposit(depositId);
        assertEq(deposit.delegate, address(0));
    }

    function test_removeDelegateRevertsWhenNoDelegateIsSet() public {
        vm.prank(depositor);
        escrow.removeDelegate(depositId);

        vm.expectRevert();
        vm.prank(depositor);
        escrow.removeDelegate(depositId);
    }

    function test_setIntentRangeUpdatesRangeAndEmitsEvent() public {
        IEscrowV2.Range memory range = IEscrowV2.Range({ min: 20e6, max: 300e6 });

        vm.expectEmit(true, false, false, true, address(escrow));
        emit DepositIntentAmountRangeUpdated(depositId, range);

        vm.prank(depositor);
        escrow.setIntentRange(depositId, range);

        IEscrowV2.Deposit memory deposit = escrow.getDeposit(depositId);
        assertEq(deposit.intentAmountRange.min, range.min);
        assertEq(deposit.intentAmountRange.max, range.max);
    }

    function test_setIntentRangeRevertsWhenMinIsZero() public {
        IEscrowV2.Range memory range = IEscrowV2.Range({ min: 0, max: 100e6 });

        vm.expectRevert(IEscrowV2.ZeroMinValue.selector);
        vm.prank(depositor);
        escrow.setIntentRange(depositId, range);
    }

    function test_setIntentRangeRevertsWhenMinIsGreaterThanMax() public {
        IEscrowV2.Range memory range = IEscrowV2.Range({ min: 100e6, max: 50e6 });

        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.InvalidRange.selector, 100e6, 50e6));
        vm.prank(depositor);
        escrow.setIntentRange(depositId, range);
    }

    function test_setCurrencyMinRateRevertsWhenCurrencyIsNotListed() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.CurrencyNotSupported.selector, VENMO, JPY));
        vm.prank(depositor);
        escrow.setCurrencyMinRate(depositId, VENMO, JPY, 1e18);
    }

    function test_setCurrencyMinRateUpdatesFixedFloorAndEmitsEvent() public {
        vm.expectEmit(true, true, true, true, address(escrow));
        emit DepositMinConversionRateUpdated(depositId, VENMO, USD, 1.15e18);

        vm.prank(depositor);
        escrow.setCurrencyMinRate(depositId, VENMO, USD, 1.15e18);

        assertEq(escrow.getDepositCurrencyMinRate(depositId, VENMO, USD), 1.15e18);
    }

    function test_addPaymentMethodsAddsPaymentMethodToExistingDeposit() public {
        bytes32[] memory paymentMethods = new bytes32[](1);
        paymentMethods[0] = PAYPAL;
        IEscrowV2.DepositPaymentMethodData[] memory methodData = _singlePaymentMethodData(address(0), PAYEE_DETAILS, "");
        IEscrowV2.Currency[][] memory currencies = new IEscrowV2.Currency[][](1);
        currencies[0] = _currencyList(EUR, 0.9e18);

        vm.expectEmit(true, true, true, true, address(escrow));
        emit DepositPaymentMethodAdded(depositId, PAYPAL, PAYEE_DETAILS, address(0));

        vm.prank(depositor);
        escrow.addPaymentMethods(depositId, paymentMethods, methodData, currencies);

        assertTrue(escrow.getDepositPaymentMethodListed(depositId, PAYPAL));
    }

    function test_addPaymentMethodsRevertsWhenPaymentMethodIsNotWhitelisted() public {
        bytes32[] memory paymentMethods = new bytes32[](1);
        paymentMethods[0] = bytes32("unknown");
        IEscrowV2.DepositPaymentMethodData[] memory methodData = _singlePaymentMethodData(address(0), PAYEE_DETAILS, "");
        IEscrowV2.Currency[][] memory currencies = new IEscrowV2.Currency[][](1);
        currencies[0] = _currencyList(USD, 1e18);

        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.PaymentMethodNotWhitelisted.selector, bytes32("unknown")));
        vm.prank(depositor);
        escrow.addPaymentMethods(depositId, paymentMethods, methodData, currencies);
    }

    function test_setPaymentMethodActiveTogglesPaymentMethodActiveState() public {
        vm.expectEmit(true, true, false, true, address(escrow));
        emit DepositPaymentMethodActiveUpdated(depositId, VENMO, false);

        vm.prank(depositor);
        escrow.setPaymentMethodActive(depositId, VENMO, false);

        assertFalse(escrow.getDepositPaymentMethodActive(depositId, VENMO));
    }

    function test_setPaymentMethodActiveRevertsWhenAlreadyInRequestedState() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.DepositAlreadyInState.selector, depositId, true));
        vm.prank(depositor);
        escrow.setPaymentMethodActive(depositId, VENMO, true);
    }

    function test_addCurrenciesAddsAdditionalCurrencyOnActivePaymentMethod() public {
        IEscrowV2.Currency[] memory currencies = _currencyList(EUR, 0.9e18);

        vm.expectEmit(true, true, true, true, address(escrow));
        emit DepositCurrencyAdded(depositId, VENMO, EUR, 0.9e18);

        vm.prank(depositor);
        escrow.addCurrencies(depositId, VENMO, currencies);

        assertEq(escrow.getDepositCurrencyMinRate(depositId, VENMO, EUR), 0.9e18);
    }

    function test_addCurrenciesRevertsForUnsupportedCurrency() public {
        IEscrowV2.Currency[] memory currencies = _currencyList(JPY, 1e18);

        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.CurrencyNotSupported.selector, VENMO, JPY));
        vm.prank(depositor);
        escrow.addCurrencies(depositId, VENMO, currencies);
    }

    function test_addCurrenciesRevertsWhenCurrencyAlreadyExists() public {
        IEscrowV2.Currency[] memory currencies = _currencyList(USD, 1e18);

        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.CurrencyAlreadyExists.selector, VENMO, USD));
        vm.prank(depositor);
        escrow.addCurrencies(depositId, VENMO, currencies);
    }

    function test_addCurrenciesAllowsMinConversionRateToBeZero() public {
        IEscrowV2.Currency[] memory currencies = _currencyList(EUR, 0);

        vm.expectEmit(true, true, true, true, address(escrow));
        emit DepositCurrencyAdded(depositId, VENMO, EUR, 0);

        vm.prank(depositor);
        escrow.addCurrencies(depositId, VENMO, currencies);

        assertEq(escrow.getDepositCurrencyMinRate(depositId, VENMO, EUR), 0);
    }

    function test_addCurrenciesSetsInlineOracleConfig() public {
        vm.warp(1_000);
        bytes memory adapterConfig = _buildOracleAdapterConfig(true, 1.1e18, block.timestamp);
        IEscrowV2.Currency[] memory currencies = _currencyListWithConfig(
            EUR,
            0.9e18,
            _oracleRateConfig(address(staticOracleAdapter), adapterConfig, 100, 3600)
        );

        vm.recordLogs();
        vm.prank(depositor);
        escrow.addCurrencies(depositId, VENMO, currencies);

        Vm.Log[] memory entries = vm.getRecordedLogs();
        IEscrowV2.OracleRateConfig memory config = escrow.getDepositOracleRateConfig(depositId, VENMO, EUR);

        assertEq(_countLogs(entries, keccak256("DepositCurrencyAdded(uint256,bytes32,bytes32,uint256)")), 1);
        assertEq(_countLogs(entries, DEPOSIT_ORACLE_RATE_CONFIG_SET_TOPIC), 1);
        assertEq(config.adapter, address(staticOracleAdapter));
        assertEq(config.adapterConfig, adapterConfig);
        assertEq(config.spreadBps, 100);
        assertEq(config.maxStaleness, 3600);
    }

    function test_setAcceptingIntentsSetsAcceptingIntentsFlag() public {
        vm.expectEmit(true, false, false, true, address(escrow));
        emit DepositAcceptingIntentsUpdated(depositId, false);

        vm.prank(depositor);
        escrow.setAcceptingIntents(depositId, false);

        assertFalse(escrow.getDeposit(depositId).acceptingIntents);
    }

    function test_setAcceptingIntentsRevertsWhenEnablingWhileLiquidityIsBelowMinimum() public {
        vm.prank(depositor);
        escrow.setAcceptingIntents(depositId, false);
        vm.prank(depositor);
        escrow.removeFunds(depositId, 495e6);

        vm.expectRevert(
            abi.encodeWithSelector(IEscrowV2.InsufficientDepositLiquidity.selector, depositId, 5e6, 10e6)
        );
        vm.prank(depositor);
        escrow.setAcceptingIntents(depositId, true);
    }

    function test_setRetainOnEmptySetsRetainOnEmpty() public {
        vm.expectEmit(true, false, false, true, address(escrow));
        emit DepositRetainOnEmptyUpdated(depositId, true);

        vm.prank(depositor);
        escrow.setRetainOnEmpty(depositId, true);

        assertTrue(escrow.getDeposit(depositId).retainOnEmpty);
    }

    function test_governanceSettersUpdateOwnerControlledConfigFieldsAndPause() public {
        vm.startPrank(owner);
        OrchestratorRegistry newOrchestratorRegistry = new OrchestratorRegistry();
        PaymentVerifierRegistry newPaymentVerifierRegistry = new PaymentVerifierRegistry();

        vm.expectEmit(true, false, false, true, address(escrow));
        emit OrchestratorRegistryUpdated(address(newOrchestratorRegistry));
        escrow.setOrchestratorRegistry(address(newOrchestratorRegistry));

        vm.expectEmit(true, false, false, true, address(escrow));
        emit PaymentVerifierRegistryUpdated(address(newPaymentVerifierRegistry));
        escrow.setPaymentVerifierRegistry(address(newPaymentVerifierRegistry));

        vm.expectEmit(true, false, false, true, address(escrow));
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

        escrow.pauseEscrow();
        assertTrue(escrow.paused());
        escrow.unpauseEscrow();
        vm.stopPrank();

        assertFalse(escrow.paused());
        assertEq(address(escrow.orchestratorRegistry()), address(newOrchestratorRegistry));
        assertEq(address(escrow.paymentVerifierRegistry()), address(newPaymentVerifierRegistry));
        assertEq(escrow.dustRecipient(), other);
        assertEq(escrow.dustThreshold(), 1e6);
        assertEq(escrow.maxIntentsPerDeposit(), 10);
        assertEq(escrow.intentExpirationPeriod(), 7200);
    }

    function _defaultCreateDepositParams() internal view returns (IEscrowV2.CreateDepositParams memory params) {
        params = IEscrowV2.CreateDepositParams({
            token: IERC20(address(usdc)),
            amount: 50e6,
            intentAmountRange: IEscrowV2.Range({ min: 10e6, max: 100e6 }),
            paymentMethods: _singlePaymentMethods(VENMO),
            paymentMethodData: _singlePaymentMethodData(address(0), PAYEE_DETAILS, ""),
            currencies: _singleDepositCurrencies(USD, 1e18),
            delegate: delegate,
            intentGuardian: intentGuardian,
            retainOnEmpty: false
        });
    }
}

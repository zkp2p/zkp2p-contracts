// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Vm} from "forge-std/Vm.sol";

import {IEscrowV2} from "../../contracts/interfaces/IEscrowV2.sol";
import {RateManagerMock} from "../../contracts/mocks/RateManagerMock.sol";
import {EscrowV2LegacyCoverageBase} from "./EscrowV2LegacyCoverageBase.sol";

contract EscrowV2BranchOracleAndLifecycleTest is EscrowV2LegacyCoverageBase {
    bytes32 internal constant MISSING_RATE_MANAGER_ID = bytes32("missing-manager");
    bytes32 internal constant DEPOSIT_MIN_CONVERSION_RATE_UPDATED_TOPIC =
        keccak256("DepositMinConversionRateUpdated(uint256,bytes32,bytes32,uint256)");
    bytes32 internal constant DEPOSIT_ORACLE_RATE_CONFIG_REMOVED_TOPIC =
        keccak256("DepositOracleRateConfigRemoved(uint256,bytes32,bytes32)");
    bytes32 internal constant DEPOSIT_CLOSED_TOPIC = keccak256("DepositClosed(uint256,address)");
    bytes32 internal constant DUST_COLLECTED_TOPIC = keccak256("DustCollected(uint256,uint256,address)");

    function setUp() public {
        _setUpLegacyFixture();
    }

    function test_setOracleRateConfigRevertsWhenAdapterIsZero() public {
        vm.expectRevert(IEscrowV2.ZeroAddress.selector);
        vm.prank(depositor);
        escrow.setOracleRateConfig(
            depositId,
            VENMO,
            USD,
            _oracleRateConfig(address(0), _buildOracleAdapterConfig(true, 1.2e18, block.timestamp), 100, 3600)
        );
    }

    function test_setOracleRateConfigRevertsWhenAdapterHasNoCode() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.InvalidOracleAdapter.selector, other));
        vm.prank(depositor);
        escrow.setOracleRateConfig(
            depositId,
            VENMO,
            USD,
            _oracleRateConfig(other, _buildOracleAdapterConfig(true, 1.2e18, block.timestamp), 100, 3600)
        );
    }

    function test_setOracleRateConfigAllowsPositiveSpreadAboveTenThousandBps() public {
        bytes memory adapterConfig = _buildOracleAdapterConfig(true, 1.2e18, block.timestamp);

        vm.prank(depositor);
        escrow.setOracleRateConfig(
            depositId, VENMO, USD, _oracleRateConfig(address(staticOracleAdapter), adapterConfig, 10_001, 3600)
        );

        IEscrowV2.OracleRateConfig memory config = escrow.getDepositOracleRateConfig(depositId, VENMO, USD);
        assertEq(config.spreadBps, 10_001);
        assertEq(config.maxStaleness, 3600);
    }

    function test_setOracleRateConfigRevertsWhenSpreadIsNegativeTenThousandBps() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.InvalidSpread.selector, int16(-10_000)));
        vm.prank(depositor);
        escrow.setOracleRateConfig(
            depositId,
            VENMO,
            USD,
            _oracleRateConfig(
                address(staticOracleAdapter), _buildOracleAdapterConfig(true, 1.2e18, block.timestamp), -10_000, 3600
            )
        );
    }

    function test_setOracleRateConfigRevertsWhenMaxStalenessIsZero() public {
        vm.expectRevert(IEscrowV2.ZeroValue.selector);
        vm.prank(depositor);
        escrow.setOracleRateConfig(
            depositId,
            VENMO,
            USD,
            _oracleRateConfig(
                address(staticOracleAdapter), _buildOracleAdapterConfig(true, 1.2e18, block.timestamp), 100, 0
            )
        );
    }

    function test_addCurrenciesRevertsWhenPaymentMethodIsInactive() public {
        vm.prank(depositor);
        escrow.setPaymentMethodActive(depositId, VENMO, false);

        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.PaymentMethodNotActive.selector, depositId, VENMO));
        vm.prank(depositor);
        escrow.addCurrencies(depositId, VENMO, _currencyList(EUR, 0.9e18));
    }

    function test_deactivateCurrencyRevertsWhenPaymentMethodIsInactive() public {
        vm.prank(depositor);
        escrow.setPaymentMethodActive(depositId, VENMO, false);

        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.PaymentMethodNotActive.selector, depositId, VENMO));
        vm.prank(depositor);
        escrow.deactivateCurrency(depositId, VENMO, USD);
    }

    function test_deactivateCurrencyRevertsWhenCurrencyIsNotListed() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.CurrencyNotFound.selector, VENMO, JPY));
        vm.prank(depositor);
        escrow.deactivateCurrency(depositId, VENMO, JPY);
    }

    function test_deactivateCurrencyWithoutOracleConfigDoesNotEmitOracleRemoval() public {
        vm.recordLogs();
        vm.prank(depositor);
        escrow.deactivateCurrency(depositId, VENMO, USD);

        Vm.Log[] memory entries = vm.getRecordedLogs();

        assertEq(_countLogs(entries, DEPOSIT_MIN_CONVERSION_RATE_UPDATED_TOPIC), 1);
        assertEq(_countLogs(entries, DEPOSIT_ORACLE_RATE_CONFIG_REMOVED_TOPIC), 0);
        assertEq(escrow.getDepositCurrencyMinRate(depositId, VENMO, USD), 0);
    }

    function test_setPaymentMethodActiveRevertsWhenMethodIsNotListed() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.PaymentMethodNotListed.selector, depositId, PAYPAL));
        vm.prank(depositor);
        escrow.setPaymentMethodActive(depositId, PAYPAL, false);
    }

    function test_setRateManagerRevertsWhenDepositDoesNotExist() public {
        rateManagerMock.setManager(RATE_MANAGER_ID, true);

        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.DepositNotFound.selector, uint256(999)));
        vm.prank(depositor);
        escrow.setRateManager(999, address(rateManagerMock), RATE_MANAGER_ID);
    }

    function test_setRateManagerRevertsWhenManagerIsZeroAddress() public {
        rateManagerMock.setManager(RATE_MANAGER_ID, true);

        vm.expectRevert(IEscrowV2.ZeroAddress.selector);
        vm.prank(depositor);
        escrow.setRateManager(depositId, address(0), RATE_MANAGER_ID);
    }

    function test_setRateManagerRevertsWhenManagerHasNoCode() public {
        rateManagerMock.setManager(RATE_MANAGER_ID, true);

        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.InvalidRateManager.selector, other));
        vm.prank(depositor);
        escrow.setRateManager(depositId, other, RATE_MANAGER_ID);
    }

    function test_setRateManagerRevertsWhenRateManagerIdIsZero() public {
        rateManagerMock.setManager(RATE_MANAGER_ID, true);

        vm.expectRevert(IEscrowV2.ZeroValue.selector);
        vm.prank(depositor);
        escrow.setRateManager(depositId, address(rateManagerMock), bytes32(0));
    }

    function test_setRateManagerRevertsWhenManagerDoesNotExist() public {
        vm.expectRevert(abi.encodeWithSelector(RateManagerMock.RateManagerNotFound.selector, MISSING_RATE_MANAGER_ID));
        vm.prank(depositor);
        escrow.setRateManager(depositId, address(rateManagerMock), MISSING_RATE_MANAGER_ID);
    }

    function test_clearRateManagerRevertsWhenDepositDoesNotExist() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.DepositNotFound.selector, uint256(999)));
        vm.prank(depositor);
        escrow.clearRateManager(999);
    }

    function test_clearRateManagerRevertsWhenManagerIsNotSet() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.RateManagerNotSet.selector, depositId));
        vm.prank(depositor);
        escrow.clearRateManager(depositId);
    }

    function test_lockFundsRevertsWhenDepositDoesNotExist() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.DepositNotFound.selector, uint256(999)));
        vm.prank(owner);
        orchestratorMock.lockFunds(999, keccak256("missing-deposit-lock"), 20e6);
    }

    function test_lockFundsRevertsWhenDepositIsNotAcceptingIntents() public {
        vm.prank(depositor);
        escrow.setAcceptingIntents(depositId, false);

        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.DepositNotAcceptingIntents.selector, depositId));
        vm.prank(owner);
        orchestratorMock.lockFunds(depositId, keccak256("not-accepting-lock"), 20e6);
    }

    function test_lockFundsRevertsWhenAmountIsBelowMinRange() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.AmountBelowMin.selector, uint256(5e6), uint256(10e6)));
        vm.prank(owner);
        orchestratorMock.lockFunds(depositId, keccak256("below-min-lock"), 5e6);
    }

    function test_lockFundsRevertsWhenAmountIsAboveMaxRange() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.AmountAboveMax.selector, uint256(201e6), uint256(200e6)));
        vm.prank(owner);
        orchestratorMock.lockFunds(depositId, keccak256("above-max-lock"), 201e6);
    }

    function test_unlockFundsRevertsWhenDepositDoesNotExist() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.DepositNotFound.selector, uint256(999)));
        vm.prank(owner);
        orchestratorMock.unlockFunds(999, keccak256("missing-deposit-unlock"));
    }

    function test_unlockFundsRevertsWhenIntentDoesNotExist() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.IntentNotFound.selector, keccak256("missing-intent-unlock")));
        vm.prank(owner);
        orchestratorMock.unlockFunds(depositId, keccak256("missing-intent-unlock"));
    }

    function test_unlockAndTransferFundsRevertsWhenDepositDoesNotExist() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.DepositNotFound.selector, uint256(999)));
        vm.prank(owner);
        orchestratorMock.unlockAndTransferFunds(999, keccak256("missing-deposit-transfer"), 20e6, other);
    }

    function test_unlockAndTransferFundsRevertsWhenIntentDoesNotExist() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.IntentNotFound.selector, keccak256("missing-intent-transfer")));
        vm.prank(owner);
        orchestratorMock.unlockAndTransferFunds(depositId, keccak256("missing-intent-transfer"), 20e6, other);
    }

    function test_unlockAndTransferFundsRevertsWhenTransferAmountIsZero() public {
        bytes32 intentHash = _createIntentWith(address(orchestratorMock), 20e6);

        vm.expectRevert(IEscrowV2.ZeroValue.selector);
        vm.prank(owner);
        orchestratorMock.unlockAndTransferFunds(depositId, intentHash, 0, other);
    }

    function test_unlockAndTransferFundsRevertsWhenTransferAmountExceedsIntentAmount() public {
        bytes32 intentHash = _createIntentWith(address(orchestratorMock), 20e6);

        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.AmountExceedsAvailable.selector, uint256(25e6), uint256(20e6)));
        vm.prank(owner);
        orchestratorMock.unlockAndTransferFunds(depositId, intentHash, 25e6, other);
    }

    function test_extendIntentExpiryRevertsWhenDepositDoesNotExist() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.DepositNotFound.selector, uint256(999)));
        vm.prank(intentGuardian);
        escrow.extendIntentExpiry(999, keccak256("missing-deposit-extend"), 120);
    }

    function test_extendIntentExpiryRevertsWhenIntentDoesNotExist() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.IntentNotFound.selector, keccak256("missing-intent-extend")));
        vm.prank(intentGuardian);
        escrow.extendIntentExpiry(depositId, keccak256("missing-intent-extend"), 120);
    }

    function test_extendIntentExpiryRevertsWhenCallerIsNotIntentGuardian() public {
        bytes32 intentHash = _createIntentWith(address(orchestratorMock), 20e6);

        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.UnauthorizedCaller.selector, other, intentGuardian));
        vm.prank(other);
        escrow.extendIntentExpiry(depositId, intentHash, 120);
    }

    function test_extendIntentExpiryRevertsWhenAdditionalTimeIsZero() public {
        bytes32 intentHash = _createIntentWith(address(orchestratorMock), 20e6);

        vm.expectRevert(IEscrowV2.ZeroValue.selector);
        vm.prank(intentGuardian);
        escrow.extendIntentExpiry(depositId, intentHash, 0);
    }

    function test_getDepositCurrencyMinRateReturnsZeroWhenOracleMarketRateIsZero() public {
        vm.prank(depositor);
        escrow.setOracleRateConfig(
            depositId,
            VENMO,
            USD,
            _oracleRateConfig(
                address(staticOracleAdapter), _buildOracleAdapterConfig(true, 0, block.timestamp), 100, 3600
            )
        );

        assertEq(escrow.getDepositCurrencyMinRate(depositId, VENMO, USD), 0);
    }

    function test_getDepositCurrencyMinRateReturnsZeroWhenOracleUpdatedAtIsZero() public {
        vm.prank(depositor);
        escrow.setOracleRateConfig(
            depositId,
            VENMO,
            USD,
            _oracleRateConfig(address(staticOracleAdapter), _buildOracleAdapterConfig(true, 1.2e18, 0), 100, 3600)
        );

        assertEq(escrow.getDepositCurrencyMinRate(depositId, VENMO, USD), 0);
    }

    function test_unlockAndTransferFundsDoesNotCloseDepositWhenRetainOnEmptyIsTrue() public {
        uint256 retainDepositId = _createCustomDeposit(20e6, true);
        bytes32 intentHash = keccak256("retain-on-empty-intent");

        vm.prank(owner);
        orchestratorMock.lockFunds(retainDepositId, intentHash, 20e6);

        vm.recordLogs();
        vm.prank(owner);
        orchestratorMock.unlockAndTransferFunds(retainDepositId, intentHash, 20e6, other);

        Vm.Log[] memory entries = vm.getRecordedLogs();
        IEscrowV2.Deposit memory deposit = escrow.getDeposit(retainDepositId);

        assertEq(_countLogs(entries, DEPOSIT_CLOSED_TOPIC), 0);
        assertEq(deposit.depositor, depositor);
        assertEq(deposit.remainingDeposits, 0);
    }

    function test_unlockAndTransferFundsClosesDepositWithoutDustWhenFullyDrained() public {
        uint256 emptyDepositId = _createCustomDeposit(20e6, false);
        bytes32 intentHash = keccak256("close-on-empty-intent");

        vm.prank(owner);
        orchestratorMock.lockFunds(emptyDepositId, intentHash, 20e6);

        vm.recordLogs();
        vm.prank(owner);
        orchestratorMock.unlockAndTransferFunds(emptyDepositId, intentHash, 20e6, other);

        Vm.Log[] memory entries = vm.getRecordedLogs();
        IEscrowV2.Deposit memory deposit = escrow.getDeposit(emptyDepositId);

        assertEq(_countLogs(entries, DEPOSIT_CLOSED_TOPIC), 1);
        assertEq(_countLogs(entries, DUST_COLLECTED_TOPIC), 0);
        assertEq(deposit.depositor, address(0));
    }

    function _createCustomDeposit(uint256 amount, bool retainOnEmpty) internal returns (uint256 createdDepositId) {
        IEscrowV2.CreateDepositParams memory params = IEscrowV2.CreateDepositParams({
            token: IERC20(address(usdc)),
            amount: amount,
            intentAmountRange: IEscrowV2.Range({min: 10e6, max: 200e6}),
            paymentMethods: _singlePaymentMethods(PAYPAL),
            paymentMethodData: _singlePaymentMethodData(address(0), PAYEE_DETAILS, ""),
            currencies: _singleDepositCurrencies(USD, 1e18),
            delegate: delegate,
            intentGuardian: intentGuardian,
            retainOnEmpty: retainOnEmpty
        });

        vm.prank(depositor);
        escrow.createDeposit(params);
        createdDepositId = escrow.depositCounter() - 1;
    }
}

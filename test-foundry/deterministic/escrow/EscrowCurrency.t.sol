// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {EscrowLegacyFixture} from "../helpers/EscrowLegacyFixture.sol";
import {IEscrow} from "contracts/interfaces/IEscrow.sol";

contract EscrowCurrencyTest is EscrowLegacyFixture {
    event DepositCurrencyAdded(
        uint256 indexed depositId, bytes32 indexed paymentMethod, bytes32 indexed currency, uint256 minConversionRate
    );
    event DepositMinConversionRateUpdated(
        uint256 indexed depositId, bytes32 indexed paymentMethod, bytes32 indexed currency, uint256 newRate
    );

    function setUp() public override {
        super.setUp();
        IEscrow.CreateDepositParams memory params = _baseCreateParams();
        params.retainOnEmpty = false;
        params.currencies[0] = new IEscrow.Currency[](1);
        params.currencies[0][0] = IEscrow.Currency({code: USD, minConversionRate: 1.01e18});
        _createAsOffRamper(params);
    }

    function _addCurrency(address caller, uint256 depositId, bytes32 paymentMethod, bytes32 code, uint256 rate)
        internal
    {
        IEscrow.Currency[] memory currencies = new IEscrow.Currency[](1);
        currencies[0] = IEscrow.Currency({code: code, minConversionRate: rate});
        vm.prank(caller);
        escrow.addCurrencies(depositId, paymentMethod, currencies);
    }

    function _deactivateCurrency(address caller, uint256 depositId, bytes32 paymentMethod, bytes32 code) internal {
        vm.prank(caller);
        escrow.deactivateCurrency(depositId, paymentMethod, code);
    }

    function _addEur() internal {
        _addCurrency(offRamper, 0, VENMO, EUR, 0.95e18);
    }

    function test_AddCurrencyStoresCurrencyAndRate() public {
        _addEur();

        bytes32[] memory currencies = escrow.getDepositCurrencies(0, VENMO);
        assertEq(currencies.length, 2);
        assertEq(currencies[0], USD);
        assertEq(currencies[1], EUR);
        assertEq(escrow.getDepositCurrencyMinRate(0, VENMO, EUR), 0.95e18);
    }

    function test_AddCurrencyEmitsAddedEvent() public {
        vm.expectEmit(true, true, true, true, address(escrow));
        emit DepositCurrencyAdded(0, VENMO, EUR, 0.95e18);
        _addEur();
    }

    function test_AddCurrencyAllowsDelegate() public {
        _addCurrency(offRamperDelegate, 0, VENMO, EUR, 0.95e18);
        assertEq(escrow.getDepositCurrencyMinRate(0, VENMO, EUR), 0.95e18);
    }

    function test_AddCurrencyRejectsUnauthorizedCaller() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IEscrow.UnauthorizedCallerOrDelegate.selector, maliciousOnRamper, offRamper, offRamperDelegate
            )
        );
        _addCurrency(maliciousOnRamper, 0, VENMO, EUR, 0.95e18);
    }

    function test_AddCurrencyRejectsMissingDepositWithUnauthorizedError() public {
        vm.expectRevert(
            abi.encodeWithSelector(IEscrow.UnauthorizedCallerOrDelegate.selector, offRamper, address(0), address(0))
        );
        _addCurrency(offRamper, 999, VENMO, EUR, 0.95e18);
    }

    function test_AddCurrencyRejectsInactiveOrMissingPaymentMethod() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrow.PaymentMethodNotActive.selector, 0, PAYPAL));
        _addCurrency(offRamper, 0, PAYPAL, EUR, 0.95e18);
    }

    function test_AddCurrencyRejectsUnsupportedCurrency() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrow.CurrencyNotSupported.selector, VENMO, AED));
        _addCurrency(offRamper, 0, VENMO, AED, 3.67e18);
    }

    function test_AddCurrencyRejectsZeroConversionRate() public {
        vm.expectRevert(IEscrow.ZeroConversionRate.selector);
        _addCurrency(offRamper, 0, VENMO, EUR, 0);
    }

    function test_AddCurrencyRejectsExistingCurrency() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrow.CurrencyAlreadyExists.selector, VENMO, USD));
        _addCurrency(offRamper, 0, VENMO, USD, 1.05e18);
    }

    function test_AddCurrencyRejectsWhilePaused() public {
        escrow.pauseEscrow();
        vm.expectRevert("Pausable: paused");
        _addCurrency(offRamper, 0, VENMO, EUR, 0.95e18);
    }

    function test_DeactivateCurrencyKeepsCurrencyListedAndZerosRate() public {
        _addEur();
        _deactivateCurrency(offRamper, 0, VENMO, EUR);

        bytes32[] memory currencies = escrow.getDepositCurrencies(0, VENMO);
        assertEq(currencies.length, 2);
        assertEq(currencies[1], EUR);
        assertTrue(escrow.getDepositCurrencyListed(0, VENMO, EUR));
        assertEq(escrow.getDepositCurrencyMinRate(0, VENMO, EUR), 0);
    }

    function test_DeactivateCurrencyEmitsZeroRateUpdate() public {
        _addEur();
        vm.expectEmit(true, true, true, true, address(escrow));
        emit DepositMinConversionRateUpdated(0, VENMO, EUR, 0);
        _deactivateCurrency(offRamper, 0, VENMO, EUR);
    }

    function test_DeactivateCurrencyAllowsDelegate() public {
        _addEur();
        _deactivateCurrency(offRamperDelegate, 0, VENMO, EUR);
        assertEq(escrow.getDepositCurrencyMinRate(0, VENMO, EUR), 0);
    }

    function test_DeactivateCurrencyRejectsUnauthorizedCaller() public {
        _addEur();
        vm.expectRevert(
            abi.encodeWithSelector(
                IEscrow.UnauthorizedCallerOrDelegate.selector, maliciousOnRamper, offRamper, offRamperDelegate
            )
        );
        _deactivateCurrency(maliciousOnRamper, 0, VENMO, EUR);
    }

    function test_DeactivateCurrencyRejectsMissingDepositWithUnauthorizedError() public {
        vm.expectRevert(
            abi.encodeWithSelector(IEscrow.UnauthorizedCallerOrDelegate.selector, offRamper, address(0), address(0))
        );
        _deactivateCurrency(offRamper, 999, VENMO, EUR);
    }

    function test_DeactivateCurrencyRejectsInactiveOrMissingPaymentMethod() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrow.PaymentMethodNotActive.selector, 0, PAYPAL));
        _deactivateCurrency(offRamper, 0, PAYPAL, EUR);
    }

    function test_DeactivateCurrencyRejectsMissingCurrency() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrow.CurrencyNotFound.selector, VENMO, AED));
        _deactivateCurrency(offRamper, 0, VENMO, AED);
    }

    function test_DeactivateCurrencyRejectsWhilePaused() public {
        _addEur();
        escrow.pauseEscrow();
        vm.expectRevert("Pausable: paused");
        _deactivateCurrency(offRamper, 0, VENMO, EUR);
    }
}

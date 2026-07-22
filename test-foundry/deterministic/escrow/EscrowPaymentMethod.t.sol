// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {EscrowLegacyFixture} from "../helpers/EscrowLegacyFixture.sol";
import {Vm} from "forge-std/Vm.sol";
import {IEscrow} from "contracts/interfaces/IEscrow.sol";

contract EscrowPaymentMethodTest is EscrowLegacyFixture {
    bytes32 internal constant OTHER_PAYEE = keccak256("otherPayeeDetails");

    event DepositPaymentMethodAdded(
        uint256 indexed depositId, bytes32 indexed paymentMethod, bytes32 indexed payeeDetails, address gatingService
    );
    event DepositPaymentMethodActiveUpdated(uint256 indexed depositId, bytes32 indexed paymentMethod, bool active);

    function setUp() public override {
        super.setUp();
        IEscrow.CreateDepositParams memory params = _baseCreateParams();
        params.retainOnEmpty = false;
        params.currencies[0] = new IEscrow.Currency[](1);
        params.currencies[0][0] = IEscrow.Currency({code: USD, minConversionRate: 1.01e18});
        _createAsOffRamper(params);
    }

    function _paypalInputs()
        internal
        view
        returns (
            bytes32[] memory methods,
            IEscrow.DepositPaymentMethodData[] memory data,
            IEscrow.Currency[][] memory currencies
        )
    {
        methods = new bytes32[](1);
        methods[0] = PAYPAL;
        data = new IEscrow.DepositPaymentMethodData[](1);
        data[0] =
            IEscrow.DepositPaymentMethodData({intentGatingService: gatingService, payeeDetails: OTHER_PAYEE, data: ""});
        currencies = new IEscrow.Currency[][](1);
        currencies[0] = new IEscrow.Currency[](2);
        currencies[0][0] = IEscrow.Currency({code: USD, minConversionRate: 1.02e18});
        currencies[0][1] = IEscrow.Currency({code: EUR, minConversionRate: 0.95e18});
    }

    function _addPaypal(address caller, uint256 depositId) internal {
        (
            bytes32[] memory methods,
            IEscrow.DepositPaymentMethodData[] memory data,
            IEscrow.Currency[][] memory currencies
        ) = _paypalInputs();
        vm.prank(caller);
        escrow.addPaymentMethods(depositId, methods, data, currencies);
    }

    function _setPaypalActive(address caller, uint256 depositId, bool active) internal {
        vm.prank(caller);
        escrow.setPaymentMethodActive(depositId, PAYPAL, active);
    }

    function test_AddPaymentMethodStoresMethodAndVerificationData() public {
        _addPaypal(offRamper, 0);
        bytes32[] memory methods = escrow.getDepositPaymentMethods(0);
        assertEq(methods.length, 2);
        assertEq(methods[1], PAYPAL);
        IEscrow.DepositPaymentMethodData memory data = escrow.getDepositPaymentMethodData(0, PAYPAL);
        assertEq(data.intentGatingService, gatingService);
        assertEq(data.payeeDetails, OTHER_PAYEE);
        assertEq(data.data, "");
    }

    function test_AddPaymentMethodMarksMethodActive() public {
        _addPaypal(offRamper, 0);
        assertTrue(escrow.getDepositPaymentMethodActive(0, PAYPAL));
    }

    function test_AddPaymentMethodMarksMethodListed() public {
        _addPaypal(offRamper, 0);
        assertTrue(escrow.getDepositPaymentMethodListed(0, PAYPAL));
    }

    function test_AddPaymentMethodStoresAllCurrenciesAndRates() public {
        _addPaypal(offRamper, 0);
        bytes32[] memory currencies = escrow.getDepositCurrencies(0, PAYPAL);
        assertEq(currencies.length, 2);
        assertEq(currencies[0], USD);
        assertEq(currencies[1], EUR);
        assertEq(escrow.getDepositCurrencyMinRate(0, PAYPAL, USD), 1.02e18);
        assertEq(escrow.getDepositCurrencyMinRate(0, PAYPAL, EUR), 0.95e18);
    }

    function test_AddPaymentMethodEmitsMethodAndEveryCurrencyEvent() public {
        vm.recordLogs();
        _addPaypal(offRamper, 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 methodSignature = keccak256("DepositPaymentMethodAdded(uint256,bytes32,bytes32,address)");
        bytes32 currencySignature = keccak256("DepositCurrencyAdded(uint256,bytes32,bytes32,uint256)");
        uint256 methodEvents;
        uint256 currencyEvents;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(escrow)) continue;
            if (logs[i].topics[0] == methodSignature) {
                assertEq(logs[i].topics[2], PAYPAL);
                assertEq(logs[i].topics[3], OTHER_PAYEE);
                assertEq(abi.decode(logs[i].data, (address)), gatingService);
                ++methodEvents;
            }
            if (logs[i].topics[0] == currencySignature) ++currencyEvents;
        }
        assertEq(methodEvents, 1);
        assertEq(currencyEvents, 2);
    }

    function test_AddPaymentMethodAllowsDelegate() public {
        _addPaypal(offRamperDelegate, 0);
        assertTrue(escrow.getDepositPaymentMethodListed(0, PAYPAL));
    }

    function test_AddPaymentMethodRejectsUnauthorizedCaller() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IEscrow.UnauthorizedCallerOrDelegate.selector, maliciousOnRamper, offRamper, offRamperDelegate
            )
        );
        _addPaypal(maliciousOnRamper, 0);
    }

    function test_AddPaymentMethodRejectsMissingDepositWithUnauthorizedError() public {
        vm.expectRevert(
            abi.encodeWithSelector(IEscrow.UnauthorizedCallerOrDelegate.selector, offRamper, address(0), address(0))
        );
        _addPaypal(offRamper, 999);
    }

    function test_AddPaymentMethodRejectsUnwhitelistedMethod() public {
        (
            bytes32[] memory methods,
            IEscrow.DepositPaymentMethodData[] memory data,
            IEscrow.Currency[][] memory currencies
        ) = _paypalInputs();
        bytes32 unknown = keccak256("unknown");
        methods[0] = unknown;
        vm.expectRevert(abi.encodeWithSelector(IEscrow.PaymentMethodNotWhitelisted.selector, unknown));
        vm.prank(offRamper);
        escrow.addPaymentMethods(0, methods, data, currencies);
    }

    function test_AddPaymentMethodRejectsWhilePaused() public {
        escrow.pauseEscrow();
        vm.expectRevert("Pausable: paused");
        _addPaypal(offRamper, 0);
    }

    function test_AddPaymentMethodRejectsAlreadyListedMethod() public {
        _addPaypal(offRamper, 0);
        vm.expectRevert(abi.encodeWithSelector(IEscrow.PaymentMethodAlreadyExists.selector, 0, PAYPAL));
        _addPaypal(offRamper, 0);
    }

    function test_SetPaymentMethodInactiveKeepsMethodListed() public {
        _addPaypal(offRamper, 0);
        _setPaypalActive(offRamper, 0, false);
        assertTrue(escrow.getDepositPaymentMethodListed(0, PAYPAL));
        assertFalse(escrow.getDepositPaymentMethodActive(0, PAYPAL));
        assertEq(escrow.getDepositPaymentMethods(0)[1], PAYPAL);
    }

    function test_SetPaymentMethodInactivePreservesVerificationData() public {
        _addPaypal(offRamper, 0);
        _setPaypalActive(offRamper, 0, false);
        IEscrow.DepositPaymentMethodData memory data = escrow.getDepositPaymentMethodData(0, PAYPAL);
        assertEq(data.intentGatingService, gatingService);
        assertEq(data.payeeDetails, OTHER_PAYEE);
        assertEq(data.data, "");
    }

    function test_SetPaymentMethodInactiveUpdatesActiveMapping() public {
        _addPaypal(offRamper, 0);
        _setPaypalActive(offRamper, 0, false);
        assertFalse(escrow.getDepositPaymentMethodActive(0, PAYPAL));
    }

    function test_SetPaymentMethodInactivePreservesCurrenciesRatesAndData() public {
        _addPaypal(offRamper, 0);
        _setPaypalActive(offRamper, 0, false);
        assertEq(escrow.getDepositCurrencies(0, PAYPAL).length, 2);
        assertEq(escrow.getDepositCurrencyMinRate(0, PAYPAL, USD), 1.02e18);
        assertEq(escrow.getDepositPaymentMethodData(0, PAYPAL).intentGatingService, gatingService);
    }

    function test_SetPaymentMethodInactiveEmitsUpdate() public {
        _addPaypal(offRamper, 0);
        vm.expectEmit(true, true, false, true, address(escrow));
        emit DepositPaymentMethodActiveUpdated(0, PAYPAL, false);
        _setPaypalActive(offRamper, 0, false);
    }

    function test_SetPaymentMethodInactiveRejectsAlreadyInactive() public {
        _addPaypal(offRamper, 0);
        _setPaypalActive(offRamper, 0, false);
        vm.expectRevert(abi.encodeWithSelector(IEscrow.DepositAlreadyInState.selector, 0, false));
        _setPaypalActive(offRamper, 0, false);
    }

    function test_SetPaymentMethodActiveReactivatesInactiveMethod() public {
        _addPaypal(offRamper, 0);
        _setPaypalActive(offRamper, 0, false);
        _setPaypalActive(offRamper, 0, true);
        assertTrue(escrow.getDepositPaymentMethodActive(0, PAYPAL));
    }

    function test_SetPaymentMethodActiveEmitsReactivation() public {
        _addPaypal(offRamper, 0);
        _setPaypalActive(offRamper, 0, false);
        vm.expectEmit(true, true, false, true, address(escrow));
        emit DepositPaymentMethodActiveUpdated(0, PAYPAL, true);
        _setPaypalActive(offRamper, 0, true);
    }

    function test_SetPaymentMethodActiveAllowsDelegate() public {
        _addPaypal(offRamper, 0);
        _setPaypalActive(offRamperDelegate, 0, false);
        assertFalse(escrow.getDepositPaymentMethodActive(0, PAYPAL));
    }

    function test_SetPaymentMethodActiveRejectsUnauthorizedCaller() public {
        _addPaypal(offRamper, 0);
        vm.expectRevert(
            abi.encodeWithSelector(
                IEscrow.UnauthorizedCallerOrDelegate.selector, maliciousOnRamper, offRamper, offRamperDelegate
            )
        );
        _setPaypalActive(maliciousOnRamper, 0, false);
    }

    function test_SetPaymentMethodActiveRejectsMissingDepositWithUnauthorizedError() public {
        vm.expectRevert(
            abi.encodeWithSelector(IEscrow.UnauthorizedCallerOrDelegate.selector, offRamper, address(0), address(0))
        );
        _setPaypalActive(offRamper, 999, false);
    }

    function test_SetPaymentMethodActiveRejectsUnlistedMethod() public {
        bytes32 unknown = keccak256("unknown");
        vm.expectRevert(abi.encodeWithSelector(IEscrow.PaymentMethodNotListed.selector, 0, unknown));
        vm.prank(offRamper);
        escrow.setPaymentMethodActive(0, unknown, false);
    }

    function test_SetPaymentMethodActiveRejectsAlreadyInactive() public {
        _addPaypal(offRamper, 0);
        _setPaypalActive(offRamper, 0, false);
        vm.expectRevert(abi.encodeWithSelector(IEscrow.DepositAlreadyInState.selector, 0, false));
        _setPaypalActive(offRamper, 0, false);
    }

    function test_SetPaymentMethodActiveRejectsWhilePaused() public {
        _addPaypal(offRamper, 0);
        escrow.pauseEscrow();
        vm.expectRevert("Pausable: paused");
        _setPaypalActive(offRamper, 0, false);
    }
}

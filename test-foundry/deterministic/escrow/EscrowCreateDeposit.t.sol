// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {EscrowLegacyFixture} from "../helpers/EscrowLegacyFixture.sol";
import {Vm} from "forge-std/Vm.sol";
import {IEscrow} from "contracts/interfaces/IEscrow.sol";
import {IProtocolViewer} from "contracts/interfaces/IProtocolViewer.sol";

contract EscrowCreateDepositTest is EscrowLegacyFixture {
    event DepositReceived(
        uint256 indexed depositId,
        address indexed depositor,
        address indexed token,
        uint256 amount,
        IEscrow.Range range,
        address delegate,
        address guardian
    );
    event DepositPaymentMethodAdded(
        uint256 indexed depositId, bytes32 indexed paymentMethod, bytes32 indexed payeeDetails, address gatingService
    );

    function _multipleMethodParams() internal view returns (IEscrow.CreateDepositParams memory params) {
        params = _baseCreateParams();
        params.paymentMethods = new bytes32[](2);
        params.paymentMethods[0] = VENMO;
        params.paymentMethods[1] = PAYPAL;
        params.paymentMethodData = new IEscrow.DepositPaymentMethodData[](2);
        params.paymentMethodData[0] = IEscrow.DepositPaymentMethodData({
            intentGatingService: gatingService, payeeDetails: bytes32("test"), data: ""
        });
        params.paymentMethodData[1] = IEscrow.DepositPaymentMethodData({
            intentGatingService: gatingService, payeeDetails: bytes32("test2"), data: ""
        });
        params.currencies = new IEscrow.Currency[][](2);
        params.currencies[0] = new IEscrow.Currency[](2);
        params.currencies[0][0] = IEscrow.Currency({code: USD, minConversionRate: 1.01e18});
        params.currencies[0][1] = IEscrow.Currency({code: EUR, minConversionRate: 0.92e18});
        params.currencies[1] = new IEscrow.Currency[](1);
        params.currencies[1][0] = IEscrow.Currency({code: USD, minConversionRate: 1.02e18});
    }

    function test_ConstructorSetsEveryStateVariable() public view {
        assertEq(escrow.owner(), address(this));
        assertEq(escrow.chainId(), CHAIN_ID);
        assertEq(address(escrow.paymentVerifierRegistry()), address(paymentVerifierRegistry));
        assertEq(escrow.maxIntentsPerDeposit(), 3);
        assertEq(escrow.dustThreshold(), 0);
        assertEq(escrow.dustRecipient(), dustRecipient);
        assertEq(escrow.intentExpirationPeriod(), 1 days);
    }

    function test_CreateDepositTransfersTokensIntoEscrow() public {
        IEscrow.CreateDepositParams memory params = _baseCreateParams();
        uint256 escrowBefore = token.balanceOf(address(escrow));
        uint256 depositorBefore = token.balanceOf(offRamper);
        _createAsOffRamper(params);
        assertEq(token.balanceOf(address(escrow)) - escrowBefore, params.amount);
        assertEq(depositorBefore - token.balanceOf(offRamper), params.amount);
    }

    function test_CreateDepositPopulatesCompleteDepositView() public {
        IEscrow.CreateDepositParams memory params = _baseCreateParams();
        _createAsOffRamper(params);
        IProtocolViewer.DepositView memory depositView = viewer.getDeposit(0);
        assertEq(depositView.deposit.depositor, offRamper);
        assertEq(address(depositView.deposit.token), address(token));
        assertEq(depositView.deposit.intentAmountRange.min, params.intentAmountRange.min);
        assertEq(depositView.deposit.intentAmountRange.max, params.intentAmountRange.max);
        assertTrue(depositView.deposit.acceptingIntents);
        assertEq(depositView.deposit.delegate, offRamperDelegate);
        assertEq(depositView.deposit.intentGuardian, address(0));
        assertEq(depositView.paymentMethods.length, 1);
        assertEq(depositView.paymentMethods[0].paymentMethod, VENMO);
        assertEq(depositView.paymentMethods[0].verificationData.intentGatingService, gatingService);
        assertEq(depositView.paymentMethods[0].verificationData.payeeDetails, PAYEE);
        assertEq(depositView.paymentMethods[0].currencies.length, 2);
        assertEq(depositView.paymentMethods[0].currencies[0].code, USD);
        assertEq(depositView.paymentMethods[0].currencies[0].minConversionRate, 1.01e18);
        assertEq(depositView.paymentMethods[0].currencies[1].code, EUR);
        assertEq(depositView.paymentMethods[0].currencies[1].minConversionRate, 0.95e18);
    }

    function test_CreateDepositAddsIdToAccountDeposits() public {
        _createAsOffRamper(_baseCreateParams());
        uint256[] memory ids = escrow.getAccountDeposits(offRamper);
        assertEq(ids.length, 1);
        assertEq(ids[0], 0);
    }

    function test_CreateDepositIncrementsCounter() public {
        uint256 beforeCounter = escrow.depositCounter();
        _createAsOffRamper(_baseCreateParams());
        assertEq(escrow.depositCounter(), beforeCounter + 1);
    }

    function test_CreateDepositStoresPaymentMethodData() public {
        _createAsOffRamper(_baseCreateParams());
        IEscrow.DepositPaymentMethodData memory data = escrow.getDepositPaymentMethodData(0, VENMO);
        assertEq(data.intentGatingService, gatingService);
        assertEq(data.payeeDetails, PAYEE);
        assertEq(data.data, "");
    }

    function test_CreateDepositMarksPaymentMethodActive() public {
        _createAsOffRamper(_baseCreateParams());
        assertTrue(escrow.getDepositPaymentMethodActive(0, VENMO));
    }

    function test_CreateDepositMarksPaymentMethodListed() public {
        _createAsOffRamper(_baseCreateParams());
        assertTrue(escrow.getDepositPaymentMethodListed(0, VENMO));
    }

    function test_CreateDepositStoresRetainOnEmpty() public {
        _createAsOffRamper(_baseCreateParams());
        assertTrue(escrow.getDeposit(0).retainOnEmpty);
    }

    function test_CreateDepositStoresEveryCurrencyMinimumRate() public {
        _createAsOffRamper(_baseCreateParams());
        assertEq(escrow.getDepositCurrencyMinRate(0, VENMO, USD), 1.01e18);
        assertEq(escrow.getDepositCurrencyMinRate(0, VENMO, EUR), 0.95e18);
    }

    function test_CreateDepositMarksCurrencyListed() public {
        _createAsOffRamper(_baseCreateParams());
        assertTrue(escrow.getDepositCurrencyListed(0, VENMO, USD));
    }

    function test_CreateDepositEmitsDepositReceived() public {
        IEscrow.CreateDepositParams memory params = _baseCreateParams();
        vm.expectEmit(true, true, true, true, address(escrow));
        emit DepositReceived(
            0, offRamper, address(token), params.amount, params.intentAmountRange, offRamperDelegate, address(0)
        );
        _createAsOffRamper(params);
    }

    function test_CreateDepositEmitsPaymentMethodAdded() public {
        vm.expectEmit(true, true, true, true, address(escrow));
        emit DepositPaymentMethodAdded(0, VENMO, PAYEE, gatingService);
        _createAsOffRamper(_baseCreateParams());
    }

    function test_CreateDepositEmitsEveryCurrencyAddedInOrder() public {
        vm.recordLogs();
        _createAsOffRamper(_baseCreateParams());
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 signature = keccak256("DepositCurrencyAdded(uint256,bytes32,bytes32,uint256)");
        uint256 found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(escrow) || logs[i].topics[0] != signature) continue;
            assertEq(uint256(logs[i].topics[1]), 0);
            assertEq(logs[i].topics[2], VENMO);
            assertEq(logs[i].topics[3], found == 0 ? USD : EUR);
            assertEq(abi.decode(logs[i].data, (uint256)), found == 0 ? 1.01e18 : 0.95e18);
            ++found;
        }
        assertEq(found, 2);
    }

    function test_CreateDepositStoresAllMultiplePaymentMethodMappings() public {
        _createAsOffRamper(_multipleMethodParams());
        IEscrow.DepositPaymentMethodData memory venmoData = escrow.getDepositPaymentMethodData(0, VENMO);
        IEscrow.DepositPaymentMethodData memory paypalData = escrow.getDepositPaymentMethodData(0, PAYPAL);
        assertEq(venmoData.intentGatingService, gatingService);
        assertEq(venmoData.payeeDetails, bytes32("test"));
        assertEq(paypalData.intentGatingService, gatingService);
        assertEq(paypalData.payeeDetails, bytes32("test2"));
        assertEq(escrow.getDepositCurrencyMinRate(0, VENMO, USD), 1.01e18);
        assertEq(escrow.getDepositCurrencyMinRate(0, VENMO, EUR), 0.92e18);
        assertEq(escrow.getDepositCurrencyMinRate(0, PAYPAL, USD), 1.02e18);
    }

    function test_CreateDepositActivatesAllMultiplePaymentMethods() public {
        _createAsOffRamper(_multipleMethodParams());
        assertTrue(escrow.getDepositPaymentMethodActive(0, VENMO));
        assertTrue(escrow.getDepositPaymentMethodActive(0, PAYPAL));
    }

    function test_CreateDepositRejectsZeroIntentMinimum() public {
        IEscrow.CreateDepositParams memory params = _baseCreateParams();
        params.intentAmountRange.min = 0;
        vm.expectRevert(IEscrow.ZeroMinValue.selector);
        _createAsOffRamper(params);
    }

    function test_CreateDepositRejectsMinimumAboveMaximum() public {
        IEscrow.CreateDepositParams memory params = _baseCreateParams();
        params.intentAmountRange = IEscrow.Range({min: 2e6, max: 1e6});
        vm.expectRevert(abi.encodeWithSelector(IEscrow.InvalidRange.selector, 2e6, 1e6));
        _createAsOffRamper(params);
    }

    function test_CreateDepositRejectsAmountBelowMinimum() public {
        IEscrow.CreateDepositParams memory params = _baseCreateParams();
        params.amount = 1e6;
        params.intentAmountRange.min = 2e6;
        vm.expectRevert(abi.encodeWithSelector(IEscrow.AmountBelowMin.selector, 1e6, 2e6));
        _createAsOffRamper(params);
    }

    function test_CreateDepositRejectsPaymentMethodDataLengthMismatch() public {
        IEscrow.CreateDepositParams memory params = _baseCreateParams();
        params.paymentMethods = new bytes32[](2);
        params.paymentMethods[0] = VENMO;
        params.paymentMethods[1] = PAYPAL;
        vm.expectRevert(abi.encodeWithSelector(IEscrow.ArrayLengthMismatch.selector, 2, 1));
        _createAsOffRamper(params);
    }

    function test_CreateDepositRejectsCurrencyArrayLengthMismatch() public {
        IEscrow.CreateDepositParams memory params = _multipleMethodParams();
        IEscrow.Currency[][] memory oneCurrencyGroup = new IEscrow.Currency[][](1);
        oneCurrencyGroup[0] = params.currencies[0];
        params.currencies = oneCurrencyGroup;
        vm.expectRevert(abi.encodeWithSelector(IEscrow.ArrayLengthMismatch.selector, 2, 1));
        _createAsOffRamper(params);
    }

    function test_CreateDepositRejectsUnsupportedCurrency() public {
        IEscrow.CreateDepositParams memory params = _baseCreateParams();
        params.currencies[0][0].code = AED;
        vm.expectRevert(abi.encodeWithSelector(IEscrow.CurrencyNotSupported.selector, VENMO, AED));
        _createAsOffRamper(params);
    }

    function test_CreateDepositRejectsZeroConversionRate() public {
        IEscrow.CreateDepositParams memory params = _baseCreateParams();
        params.currencies[0][0].minConversionRate = 0;
        vm.expectRevert(IEscrow.ZeroConversionRate.selector);
        _createAsOffRamper(params);
    }

    function test_CreateDepositRejectsZeroPaymentMethod() public {
        IEscrow.CreateDepositParams memory params = _baseCreateParams();
        params.paymentMethods[0] = bytes32(0);
        vm.expectRevert(IEscrow.ZeroAddress.selector);
        _createAsOffRamper(params);
    }

    function test_CreateDepositRejectsUnwhitelistedPaymentMethod() public {
        IEscrow.CreateDepositParams memory params = _baseCreateParams();
        bytes32 unknown = keccak256("unknown");
        params.paymentMethods[0] = unknown;
        vm.expectRevert(abi.encodeWithSelector(IEscrow.PaymentMethodNotWhitelisted.selector, unknown));
        _createAsOffRamper(params);
    }

    function test_CreateDepositRejectsEmptyPayeeDetails() public {
        IEscrow.CreateDepositParams memory params = _baseCreateParams();
        params.paymentMethodData[0].payeeDetails = bytes32(0);
        vm.expectRevert(IEscrow.EmptyPayeeDetails.selector);
        _createAsOffRamper(params);
    }

    function test_CreateDepositRejectsDuplicatePaymentMethods() public {
        IEscrow.CreateDepositParams memory params = _multipleMethodParams();
        params.paymentMethods[1] = VENMO;
        vm.expectRevert(abi.encodeWithSelector(IEscrow.PaymentMethodAlreadyExists.selector, 0, VENMO));
        _createAsOffRamper(params);
    }

    function test_CreateDepositRejectsDuplicateCurrencies() public {
        IEscrow.CreateDepositParams memory params = _baseCreateParams();
        params.currencies[0][1] = IEscrow.Currency({code: USD, minConversionRate: 1.02e18});
        vm.expectRevert(abi.encodeWithSelector(IEscrow.CurrencyAlreadyExists.selector, VENMO, USD));
        _createAsOffRamper(params);
    }

    function test_CreateDepositRejectsWhilePaused() public {
        escrow.pauseEscrow();
        vm.expectRevert("Pausable: paused");
        _createAsOffRamper(_baseCreateParams());
    }
}

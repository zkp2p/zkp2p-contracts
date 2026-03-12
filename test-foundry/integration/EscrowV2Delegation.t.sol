// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {EscrowV2} from "../../contracts/EscrowV2.sol";
import {IEscrowV2} from "../../contracts/interfaces/IEscrowV2.sol";
import {RateManagerMock} from "../../contracts/mocks/RateManagerMock.sol";
import {ReentrantRateManagerMock} from "../../contracts/mocks/ReentrantRateManagerMock.sol";
import {StaticOracleAdapterMock} from "../../contracts/mocks/StaticOracleAdapterMock.sol";
import {ProtocolV2TestBase} from "../helpers/ProtocolV2TestBase.sol";

contract EscrowV2DelegationTest is ProtocolV2TestBase {
    bytes32 internal constant RATE_MANAGER_ID = bytes32("manager-1");

    RateManagerMock internal rateManagerMock;
    StaticOracleAdapterMock internal staticOracleAdapter;
    address internal managerFeeRecipient;

    function setUp() public {
        _setUpV2Core();
        managerFeeRecipient = makeAddr("managerFeeRecipient");
        rateManagerMock = new RateManagerMock();
        staticOracleAdapter = new StaticOracleAdapterMock();

        _createDepositWithRate(500e6, 1e18);

        rateManagerMock.setManager(RATE_MANAGER_ID, true);
        rateManagerMock.setFee(RATE_MANAGER_ID, managerFeeRecipient, 0.01e18);
        rateManagerMock.setRate(RATE_MANAGER_ID, address(escrow), 0, VENMO, USD, 1.2e18);
    }

    function test_setRateManagerStoresDelegatedManagerConfig() public {
        vm.prank(depositor);
        escrow.setRateManager(0, address(rateManagerMock), RATE_MANAGER_ID);

        (address rateManager, bytes32 rateManagerId) = escrow.getDepositRateManager(0);
        assertEq(rateManager, address(rateManagerMock));
        assertEq(rateManagerId, RATE_MANAGER_ID);
    }

    function test_setRateManagerRevertsWhenAlreadySet() public {
        vm.prank(depositor);
        escrow.setRateManager(0, address(rateManagerMock), RATE_MANAGER_ID);

        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.RateManagerAlreadySet.selector, RATE_MANAGER_ID));
        vm.prank(depositor);
        escrow.setRateManager(0, address(rateManagerMock), RATE_MANAGER_ID);
    }

    function test_setRateManagerRevertsWhenCallerIsDelegate() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.UnauthorizedCaller.selector, delegate, depositor));
        vm.prank(delegate);
        escrow.setRateManager(0, address(rateManagerMock), RATE_MANAGER_ID);
    }

    function test_setRateManagerRevertsWhenManagerRejectsOptIn() public {
        rateManagerMock.setShouldRevertOnOptIn(true);

        vm.expectRevert(RateManagerMock.OptInRejected.selector);
        vm.prank(depositor);
        escrow.setRateManager(0, address(rateManagerMock), RATE_MANAGER_ID);
    }

    function test_setRateManagerBlocksReentrantManager() public {
        ReentrantRateManagerMock reentrantManager = new ReentrantRateManagerMock(address(escrow));
        reentrantManager.setAttackParams(bytes32("attack-manager"));

        vm.prank(depositor);
        escrow.setRateManager(0, address(reentrantManager), RATE_MANAGER_ID);

        assertTrue(reentrantManager.reentryAttempted());
        assertFalse(reentrantManager.reentrySucceeded());

        (address rateManager, bytes32 rateManagerId) = escrow.getDepositRateManager(0);
        assertEq(rateManager, address(reentrantManager));
        assertEq(rateManagerId, RATE_MANAGER_ID);
    }

    function test_clearRateManagerClearsDelegatedManagerConfig() public {
        vm.prank(depositor);
        escrow.setRateManager(0, address(rateManagerMock), RATE_MANAGER_ID);

        vm.prank(depositor);
        escrow.clearRateManager(0);

        (address rateManager, bytes32 rateManagerId) = escrow.getDepositRateManager(0);
        assertEq(rateManager, address(0));
        assertEq(rateManagerId, bytes32(0));
    }

    function test_clearRateManagerRevertsWhenCallerIsUnauthorized() public {
        vm.prank(depositor);
        escrow.setRateManager(0, address(rateManagerMock), RATE_MANAGER_ID);

        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.UnauthorizedCaller.selector, takerA, depositor));
        vm.prank(takerA);
        escrow.clearRateManager(0);
    }

    function test_getEffectiveRateReturnsNativeRateWhenDepositIsNotDelegated() public view {
        assertEq(escrow.getEffectiveRate(0, VENMO, USD), 1e18);
    }

    function test_getEffectiveRatePassesThroughToDelegatedManager() public {
        vm.prank(depositor);
        escrow.setRateManager(0, address(rateManagerMock), RATE_MANAGER_ID);

        assertEq(escrow.getEffectiveRate(0, VENMO, USD), 1.2e18);
    }

    function test_getEffectiveRateReturnsNativeRateAfterClear() public {
        vm.prank(depositor);
        escrow.setRateManager(0, address(rateManagerMock), RATE_MANAGER_ID);
        vm.prank(depositor);
        escrow.clearRateManager(0);

        assertEq(escrow.getEffectiveRate(0, VENMO, USD), 1e18);
    }

    function test_getEffectiveRateFallsBackToEscrowFloorWhenManagerReverts() public {
        vm.prank(depositor);
        escrow.setRateManager(0, address(rateManagerMock), RATE_MANAGER_ID);
        rateManagerMock.setShouldRevertOnGetRate(true);

        assertEq(escrow.getEffectiveRate(0, VENMO, USD), 1e18);
    }

    function test_getEffectiveRateReturnsEscrowFloorWhenManagerRateIsBelowFloor() public {
        rateManagerMock.setRate(RATE_MANAGER_ID, address(escrow), 0, VENMO, USD, 0.9e18);

        vm.prank(depositor);
        escrow.setRateManager(0, address(rateManagerMock), RATE_MANAGER_ID);

        assertEq(escrow.getEffectiveRate(0, VENMO, USD), 1e18);
    }

    function test_getEffectiveRateReturnsZeroWhenEscrowFloorIsZero() public {
        vm.prank(depositor);
        escrow.setRateManager(0, address(rateManagerMock), RATE_MANAGER_ID);
        vm.prank(depositor);
        escrow.deactivateCurrency(0, VENMO, USD);

        assertEq(escrow.getEffectiveRate(0, VENMO, USD), 0);
    }

    function test_getEffectiveRateReturnsZeroWhenDelegatedManagerReturnsZero() public {
        rateManagerMock.setRate(RATE_MANAGER_ID, address(escrow), 0, VENMO, USD, 0);

        vm.prank(depositor);
        escrow.setRateManager(0, address(rateManagerMock), RATE_MANAGER_ID);

        assertEq(escrow.getEffectiveRate(0, VENMO, USD), 0);
    }

    function test_getEffectiveRateReturnsZeroWhenOracleConfiguredButStale() public {
        vm.warp(1_000);
        bytes memory adapterConfig = abi.encode(true, 1.3e18, block.timestamp - 100);

        vm.prank(depositor);
        escrow.setOracleRateConfig(
            0,
            VENMO,
            USD,
            IEscrowV2.OracleRateConfig({
                adapter: address(staticOracleAdapter),
                adapterConfig: adapterConfig,
                spreadBps: 0,
                maxStaleness: 5
            })
        );
        vm.prank(depositor);
        escrow.setRateManager(0, address(rateManagerMock), RATE_MANAGER_ID);

        assertEq(escrow.getEffectiveRate(0, VENMO, USD), 0);
    }

    function test_getEffectiveRateReturnsMaxOfManagerRateAndEscrowFloor() public {
        rateManagerMock.setRate(RATE_MANAGER_ID, address(escrow), 0, VENMO, USD, 1.5e18);

        vm.prank(depositor);
        escrow.setRateManager(0, address(rateManagerMock), RATE_MANAGER_ID);

        assertEq(escrow.getEffectiveRate(0, VENMO, USD), 1.5e18);
    }

    function test_getEffectiveRateReturnsEscrowFloorWhenManagerRateEqualsFloor() public {
        rateManagerMock.setRate(RATE_MANAGER_ID, address(escrow), 0, VENMO, USD, 1e18);

        vm.prank(depositor);
        escrow.setRateManager(0, address(rateManagerMock), RATE_MANAGER_ID);

        assertEq(escrow.getEffectiveRate(0, VENMO, USD), 1e18);
    }

    function test_getManagerFeeReturnsZeroFeeWhenNotDelegated() public view {
        (address recipient, uint256 fee) = escrow.getManagerFee(0);
        assertEq(recipient, address(0));
        assertEq(fee, 0);
    }

    function test_getManagerFeeReturnsDelegatedManagerFee() public {
        vm.prank(depositor);
        escrow.setRateManager(0, address(rateManagerMock), RATE_MANAGER_ID);

        (address recipient, uint256 fee) = escrow.getManagerFee(0);
        assertEq(recipient, managerFeeRecipient);
        assertEq(fee, 0.01e18);
    }

    function test_getManagerFeeReturnsZeroFeeWhenDelegatedManagerReverts() public {
        vm.prank(depositor);
        escrow.setRateManager(0, address(rateManagerMock), RATE_MANAGER_ID);
        rateManagerMock.setShouldRevertOnGetFee(true);

        (address recipient, uint256 fee) = escrow.getManagerFee(0);
        assertEq(recipient, address(0));
        assertEq(fee, 0);
    }

    function _createDepositWithRate(uint256 amount, uint256 minConversionRate) internal returns (uint256 depositId) {
        IEscrowV2.CreateDepositParams memory params = IEscrowV2.CreateDepositParams({
            token: IERC20(address(usdc)),
            amount: amount,
            intentAmountRange: IEscrowV2.Range({min: 10e6, max: 200e6}),
            paymentMethods: _singlePaymentMethods(VENMO),
            paymentMethodData: _singlePaymentMethodData(address(0), keccak256("payee"), ""),
            currencies: _singleDepositCurrencies(USD, minConversionRate),
            delegate: delegate,
            intentGuardian: address(0),
            retainOnEmpty: false
        });

        vm.prank(depositor);
        escrow.createDeposit(params);
        depositId = escrow.depositCounter() - 1;
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {EscrowV2} from "contracts/EscrowV2.sol";
import {PaymentVerifierMock} from "contracts/mocks/PaymentVerifierMock.sol";
import {RateManagerMock} from "contracts/mocks/RateManagerMock.sol";
import {ReentrantRateManagerMock} from "contracts/mocks/ReentrantRateManagerMock.sol";
import {StaticOracleAdapterMock} from "contracts/mocks/StaticOracleAdapterMock.sol";
import {USDCMock} from "contracts/mocks/USDCMock.sol";
import {OrchestratorRegistry} from "contracts/registries/OrchestratorRegistry.sol";
import {PaymentVerifierRegistry} from "contracts/registries/PaymentVerifierRegistry.sol";
import {IEscrowV2} from "contracts/interfaces/IEscrowV2.sol";

contract EscrowV2DelegationTest is Test {
    event DepositRateManagerSet(uint256 indexed depositId, address indexed rateManager, bytes32 indexed rateManagerId);
    event DepositRateManagerCleared(
        uint256 indexed depositId, address indexed rateManager, bytes32 indexed rateManagerId
    );
    event OptedIn(address indexed escrow, uint256 indexed depositId, bytes32 rateManagerId);

    bytes32 internal constant METHOD = keccak256("venmo");
    bytes32 internal constant USD = keccak256("USD");
    bytes32 internal constant PAYEE = keccak256("payee");
    bytes32 internal constant MANAGER_ID = bytes32("manager-1");

    address internal depositor;
    address internal delegate;
    address internal other;
    address internal feeRecipient;
    EscrowV2 internal escrow;
    RateManagerMock internal managerMock;
    StaticOracleAdapterMock internal oracleAdapter;
    USDCMock internal token;

    function setUp() public {
        depositor = makeAddr("depositor");
        delegate = makeAddr("delegate");
        other = makeAddr("other");
        feeRecipient = makeAddr("feeRecipient");
        token = new USDCMock(1_000_000_000e6, "USDC", "USDC");
        token.transfer(depositor, 100_000e6);
        PaymentVerifierRegistry paymentVerifierRegistry = new PaymentVerifierRegistry();
        OrchestratorRegistry orchestratorRegistry = new OrchestratorRegistry();
        PaymentVerifierMock verifier = new PaymentVerifierMock();
        managerMock = new RateManagerMock();
        oracleAdapter = new StaticOracleAdapterMock();
        bytes32[] memory currencies = new bytes32[](1);
        currencies[0] = USD;
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
        _createDeposit();
        vm.stopPrank();
        managerMock.setManager(MANAGER_ID, true);
        managerMock.setFee(MANAGER_ID, feeRecipient, 1e16);
        managerMock.setRate(MANAGER_ID, address(escrow), 0, METHOD, USD, 1.2e18);
    }

    function _createDeposit() internal {
        bytes32[] memory methods = new bytes32[](1);
        methods[0] = METHOD;
        IEscrowV2.DepositPaymentMethodData[] memory methodData = new IEscrowV2.DepositPaymentMethodData[](1);
        methodData[0] =
            IEscrowV2.DepositPaymentMethodData({intentGatingService: address(0), payeeDetails: PAYEE, data: ""});
        IEscrowV2.Currency[][] memory currencies = new IEscrowV2.Currency[][](1);
        currencies[0] = new IEscrowV2.Currency[](1);
        currencies[0][0] = IEscrowV2.Currency({
            code: USD,
            minConversionRate: 1e18,
            oracleRateConfig: IEscrowV2.OracleRateConfig({
                adapter: address(0), adapterConfig: "", spreadBps: 0, maxStaleness: 0
            })
        });
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

    function _setManager(address caller, address managerAddress, bytes32 id) internal {
        vm.prank(caller);
        escrow.setRateManager(0, managerAddress, id);
    }

    function _clearManager(address caller) internal {
        vm.prank(caller);
        escrow.clearRateManager(0);
    }

    function _delegate() internal {
        _setManager(depositor, address(managerMock), MANAGER_ID);
    }

    function test_SetRateManagerStoresConfigAndEmits() public {
        vm.expectEmit(true, true, true, true, address(escrow));
        emit DepositRateManagerSet(0, address(managerMock), MANAGER_ID);
        _delegate();
        (address managerAddress, bytes32 id) = escrow.getDepositRateManager(0);
        assertEq(managerAddress, address(managerMock));
        assertEq(id, MANAGER_ID);
    }

    function test_SetRateManagerCallsOptInCallback() public {
        vm.expectEmit(true, true, false, true, address(managerMock));
        emit OptedIn(address(escrow), 0, MANAGER_ID);
        _delegate();
    }

    function test_SetRateManagerRejectsExistingManager() public {
        _delegate();
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.RateManagerAlreadySet.selector, MANAGER_ID));
        _delegate();
    }

    function test_SetRateManagerRejectsDelegate() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.UnauthorizedCaller.selector, delegate, depositor));
        _setManager(delegate, address(managerMock), MANAGER_ID);
    }

    function test_SetRateManagerPropagatesOptInRejectionAtomically() public {
        managerMock.setShouldRevertOnOptIn(true);
        vm.expectRevert(RateManagerMock.OptInRejected.selector);
        _delegate();
        (address managerAddress, bytes32 id) = escrow.getDepositRateManager(0);
        assertEq(managerAddress, address(0));
        assertEq(id, bytes32(0));
    }

    function test_SetRateManagerWritesStateBeforeReentrantOptIn() public {
        ReentrantRateManagerMock reentrantManager = new ReentrantRateManagerMock(address(escrow));
        reentrantManager.setAttackParams(bytes32("attack-manager"));
        _setManager(depositor, address(reentrantManager), MANAGER_ID);
        assertTrue(reentrantManager.reentryAttempted());
        assertFalse(reentrantManager.reentrySucceeded());
        (address managerAddress, bytes32 id) = escrow.getDepositRateManager(0);
        assertEq(managerAddress, address(reentrantManager));
        assertEq(id, MANAGER_ID);
    }

    function test_ClearRateManagerDeletesConfigAndEmitsPriorValues() public {
        _delegate();
        vm.expectEmit(true, true, true, true, address(escrow));
        emit DepositRateManagerCleared(0, address(managerMock), MANAGER_ID);
        _clearManager(depositor);
        (address managerAddress, bytes32 id) = escrow.getDepositRateManager(0);
        assertEq(managerAddress, address(0));
        assertEq(id, bytes32(0));
    }

    function test_ClearRateManagerRejectsNonDepositor() public {
        _delegate();
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.UnauthorizedCaller.selector, other, depositor));
        _clearManager(other);
    }

    function test_EffectiveRateUsesNativeRateWithoutDelegation() public view {
        assertEq(escrow.getEffectiveRate(0, METHOD, USD), 1e18);
    }

    function test_EffectiveRateUsesDelegatedRate() public {
        _delegate();
        assertEq(escrow.getEffectiveRate(0, METHOD, USD), 1.2e18);
    }

    function test_EffectiveRateReturnsNativeRateAfterClear() public {
        _delegate();
        _clearManager(depositor);
        assertEq(escrow.getEffectiveRate(0, METHOD, USD), 1e18);
    }

    function test_EffectiveRateFallsBackToFloorWhenManagerReverts() public {
        _delegate();
        managerMock.setShouldRevertOnGetRate(true);
        assertEq(escrow.getEffectiveRate(0, METHOD, USD), 1e18);
    }

    function test_EffectiveRateUsesFloorWhenManagerBelowFloor() public {
        managerMock.setRate(MANAGER_ID, address(escrow), 0, METHOD, USD, 0.9e18);
        _delegate();
        assertEq(escrow.getEffectiveRate(0, METHOD, USD), 1e18);
    }

    function test_EffectiveRateIsZeroWhenCurrencyDeactivated() public {
        _delegate();
        vm.prank(depositor);
        escrow.deactivateCurrency(0, METHOD, USD);
        assertEq(escrow.getEffectiveRate(0, METHOD, USD), 0);
    }

    function test_EffectiveRateIsZeroWhenManagerDisablesPair() public {
        managerMock.setRate(MANAGER_ID, address(escrow), 0, METHOD, USD, 0);
        _delegate();
        assertEq(escrow.getEffectiveRate(0, METHOD, USD), 0);
    }

    function test_EffectiveRateIsZeroWhenConfiguredOracleIsStale() public {
        vm.warp(1_000);
        vm.prank(depositor);
        escrow.setOracleRateConfig(
            0,
            METHOD,
            USD,
            IEscrowV2.OracleRateConfig({
                adapter: address(oracleAdapter),
                adapterConfig: abi.encode(true, 1.3e18, block.timestamp - 100),
                spreadBps: 0,
                maxStaleness: 5
            })
        );
        _delegate();
        assertEq(escrow.getEffectiveRate(0, METHOD, USD), 0);
    }

    function test_EffectiveRateReturnsMaximumOfManagerAndFloor() public {
        managerMock.setRate(MANAGER_ID, address(escrow), 0, METHOD, USD, 1.5e18);
        _delegate();
        assertEq(escrow.getEffectiveRate(0, METHOD, USD), 1.5e18);
    }

    function test_EffectiveRateReturnsFloorWhenManagerEqualsFloor() public {
        managerMock.setRate(MANAGER_ID, address(escrow), 0, METHOD, USD, 1e18);
        _delegate();
        assertEq(escrow.getEffectiveRate(0, METHOD, USD), 1e18);
    }

    function test_ManagerFeeIsZeroWithoutDelegation() public view {
        (address recipient, uint256 fee) = escrow.getManagerFee(0);
        assertEq(recipient, address(0));
        assertEq(fee, 0);
    }

    function test_ManagerFeeUsesDelegatedManager() public {
        _delegate();
        (address recipient, uint256 fee) = escrow.getManagerFee(0);
        assertEq(recipient, feeRecipient);
        assertEq(fee, 1e16);
    }

    function test_ManagerFeeIsZeroWhenManagerReverts() public {
        _delegate();
        managerMock.setShouldRevertOnGetFee(true);
        (address recipient, uint256 fee) = escrow.getManagerFee(0);
        assertEq(recipient, address(0));
        assertEq(fee, 0);
    }
}

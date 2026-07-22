// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {EscrowV2} from "contracts/EscrowV2.sol";
import {PaymentVerifierMock} from "contracts/mocks/PaymentVerifierMock.sol";
import {StaticOracleAdapterMock} from "contracts/mocks/StaticOracleAdapterMock.sol";
import {USDCMock} from "contracts/mocks/USDCMock.sol";
import {OrchestratorRegistry} from "contracts/registries/OrchestratorRegistry.sol";
import {PaymentVerifierRegistry} from "contracts/registries/PaymentVerifierRegistry.sol";
import {IEscrowV2} from "contracts/interfaces/IEscrowV2.sol";

contract EscrowV2CurrencyRateTest is Test {
    bytes32 internal constant METHOD = keccak256("venmo");
    bytes32 internal constant USD = keccak256("USD");
    bytes32 internal constant PAYEE = keccak256("payee");
    bytes32 internal constant MIN_RATE_EVENT =
        keccak256("DepositMinConversionRateUpdated(uint256,bytes32,bytes32,uint256)");
    bytes32 internal constant ORACLE_REMOVED_EVENT =
        keccak256("DepositOracleRateConfigRemoved(uint256,bytes32,bytes32)");

    address internal depositor;
    USDCMock internal token;
    EscrowV2 internal escrow;
    StaticOracleAdapterMock internal adapter;

    function setUp() public {
        depositor = makeAddr("depositor");
        token = new USDCMock(1_000_000_000e6, "USDC", "USDC");
        token.transfer(depositor, 100_000e6);
        PaymentVerifierRegistry paymentVerifierRegistry = new PaymentVerifierRegistry();
        OrchestratorRegistry orchestratorRegistry = new OrchestratorRegistry();
        PaymentVerifierMock verifier = new PaymentVerifierMock();
        adapter = new StaticOracleAdapterMock();

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
                delegate: address(0),
                intentGuardian: address(0),
                retainOnEmpty: false
            })
        );
    }

    function _setOracleRate(uint256 rate, int16 spreadBps, uint32 maxStaleness, uint256 updatedAt) internal {
        bytes memory adapterConfig = abi.encode(true, rate, updatedAt);
        vm.prank(depositor);
        escrow.setOracleRateConfig(
            0,
            METHOD,
            USD,
            IEscrowV2.OracleRateConfig({
                adapter: address(adapter),
                adapterConfig: adapterConfig,
                spreadBps: spreadBps,
                maxStaleness: maxStaleness
            })
        );
    }

    function _setFixed(uint256 rate) internal {
        vm.prank(depositor);
        escrow.setCurrencyMinRate(0, METHOD, USD, rate);
    }

    function _deactivate() internal {
        vm.prank(depositor);
        escrow.deactivateCurrency(0, METHOD, USD);
    }

    function _spread(uint256 rate, uint256 multiplierBps) internal pure returns (uint256) {
        return (rate * multiplierBps + 9_999) / 10_000;
    }

    function test_ReturnsFixedRateWhenOnlyFixedSourceConfigured() public view {
        assertEq(escrow.getDepositCurrencyMinRate(0, METHOD, USD), 1e18);
    }

    function test_ReturnsSpreadRateWhenFixedFloorIsZero() public {
        _setOracleRate(1.2e18, 100, 3600, block.timestamp);
        _setFixed(0);
        assertEq(escrow.getDepositCurrencyMinRate(0, METHOD, USD), _spread(1.2e18, 10_100));
    }

    function test_ReturnsMaximumOfFixedAndSpreadRates() public {
        _setOracleRate(1.1e18, 0, 3600, block.timestamp);
        _setFixed(1.2e18);
        assertEq(escrow.getDepositCurrencyMinRate(0, METHOD, USD), 1.2e18);
    }

    function test_ReturnsBelowMarketFloorForNegativeSpread() public {
        _setOracleRate(1.1e18, -300, 3600, block.timestamp);
        _setFixed(0);
        assertEq(escrow.getDepositCurrencyMinRate(0, METHOD, USD), _spread(1.1e18, 9_700));
    }

    function test_StaleConfiguredOracleHaltsRateAtZero() public {
        vm.warp(1_000);
        _setOracleRate(1.3e18, 0, 5, block.timestamp - 100);
        assertEq(escrow.getDepositCurrencyMinRate(0, METHOD, USD), 0);
    }

    function test_ReturnsUpdatedFixedFloorWithoutOracle() public {
        _setFixed(1.15e18);
        assertEq(escrow.getDepositCurrencyMinRate(0, METHOD, USD), 1.15e18);
    }

    function test_DeactivatedCurrencyReturnsZero() public {
        _deactivate();
        assertEq(escrow.getDepositCurrencyMinRate(0, METHOD, USD), 0);
    }

    function test_DeactivateClearsFixedAndOracleConfigAndEmitsBothEvents() public {
        _setOracleRate(1.2e18, 0, 3600, block.timestamp);
        vm.recordLogs();
        _deactivate();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool foundMinimumEvent;
        bool foundOracleEvent;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].emitter != address(escrow) || logs[i].topics.length != 4) continue;
            assertEq(uint256(logs[i].topics[1]), 0);
            assertEq(logs[i].topics[2], METHOD);
            assertEq(logs[i].topics[3], USD);
            if (logs[i].topics[0] == MIN_RATE_EVENT) {
                assertEq(abi.decode(logs[i].data, (uint256)), 0);
                foundMinimumEvent = true;
            }
            if (logs[i].topics[0] == ORACLE_REMOVED_EVENT) foundOracleEvent = true;
        }
        assertTrue(foundMinimumEvent);
        assertTrue(foundOracleEvent);
        IEscrowV2.OracleRateConfig memory config = escrow.getDepositOracleRateConfig(0, METHOD, USD);
        assertEq(config.adapter, address(0));
        assertEq(escrow.getDepositCurrencyMinRate(0, METHOD, USD), 0);
    }

    function test_DeactivatedCurrencyCanBeReenabledByFixedFloor() public {
        _deactivate();
        _setFixed(1.15e18);
        assertEq(escrow.getDepositCurrencyMinRate(0, METHOD, USD), 1.15e18);
    }

    function test_DeactivatedCurrencyCanBeReenabledByOracleConfig() public {
        _deactivate();
        _setOracleRate(1.3e18, 100, 3600, block.timestamp);
        assertEq(escrow.getDepositCurrencyMinRate(0, METHOD, USD), _spread(1.3e18, 10_100));
    }

    function test_ZeroFixedFloorKeepsCurrencyActiveWhileOracleRemains() public {
        _setOracleRate(1.1e18, 100, 3600, block.timestamp);
        _setFixed(0);
        assertEq(escrow.getDepositCurrencyMinRate(0, METHOD, USD), _spread(1.1e18, 10_100));
    }

    function test_RemovingOracleKeepsCurrencyActiveWhileFixedFloorRemains() public {
        _setOracleRate(1.3e18, 0, 3600, block.timestamp);
        _setFixed(1.25e18);
        vm.prank(depositor);
        escrow.removeOracleRateConfig(0, METHOD, USD);
        assertEq(escrow.getDepositCurrencyMinRate(0, METHOD, USD), 1.25e18);
    }
}

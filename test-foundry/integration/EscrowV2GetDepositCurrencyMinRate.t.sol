// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IEscrowV2} from "../../contracts/interfaces/IEscrowV2.sol";
import {StaticOracleAdapterMock} from "../../contracts/mocks/StaticOracleAdapterMock.sol";
import {ProtocolV2TestBase} from "../helpers/ProtocolV2TestBase.sol";

contract EscrowV2GetDepositCurrencyMinRateTest is ProtocolV2TestBase {
    StaticOracleAdapterMock internal staticOracleAdapter;

    function setUp() public {
        _setUpV2Core();
        staticOracleAdapter = new StaticOracleAdapterMock();
        _createDepositWithRate(500e6, 1e18);
    }

    function test_getDepositCurrencyMinRateReturnsFixedRateWhenOnlyFixedSourceConfigured() public view {
        assertEq(escrow.getDepositCurrencyMinRate(0, VENMO, USD), 1e18);
    }

    function test_getDepositCurrencyMinRateReturnsSpreadRateWhenFixedFloorIsZero() public {
        vm.warp(1_000);
        _setOracleRate(1.2e18, 100, 3600, block.timestamp);
        vm.prank(depositor);
        escrow.setCurrencyMinRate(0, VENMO, USD, 0);

        assertEq(escrow.getDepositCurrencyMinRate(0, VENMO, USD), _applySpread(1.2e18, 100));
    }

    function test_getDepositCurrencyMinRateReturnsMaxOfFixedAndSpread() public {
        vm.warp(1_000);
        _setOracleRate(1.1e18, 0, 3600, block.timestamp);
        vm.prank(depositor);
        escrow.setCurrencyMinRate(0, VENMO, USD, 1.2e18);

        assertEq(escrow.getDepositCurrencyMinRate(0, VENMO, USD), 1.2e18);
    }

    function test_getDepositCurrencyMinRateReturnsBelowMarketOracleFloorForNegativeSpread() public {
        vm.warp(1_000);
        _setOracleRate(1.1e18, -300, 3600, block.timestamp);
        vm.prank(depositor);
        escrow.setCurrencyMinRate(0, VENMO, USD, 0);

        assertEq(escrow.getDepositCurrencyMinRate(0, VENMO, USD), _applySpread(1.1e18, -300));
    }

    function test_getDepositCurrencyMinRateReturnsZeroWhenOracleConfiguredButStale() public {
        vm.warp(1_000);
        _setOracleRate(1.3e18, 0, 5, block.timestamp - 100);

        assertEq(escrow.getDepositCurrencyMinRate(0, VENMO, USD), 0);
    }

    function test_getDepositCurrencyMinRateReturnsFixedFloorWhenNoOracleConfigured() public {
        vm.prank(depositor);
        escrow.setCurrencyMinRate(0, VENMO, USD, 1.15e18);

        assertEq(escrow.getDepositCurrencyMinRate(0, VENMO, USD), 1.15e18);
    }

    function test_getDepositCurrencyMinRateReturnsZeroWhenCurrencyIsDeactivated() public {
        vm.prank(depositor);
        escrow.deactivateCurrency(0, VENMO, USD);

        assertEq(escrow.getDepositCurrencyMinRate(0, VENMO, USD), 0);
    }

    function test_deactivateCurrencyClearsFixedAndOracleConfig() public {
        vm.warp(1_000);
        _setOracleRate(1.2e18, 0, 3600, block.timestamp);

        vm.prank(depositor);
        escrow.deactivateCurrency(0, VENMO, USD);

        IEscrowV2.OracleRateConfig memory oracleConfig = escrow.getDepositOracleRateConfig(0, VENMO, USD);
        assertEq(oracleConfig.adapter, address(0));
        assertEq(escrow.getDepositCurrencyMinRate(0, VENMO, USD), 0);
    }

    function test_deactivateCurrencyAllowsExplicitReenableBySettingFixedFloor() public {
        vm.prank(depositor);
        escrow.deactivateCurrency(0, VENMO, USD);
        vm.prank(depositor);
        escrow.setCurrencyMinRate(0, VENMO, USD, 1.15e18);

        assertEq(escrow.getDepositCurrencyMinRate(0, VENMO, USD), 1.15e18);
    }

    function test_deactivateCurrencyAllowsExplicitReenableBySettingOracleConfig() public {
        vm.warp(1_000);
        vm.prank(depositor);
        escrow.deactivateCurrency(0, VENMO, USD);
        _setOracleRate(1.3e18, 100, 3600, block.timestamp);

        assertEq(escrow.getDepositCurrencyMinRate(0, VENMO, USD), _applySpread(1.3e18, 100));
    }

    function test_currencyRemainsActiveWhenFixedFloorIsZeroButOracleConfigRemains() public {
        vm.warp(1_000);
        _setOracleRate(1.1e18, 100, 3600, block.timestamp);

        vm.prank(depositor);
        escrow.setCurrencyMinRate(0, VENMO, USD, 0);

        assertEq(escrow.getDepositCurrencyMinRate(0, VENMO, USD), _applySpread(1.1e18, 100));
    }

    function test_currencyRemainsActiveWhenOracleConfigRemovedButFixedFloorRemains() public {
        vm.warp(1_000);
        _setOracleRate(1.3e18, 0, 3600, block.timestamp);
        vm.prank(depositor);
        escrow.setCurrencyMinRate(0, VENMO, USD, 1.25e18);
        vm.prank(depositor);
        escrow.removeOracleRateConfig(0, VENMO, USD);

        assertEq(escrow.getDepositCurrencyMinRate(0, VENMO, USD), 1.25e18);
    }

    function _setOracleRate(uint256 rate, int16 spreadBps, uint32 maxStaleness, uint256 updatedAt) internal {
        bytes memory adapterConfig = abi.encode(true, rate, updatedAt);

        vm.prank(depositor);
        escrow.setOracleRateConfig(
            0,
            VENMO,
            USD,
            IEscrowV2.OracleRateConfig({
                adapter: address(staticOracleAdapter),
                adapterConfig: adapterConfig,
                spreadBps: spreadBps,
                maxStaleness: maxStaleness
            })
        );
    }

    function _createDepositWithRate(uint256 amount, uint256 minConversionRate) internal returns (uint256 depositId) {
        IEscrowV2.CreateDepositParams memory params = IEscrowV2.CreateDepositParams({
            token: IERC20(address(usdc)),
            amount: amount,
            intentAmountRange: IEscrowV2.Range({min: 10e6, max: 200e6}),
            paymentMethods: _singlePaymentMethods(VENMO),
            paymentMethodData: _singlePaymentMethodData(address(0), keccak256("payee"), ""),
            currencies: _singleDepositCurrencies(USD, minConversionRate),
            delegate: address(0),
            intentGuardian: address(0),
            retainOnEmpty: false
        });

        vm.prank(depositor);
        escrow.createDeposit(params);
        depositId = escrow.depositCounter() - 1;
    }

    function _applySpread(uint256 rate, int16 spreadBps) internal pure returns (uint256) {
        int256 basisPoints = int256(uint256(10_000)) + spreadBps;
        return (rate * uint256(basisPoints) + 9_999) / 10_000;
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IEscrowV2} from "../../contracts/interfaces/IEscrowV2.sol";
import {PythMock} from "../../contracts/mocks/PythMock.sol";
import {PythOracleAdapter} from "../../contracts/oracles/PythOracleAdapter.sol";
import {ProtocolV2TestBase} from "../helpers/ProtocolV2TestBase.sol";

contract EscrowV2PythOracleTest is ProtocolV2TestBase {
    bytes32 internal constant FEED_ID = keccak256("USD/INR");

    PythMock internal pythMock;
    PythOracleAdapter internal pythAdapter;

    function setUp() public {
        _setUpV2Core();
        pythMock = new PythMock();
        pythAdapter = new PythOracleAdapter(address(pythMock));

        vm.warp(1_000);
        pythMock.setPrice(FEED_ID, 8_347_500, 100, -5, block.timestamp);

        _createDepositWithConfig(500e6, 1e18, _emptyOracleRateConfig());
    }

    function test_setOracleRateConfigReturnsCorrectSpreadRate() public {
        vm.prank(depositor);
        escrow.setOracleRateConfig(
            0,
            VENMO,
            USD,
            IEscrowV2.OracleRateConfig({
                adapter: address(pythAdapter),
                adapterConfig: _encodePythRawConfig(FEED_ID, false),
                spreadBps: 50,
                maxStaleness: 3600
            })
        );

        assertEq(escrow.getDepositCurrencyMinRate(0, VENMO, USD), _applySpread(_pythRate(8_347_500), 50));
    }

    function test_setOracleRateConfigReturnsMaxOfFixedAndPythSpreadRate() public {
        vm.prank(depositor);
        escrow.setCurrencyMinRate(0, VENMO, USD, 100e18);
        vm.prank(depositor);
        escrow.setOracleRateConfig(
            0,
            VENMO,
            USD,
            IEscrowV2.OracleRateConfig({
                adapter: address(pythAdapter),
                adapterConfig: _encodePythRawConfig(FEED_ID, false),
                spreadBps: 50,
                maxStaleness: 3600
            })
        );

        assertEq(escrow.getDepositCurrencyMinRate(0, VENMO, USD), 100e18);
    }

    function test_setOracleRateConfigReturnsZeroWhenPythPriceIsStale() public {
        vm.prank(depositor);
        escrow.setOracleRateConfig(
            0,
            VENMO,
            USD,
            IEscrowV2.OracleRateConfig({
                adapter: address(pythAdapter),
                adapterConfig: _encodePythRawConfig(FEED_ID, false),
                spreadBps: 50,
                maxStaleness: 3600
            })
        );

        vm.warp(block.timestamp + 7_200);
        assertEq(escrow.getDepositCurrencyMinRate(0, VENMO, USD), 0);
    }

    function test_setOracleRateConfigUpdatesEffectiveRateWhenMockPriceChanges() public {
        vm.prank(depositor);
        escrow.setOracleRateConfig(
            0,
            VENMO,
            USD,
            IEscrowV2.OracleRateConfig({
                adapter: address(pythAdapter),
                adapterConfig: _encodePythRawConfig(FEED_ID, false),
                spreadBps: 0,
                maxStaleness: 3600
            })
        );

        assertEq(escrow.getDepositCurrencyMinRate(0, VENMO, USD), _pythRate(8_347_500));

        vm.warp(block.timestamp + 1);
        pythMock.setPrice(FEED_ID, 8_400_000, 100, -5, block.timestamp);

        assertEq(escrow.getDepositCurrencyMinRate(0, VENMO, USD), _pythRate(8_400_000));
    }

    function test_createDepositInlineConfigStoresPythOracleConfig() public {
        IEscrowV2.OracleRateConfig memory oracleRateConfig = IEscrowV2.OracleRateConfig({
            adapter: address(pythAdapter),
            adapterConfig: _encodePythRawConfig(FEED_ID, false),
            spreadBps: 100,
            maxStaleness: 3600
        });

        uint256 depositId = _createDepositWithConfig(200e6, 1e18, oracleRateConfig);
        IEscrowV2.OracleRateConfig memory storedConfig = escrow.getDepositOracleRateConfig(depositId, VENMO, USD);

        assertEq(storedConfig.adapter, address(pythAdapter));
        assertEq(storedConfig.spreadBps, 100);
        assertEq(storedConfig.maxStaleness, 3600);
    }

    function _createDepositWithConfig(
        uint256 amount,
        uint256 minConversionRate,
        IEscrowV2.OracleRateConfig memory oracleRateConfig
    ) internal returns (uint256 depositId) {
        IEscrowV2.Currency[] memory currencies = new IEscrowV2.Currency[](1);
        currencies[0] = IEscrowV2.Currency({
            code: USD,
            minConversionRate: minConversionRate,
            oracleRateConfig: oracleRateConfig
        });

        IEscrowV2.Currency[][] memory currenciesByMethod = new IEscrowV2.Currency[][](1);
        currenciesByMethod[0] = currencies;

        IEscrowV2.CreateDepositParams memory params = IEscrowV2.CreateDepositParams({
            token: IERC20(address(usdc)),
            amount: amount,
            intentAmountRange: IEscrowV2.Range({min: 10e6, max: 200e6}),
            paymentMethods: _singlePaymentMethods(VENMO),
            paymentMethodData: _singlePaymentMethodData(address(0), keccak256("payee"), ""),
            currencies: currenciesByMethod,
            delegate: delegate,
            intentGuardian: address(0),
            retainOnEmpty: false
        });

        vm.prank(depositor);
        escrow.createDeposit(params);
        depositId = escrow.depositCounter() - 1;
    }

    function _encodePythRawConfig(bytes32 feedId, bool invert) internal pure returns (bytes memory) {
        return abi.encode(feedId, invert);
    }

    function _emptyOracleRateConfig() internal pure returns (IEscrowV2.OracleRateConfig memory oracleRateConfig) {
        oracleRateConfig = IEscrowV2.OracleRateConfig({
            adapter: address(0),
            adapterConfig: "",
            spreadBps: 0,
            maxStaleness: 0
        });
    }

    function _pythRate(int64 price) internal pure returns (uint256) {
        return uint256(uint64(price)) * 1e18 / 1e5;
    }

    function _applySpread(uint256 rate, int16 spreadBps) internal pure returns (uint256) {
        return (rate * uint256(int256(uint256(10_000)) + spreadBps) + 9_999) / 10_000;
    }
}

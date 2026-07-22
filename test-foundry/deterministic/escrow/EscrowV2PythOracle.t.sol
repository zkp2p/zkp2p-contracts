// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {EscrowV2} from "contracts/EscrowV2.sol";
import {PaymentVerifierMock} from "contracts/mocks/PaymentVerifierMock.sol";
import {PythMock} from "contracts/mocks/PythMock.sol";
import {USDCMock} from "contracts/mocks/USDCMock.sol";
import {PythOracleAdapter} from "contracts/oracles/PythOracleAdapter.sol";
import {OrchestratorRegistry} from "contracts/registries/OrchestratorRegistry.sol";
import {PaymentVerifierRegistry} from "contracts/registries/PaymentVerifierRegistry.sol";
import {IEscrowV2} from "contracts/interfaces/IEscrowV2.sol";

contract EscrowV2PythOracleTest is Test {
    uint256 internal constant ORACLE_RATE = 8_347_500 * 1e18 / 1e5;
    bytes32 internal constant METHOD = keccak256("venmo");
    bytes32 internal constant USD = keccak256("USD");
    bytes32 internal constant PAYEE = keccak256("payee");
    bytes32 internal constant FEED_ID = keccak256("USD/INR");
    bytes32 internal constant CONFIG_EVENT_SIGNATURE =
        keccak256("DepositOracleRateConfigSet(uint256,bytes32,bytes32,address,bytes,int16,uint32)");

    address internal depositor;
    address internal delegate;
    USDCMock internal token;
    EscrowV2 internal escrow;
    PythMock internal pyth;
    PythOracleAdapter internal adapter;

    function setUp() public {
        depositor = makeAddr("depositor");
        delegate = makeAddr("delegate");
        token = new USDCMock(1_000_000_000e6, "USDC", "USDC");
        token.transfer(depositor, 100_000e6);
        PaymentVerifierRegistry paymentVerifierRegistry = new PaymentVerifierRegistry();
        OrchestratorRegistry orchestratorRegistry = new OrchestratorRegistry();
        PaymentVerifierMock verifier = new PaymentVerifierMock();
        pyth = new PythMock();
        adapter = new PythOracleAdapter(address(pyth));

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
        pyth.setPrice(FEED_ID, 8_347_500, 100, -5, block.timestamp);

        vm.startPrank(depositor);
        token.approve(address(escrow), 100_000e6);
        _createDeposit(500e6, _emptyOracleConfig(), delegate);
        vm.stopPrank();
    }

    function _rawConfig() internal pure returns (bytes memory) {
        return abi.encode(FEED_ID, false);
    }

    function _emptyOracleConfig() internal pure returns (IEscrowV2.OracleRateConfig memory) {
        return IEscrowV2.OracleRateConfig({adapter: address(0), adapterConfig: "", spreadBps: 0, maxStaleness: 0});
    }

    function _pythConfig(int16 spreadBps) internal view returns (IEscrowV2.OracleRateConfig memory) {
        return IEscrowV2.OracleRateConfig({
            adapter: address(adapter), adapterConfig: _rawConfig(), spreadBps: spreadBps, maxStaleness: 3600
        });
    }

    function _createDeposit(uint256 amount, IEscrowV2.OracleRateConfig memory oracleConfig, address depositDelegate)
        internal
    {
        bytes32[] memory methods = new bytes32[](1);
        methods[0] = METHOD;
        IEscrowV2.DepositPaymentMethodData[] memory methodData = new IEscrowV2.DepositPaymentMethodData[](1);
        methodData[0] =
            IEscrowV2.DepositPaymentMethodData({intentGatingService: address(0), payeeDetails: PAYEE, data: ""});
        IEscrowV2.Currency[][] memory currencies = new IEscrowV2.Currency[][](1);
        currencies[0] = new IEscrowV2.Currency[](1);
        currencies[0][0] = IEscrowV2.Currency({code: USD, minConversionRate: 1e18, oracleRateConfig: oracleConfig});
        escrow.createDeposit(
            IEscrowV2.CreateDepositParams({
                token: IERC20(address(token)),
                amount: amount,
                intentAmountRange: IEscrowV2.Range({min: 10e6, max: 200e6}),
                paymentMethods: methods,
                paymentMethodData: methodData,
                currencies: currencies,
                delegate: depositDelegate,
                intentGuardian: address(0),
                retainOnEmpty: false
            })
        );
    }

    function _setConfig(int16 spreadBps) internal {
        vm.prank(depositor);
        escrow.setOracleRateConfig(0, METHOD, USD, _pythConfig(spreadBps));
    }

    function test_SetPythConfigReturnsRoundedUpSpreadRate() public {
        bytes memory normalized = adapter.validateConfig(_rawConfig());
        assertEq(normalized.length, 34);
        _setConfig(50);
        uint256 expectedSpread = (ORACLE_RATE * 10_050 + 9_999) / 10_000;
        assertEq(escrow.getDepositCurrencyMinRate(0, METHOD, USD), expectedSpread);
    }

    function test_EffectiveRateReturnsMaximumOfFixedAndPythSpreadRate() public {
        vm.prank(depositor);
        escrow.setCurrencyMinRate(0, METHOD, USD, 100e18);
        _setConfig(50);
        assertEq(escrow.getDepositCurrencyMinRate(0, METHOD, USD), 100e18);
    }

    function test_StalePythPriceHaltsEffectiveRateAtZero() public {
        _setConfig(50);
        vm.warp(block.timestamp + 7200);
        assertEq(escrow.getDepositCurrencyMinRate(0, METHOD, USD), 0);
    }

    function test_EffectiveRateTracksFreshPythPriceUpdate() public {
        _setConfig(0);
        assertEq(escrow.getDepositCurrencyMinRate(0, METHOD, USD), ORACLE_RATE);
        pyth.setPrice(FEED_ID, 8_400_000, 100, -5, block.timestamp);
        assertEq(escrow.getDepositCurrencyMinRate(0, METHOD, USD), 8_400_000 * 1e18 / 1e5);
    }

    function test_CreateDepositStoresInlinePythConfigAndEmits() public {
        vm.recordLogs();
        vm.prank(depositor);
        _createDeposit(200e6, _pythConfig(100), address(0));
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bool foundConfigEvent;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (
                logs[i].emitter == address(escrow) && logs[i].topics.length == 4
                    && logs[i].topics[0] == CONFIG_EVENT_SIGNATURE && uint256(logs[i].topics[1]) == 1
                    && logs[i].topics[2] == METHOD && logs[i].topics[3] == USD
            ) {
                (address eventAdapter,, int16 spreadBps, uint32 maxStaleness) =
                    abi.decode(logs[i].data, (address, bytes, int16, uint32));
                assertEq(eventAdapter, address(adapter));
                assertEq(spreadBps, 100);
                assertEq(maxStaleness, 3600);
                foundConfigEvent = true;
            }
        }
        assertTrue(foundConfigEvent);

        IEscrowV2.OracleRateConfig memory stored = escrow.getDepositOracleRateConfig(1, METHOD, USD);
        assertEq(stored.adapter, address(adapter));
        assertEq(stored.spreadBps, 100);
        assertEq(stored.maxStaleness, 3600);
        assertEq(stored.adapterConfig, adapter.validateConfig(_rawConfig()));
    }
}

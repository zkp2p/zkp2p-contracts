// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {EscrowV2} from "contracts/EscrowV2.sol";
import {IEscrowV2} from "contracts/interfaces/IEscrowV2.sol";
import {AggregatorV3Mock} from "contracts/mocks/AggregatorV3Mock.sol";
import {PaymentVerifierMock} from "contracts/mocks/PaymentVerifierMock.sol";
import {USDCMock} from "contracts/mocks/USDCMock.sol";
import {ChainlinkOracleAdapter} from "contracts/oracles/ChainlinkOracleAdapter.sol";
import {FxRateFeed} from "contracts/oracles/FxRateFeed.sol";
import {FxRateStore} from "contracts/oracles/FxRateStore.sol";
import {OrchestratorRegistry} from "contracts/registries/OrchestratorRegistry.sol";
import {PaymentVerifierRegistry} from "contracts/registries/PaymentVerifierRegistry.sol";

contract FxRateFeedEscrowV2Test is Test {
    bytes32 internal constant METHOD = keccak256("venmo");
    bytes32 internal constant INR = keccak256("INR");
    bytes32 internal constant INR_USD = keccak256("INR/USD");
    bytes32 internal constant PAYEE = keccak256("payee");
    uint256 internal constant T0 = 1_000_000;
    uint256 internal constant DEPOSIT_ID = 0;

    address internal depositor;
    address internal updater;
    address internal safe;
    EscrowV2 internal escrow;
    USDCMock internal token;
    ChainlinkOracleAdapter internal chainlinkAdapter;
    FxRateStore internal store;
    FxRateFeed internal inrFeed;

    function setUp() public {
        vm.warp(T0);
        depositor = makeAddr("depositor");
        updater = makeAddr("updater");
        safe = makeAddr("safe");
        token = new USDCMock(1_000_000_000e6, "USDC", "USDC");
        token.transfer(depositor, 100_000e6);

        PaymentVerifierRegistry paymentVerifierRegistry = new PaymentVerifierRegistry();
        OrchestratorRegistry orchestratorRegistry = new OrchestratorRegistry();
        PaymentVerifierMock verifier = new PaymentVerifierMock();
        bytes32[] memory currencies = new bytes32[](1);
        currencies[0] = INR;
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

        chainlinkAdapter = new ChainlinkOracleAdapter();
        store = new FxRateStore(updater);
        store.addFeed(INR_USD, 800_000, 1_400_000);
        store.seedFeed(INR_USD, 1_041_667);
        inrFeed = new FxRateFeed(address(store), INR_USD, "INR/USD");
        store.transferOwnership(safe);
        inrFeed.transferOwnership(safe);

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
            code: INR,
            minConversionRate: 1,
            oracleRateConfig: IEscrowV2.OracleRateConfig({
                adapter: address(chainlinkAdapter),
                adapterConfig: abi.encode(address(inrFeed), true),
                spreadBps: 200,
                maxStaleness: 86_400
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

    function _expectedRate(uint256 answer) internal pure returns (uint256) {
        // Round up once for the adapter inversion and again for the escrow spread.
        uint256 invertedRate = (1e18 * 1e8 + answer - 1) / answer;
        return (invertedRate * 10_200 + 9_999) / 10_000;
    }

    function test_EffectiveRateFromFxRateFeed() public view {
        uint256 rate = escrow.getEffectiveRate(DEPOSIT_ID, METHOD, INR);
        assertEq(rate, 97_919_968_665_610_027_005);
        assertEq(rate, _expectedRate(1_041_667));
    }

    function test_EffectiveRateTracksUpdaterWrites() public {
        vm.warp(T0 + 1);
        bytes32[] memory feedIds = new bytes32[](1);
        feedIds[0] = INR_USD;
        uint64[] memory answers = new uint64[](1);
        answers[0] = 1_030_000;
        vm.prank(updater);
        store.updateRates(feedIds, answers, uint64(vm.getBlockTimestamp()));

        uint256 rate = escrow.getEffectiveRate(DEPOSIT_ID, METHOD, INR);
        assertEq(rate, 99_029_126_213_592_233_011);
        assertEq(rate, _expectedRate(1_030_000));
    }

    function test_StaleFeedHaltsPair() public {
        vm.warp(T0 + 86_401);
        assertEq(escrow.getEffectiveRate(DEPOSIT_ID, METHOD, INR), 0);
    }

    function test_EmergencyStopHaltsPair() public {
        bytes32[] memory feedIds = new bytes32[](1);
        feedIds[0] = INR_USD;
        vm.prank(safe);
        store.emergencyStop(feedIds);

        assertEq(escrow.getEffectiveRate(DEPOSIT_ID, METHOD, INR), 0);
    }

    function test_SetSourceKeepsDepositsWorking() public {
        IEscrowV2.OracleRateConfig memory beforeConfig = escrow.getDepositOracleRateConfig(DEPOSIT_ID, METHOD, INR);
        AggregatorV3Mock ext = new AggregatorV3Mock(8, 1_040_000);
        vm.prank(safe);
        inrFeed.setSource(address(ext), 0);

        uint256 rate = escrow.getEffectiveRate(DEPOSIT_ID, METHOD, INR);
        assertEq(rate, 98_076_923_076_923_076_924);
        assertEq(rate, _expectedRate(1_040_000));
        IEscrowV2.OracleRateConfig memory afterConfig = escrow.getDepositOracleRateConfig(DEPOSIT_ID, METHOD, INR);
        assertEq(afterConfig.adapter, beforeConfig.adapter);
        assertEq(afterConfig.adapterConfig, beforeConfig.adapterConfig);
        assertEq(afterConfig.spreadBps, beforeConfig.spreadBps);
        assertEq(afterConfig.maxStaleness, beforeConfig.maxStaleness);
    }
}

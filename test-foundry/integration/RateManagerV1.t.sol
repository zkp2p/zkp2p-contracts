// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {EscrowRegistry} from "../../contracts/registries/EscrowRegistry.sol";
import {RateManagerV1} from "../../contracts/RateManagerV1.sol";
import {IEscrowV2} from "../../contracts/interfaces/IEscrowV2.sol";
import {ProtocolV2TestBase} from "../helpers/ProtocolV2TestBase.sol";

contract RateManagerV1Test is ProtocolV2TestBase {
    event RateManagerCreated(
        bytes32 indexed rateManagerId,
        address indexed manager,
        address indexed feeRecipient,
        uint256 maxFee,
        uint256 fee,
        string name,
        string uri
    );
    event RateManagerConfigUpdated(
        bytes32 indexed rateManagerId, address indexed manager, address indexed feeRecipient, string name, string uri
    );
    event RateManagerFeeUpdated(bytes32 indexed rateManagerId, uint256 fee);
    event RateManagerRateUpdated(
        bytes32 indexed rateManagerId, bytes32 indexed paymentMethod, bytes32 indexed currencyCode, uint256 rate
    );
    event RateManagerRatesBatchUpdated(bytes32 indexed rateManagerId, uint256 totalUpdated);
    event MinLiquidityUpdated(bytes32 indexed rateManagerId, uint256 minLiquidity);
    event EscrowRegistryUpdated(address indexed escrowRegistry);

    bytes32 internal constant MISSING_ID = bytes32("missing-manager");
    string internal constant NAME = "PeerOne";
    string internal constant URI = "ipfs://peerone";

    RateManagerV1 internal rateManager;
    bytes32 internal rateManagerId;
    uint256 internal depositId;

    address internal manager;
    address internal other;

    function setUp() public {
        _setUpV2Core();
        manager = delegate;
        other = unauthorizedCaller;

        vm.prank(owner);
        rateManager = new RateManagerV1(address(escrowRegistry));

        depositId = _createHardhatParityDeposit();
        rateManagerId = _createRateManager(manager, feeRecipient, 0.05e18, 0.01e18, 0, NAME, URI);
    }

    function test_createRateManagerStoresConfigAndEmitsEvent() public {
        bytes32 expectedId = _expectedRateManagerId(2);

        vm.expectEmit(true, true, true, true, address(rateManager));
        emit RateManagerCreated(expectedId, manager, feeRecipient, 0.05e18, 0.01e18, "RM", "ipfs://rm");

        bytes32 createdId = _createRateManager(manager, feeRecipient, 0.05e18, 0.01e18, 0, "RM", "ipfs://rm");

        RateManagerV1.RateManagerConfig memory config = rateManager.getRateManager(createdId);
        assertEq(createdId, expectedId);
        assertEq(config.manager, manager);
        assertEq(config.feeRecipient, feeRecipient);
        assertEq(config.maxFee, 0.05e18);
        assertEq(config.fee, 0.01e18);
        assertEq(config.minLiquidity, 0);
        assertEq(config.name, "RM");
        assertEq(config.uri, "ipfs://rm");
    }

    function test_createRateManagerEmitsMinLiquidityUpdateWhenConfigured() public {
        bytes32 expectedId = _expectedRateManagerId(2);

        vm.expectEmit(true, true, true, true, address(rateManager));
        emit RateManagerCreated(expectedId, manager, feeRecipient, 0.05e18, 0.01e18, "RM", "ipfs://rm");
        vm.expectEmit(true, false, false, true, address(rateManager));
        emit MinLiquidityUpdated(expectedId, 50e6);

        _createRateManager(manager, feeRecipient, 0.05e18, 0.01e18, 50e6, "RM", "ipfs://rm");
    }

    function test_createRateManagerAllowsZeroFeeWithZeroFeeRecipient() public {
        bytes32 createdId = _createRateManager(manager, address(0), 0.05e18, 0, 0, "ZeroFee", "ipfs://zero");
        RateManagerV1.RateManagerConfig memory config = rateManager.getRateManager(createdId);

        assertEq(config.feeRecipient, address(0));
        assertEq(config.fee, 0);
    }

    function test_createRateManagerRejectsInvalidConfig() public {
        vm.expectRevert(abi.encodeWithSelector(RateManagerV1.FeeExceedsMaximum.selector, 0.06e18, 0.05e18));
        _createRateManager(manager, feeRecipient, 0.05e18, 0.06e18, 0, "RM", "ipfs://rm");

        vm.expectRevert(abi.encodeWithSelector(RateManagerV1.FeeExceedsMaximum.selector, 0.06e18, 0.05e18));
        _createRateManager(manager, feeRecipient, 0.06e18, 0.01e18, 0, "RM", "ipfs://rm");

        vm.expectRevert(RateManagerV1.ZeroAddress.selector);
        _createRateManager(address(0), feeRecipient, 0.05e18, 0.01e18, 0, "RM", "ipfs://rm");

        vm.expectRevert(RateManagerV1.ZeroAddress.selector);
        _createRateManager(manager, address(0), 0.05e18, 0.01e18, 0, "RM", "ipfs://rm");
    }

    function test_setRateUpdatesConfiguredRateAndEmitsEvent() public {
        vm.expectEmit(true, true, true, true, address(rateManager));
        emit RateManagerRateUpdated(rateManagerId, VENMO, USD, 1.1e18);

        vm.prank(manager);
        rateManager.setRate(rateManagerId, VENMO, USD, 1.1e18);

        assertEq(rateManager.getManagerRate(rateManagerId, VENMO, USD), 1.1e18);
    }

    function test_setRateRejectsUnauthorizedOrMissingManager() public {
        vm.prank(other);
        vm.expectRevert(abi.encodeWithSelector(RateManagerV1.UnauthorizedCaller.selector, other, manager));
        rateManager.setRate(rateManagerId, VENMO, USD, 1.1e18);

        vm.prank(manager);
        vm.expectRevert(abi.encodeWithSelector(RateManagerV1.RateManagerNotFound.selector, MISSING_ID));
        rateManager.setRate(MISSING_ID, VENMO, USD, 1.1e18);
    }

    function test_setRateRejectsZeroPaymentMethodOrCurrency() public {
        vm.prank(manager);
        vm.expectRevert(RateManagerV1.ZeroValue.selector);
        rateManager.setRate(rateManagerId, bytes32(0), USD, 1.1e18);

        vm.prank(manager);
        vm.expectRevert(RateManagerV1.ZeroValue.selector);
        rateManager.setRate(rateManagerId, VENMO, bytes32(0), 1.1e18);
    }

    function test_setFeeUpdatesFeeAndAllowsZeroWhenRecipientIsZero() public {
        vm.expectEmit(true, false, false, true, address(rateManager));
        emit RateManagerFeeUpdated(rateManagerId, 0.02e18);

        vm.prank(manager);
        rateManager.setFee(rateManagerId, 0.02e18);

        (address recipient, uint256 fee) = rateManager.getFee(rateManagerId);
        assertEq(recipient, feeRecipient);
        assertEq(fee, 0.02e18);

        vm.prank(manager);
        rateManager.setFee(rateManagerId, 0);
        vm.prank(manager);
        rateManager.setRateManagerConfig(rateManagerId, manager, address(0), "RM", "ipfs://rm");

        vm.expectEmit(true, false, false, true, address(rateManager));
        emit RateManagerFeeUpdated(rateManagerId, 0);

        vm.prank(manager);
        rateManager.setFee(rateManagerId, 0);
    }

    function test_setFeeRejectsInvalidUpdates() public {
        vm.prank(manager);
        vm.expectRevert(abi.encodeWithSelector(RateManagerV1.FeeExceedsMaximum.selector, 0.06e18, 0.05e18));
        rateManager.setFee(rateManagerId, 0.06e18);

        vm.prank(other);
        vm.expectRevert(abi.encodeWithSelector(RateManagerV1.UnauthorizedCaller.selector, other, manager));
        rateManager.setFee(rateManagerId, 0.02e18);

        vm.prank(manager);
        vm.expectRevert(abi.encodeWithSelector(RateManagerV1.RateManagerNotFound.selector, MISSING_ID));
        rateManager.setFee(MISSING_ID, 0.02e18);

        vm.prank(manager);
        rateManager.setFee(rateManagerId, 0);
        vm.prank(manager);
        rateManager.setRateManagerConfig(rateManagerId, manager, address(0), "RM", "ipfs://rm");

        vm.prank(manager);
        vm.expectRevert(RateManagerV1.ZeroAddress.selector);
        rateManager.setFee(rateManagerId, 0.02e18);
    }

    function test_setRateManagerConfigUpdatesMutableFields() public {
        vm.expectEmit(true, true, true, true, address(rateManager));
        emit RateManagerConfigUpdated(rateManagerId, takerA, takerB, "Updated RM", "ipfs://updated");

        vm.prank(manager);
        rateManager.setRateManagerConfig(rateManagerId, takerA, takerB, "Updated RM", "ipfs://updated");

        RateManagerV1.RateManagerConfig memory config = rateManager.getRateManager(rateManagerId);
        assertEq(config.manager, takerA);
        assertEq(config.feeRecipient, takerB);
        assertEq(config.name, "Updated RM");
        assertEq(config.uri, "ipfs://updated");
    }

    function test_setRateManagerConfigAllowsZeroFeeRecipientWhenFeeIsZero() public {
        vm.prank(manager);
        rateManager.setFee(rateManagerId, 0);

        vm.prank(manager);
        rateManager.setRateManagerConfig(rateManagerId, manager, address(0), "Updated", "ipfs://updated");

        RateManagerV1.RateManagerConfig memory config = rateManager.getRateManager(rateManagerId);
        assertEq(config.feeRecipient, address(0));
    }

    function test_setRateManagerConfigRejectsInvalidUpdates() public {
        vm.prank(manager);
        vm.expectRevert(RateManagerV1.ZeroAddress.selector);
        rateManager.setRateManagerConfig(rateManagerId, address(0), feeRecipient, "Updated", "ipfs://updated");

        vm.prank(manager);
        vm.expectRevert(RateManagerV1.ZeroAddress.selector);
        rateManager.setRateManagerConfig(rateManagerId, manager, address(0), "Updated", "ipfs://updated");

        vm.prank(other);
        vm.expectRevert(abi.encodeWithSelector(RateManagerV1.UnauthorizedCaller.selector, other, manager));
        rateManager.setRateManagerConfig(rateManagerId, manager, feeRecipient, "Updated", "ipfs://updated");

        vm.prank(manager);
        vm.expectRevert(abi.encodeWithSelector(RateManagerV1.RateManagerNotFound.selector, MISSING_ID));
        rateManager.setRateManagerConfig(MISSING_ID, manager, feeRecipient, "Updated", "ipfs://updated");
    }

    function test_setRateBatchUpdatesRatesAndEmitsAggregateEvent() public {
        bytes32[] memory paymentMethods = new bytes32[](1);
        paymentMethods[0] = VENMO;
        bytes32[][] memory currencyCodes = new bytes32[][](1);
        currencyCodes[0] = _currencyArray(USD);
        uint256[][] memory rateValues = new uint256[][](1);
        rateValues[0] = _rateArray(1.15e18);

        vm.expectEmit(true, true, true, true, address(rateManager));
        emit RateManagerRateUpdated(rateManagerId, VENMO, USD, 1.15e18);
        vm.expectEmit(true, false, false, true, address(rateManager));
        emit RateManagerRatesBatchUpdated(rateManagerId, 1);

        vm.prank(manager);
        rateManager.setRateBatch(rateManagerId, paymentMethods, currencyCodes, rateValues);

        assertEq(rateManager.getManagerRate(rateManagerId, VENMO, USD), 1.15e18);
    }

    function test_setRateBatchRejectsLengthMismatches() public {
        bytes32[] memory paymentMethods = new bytes32[](1);
        paymentMethods[0] = VENMO;
        bytes32[][] memory emptyCurrencies = new bytes32[][](0);
        uint256[][] memory emptyRates = new uint256[][](0);

        vm.prank(manager);
        vm.expectRevert(abi.encodeWithSelector(RateManagerV1.ArrayLengthMismatch.selector, 1, 0));
        rateManager.setRateBatch(rateManagerId, paymentMethods, emptyCurrencies, emptyRates);

        bytes32[][] memory oneCurrencies = new bytes32[][](1);
        oneCurrencies[0] = _currencyArray(USD);

        vm.prank(manager);
        vm.expectRevert(abi.encodeWithSelector(RateManagerV1.ArrayLengthMismatch.selector, 1, 0));
        rateManager.setRateBatch(rateManagerId, paymentMethods, oneCurrencies, emptyRates);

        uint256[][] memory mismatchRates = new uint256[][](1);
        mismatchRates[0] = new uint256[](1);
        mismatchRates[0][0] = 1.15e18;
        oneCurrencies[0] = new bytes32[](2);
        oneCurrencies[0][0] = USD;
        oneCurrencies[0][1] = bytes32("EUR");

        vm.prank(manager);
        vm.expectRevert(abi.encodeWithSelector(RateManagerV1.ArrayLengthMismatch.selector, 2, 1));
        rateManager.setRateBatch(rateManagerId, paymentMethods, oneCurrencies, mismatchRates);
    }

    function test_setRateBatchRejectsZeroValuesUnauthorizedAndMissingManager() public {
        bytes32[] memory paymentMethods = new bytes32[](1);
        paymentMethods[0] = bytes32(0);
        bytes32[][] memory currencyCodes = new bytes32[][](1);
        currencyCodes[0] = _currencyArray(USD);
        uint256[][] memory rateValues = new uint256[][](1);
        rateValues[0] = _rateArray(1.15e18);

        vm.prank(manager);
        vm.expectRevert(RateManagerV1.ZeroValue.selector);
        rateManager.setRateBatch(rateManagerId, paymentMethods, currencyCodes, rateValues);

        paymentMethods[0] = VENMO;
        currencyCodes[0][0] = bytes32(0);

        vm.prank(manager);
        vm.expectRevert(RateManagerV1.ZeroValue.selector);
        rateManager.setRateBatch(rateManagerId, paymentMethods, currencyCodes, rateValues);

        currencyCodes[0][0] = USD;

        vm.prank(other);
        vm.expectRevert(abi.encodeWithSelector(RateManagerV1.UnauthorizedCaller.selector, other, manager));
        rateManager.setRateBatch(rateManagerId, paymentMethods, currencyCodes, rateValues);

        vm.prank(manager);
        vm.expectRevert(abi.encodeWithSelector(RateManagerV1.RateManagerNotFound.selector, MISSING_ID));
        rateManager.setRateBatch(MISSING_ID, paymentMethods, currencyCodes, rateValues);
    }

    function test_getRateReturnsConfiguredValueOrZero() public {
        vm.prank(manager);
        rateManager.setRate(rateManagerId, VENMO, USD, 1.1e18);

        assertEq(rateManager.getRate(rateManagerId, address(escrow), depositId, VENMO, USD), 1.1e18);
        assertEq(rateManager.getRate(rateManagerId, address(escrow), depositId, bytes32("paypal"), USD), 0);
        assertEq(rateManager.getRate(MISSING_ID, address(escrow), depositId, VENMO, USD), 0);
    }

    function test_getRateManagerReturnsStoredConfig() public view {
        RateManagerV1.RateManagerConfig memory config = rateManager.getRateManager(rateManagerId);
        assertEq(config.manager, manager);
        assertEq(config.feeRecipient, feeRecipient);
    }

    function test_setMinLiquidityUpdatesAndCanBeCleared() public {
        vm.expectEmit(true, false, false, true, address(rateManager));
        emit MinLiquidityUpdated(rateManagerId, 100e6);

        vm.prank(manager);
        rateManager.setMinLiquidity(rateManagerId, 100e6);
        assertEq(rateManager.getRateManager(rateManagerId).minLiquidity, 100e6);

        vm.prank(manager);
        rateManager.setMinLiquidity(rateManagerId, 0);
        assertEq(rateManager.getRateManager(rateManagerId).minLiquidity, 0);
    }

    function test_setMinLiquidityRejectsUnauthorizedOrMissingManager() public {
        vm.prank(other);
        vm.expectRevert(abi.encodeWithSelector(RateManagerV1.UnauthorizedCaller.selector, other, manager));
        rateManager.setMinLiquidity(rateManagerId, 100e6);

        vm.prank(manager);
        vm.expectRevert(abi.encodeWithSelector(RateManagerV1.RateManagerNotFound.selector, MISSING_ID));
        rateManager.setMinLiquidity(MISSING_ID, 100e6);
    }

    function test_onDepositOptInEnforcesMinLiquidityThreshold() public {
        vm.prank(address(escrow));
        rateManager.onDepositOptIn(depositId, rateManagerId);

        vm.prank(manager);
        rateManager.setMinLiquidity(rateManagerId, 100e6);
        vm.prank(address(escrow));
        rateManager.onDepositOptIn(depositId, rateManagerId);

        vm.prank(manager);
        rateManager.setMinLiquidity(rateManagerId, 1_000e6);
        vm.prank(address(escrow));
        vm.expectRevert(abi.encodeWithSelector(RateManagerV1.BelowMinLiquidity.selector, 500e6, 1_000e6));
        rateManager.onDepositOptIn(depositId, rateManagerId);

        vm.prank(manager);
        rateManager.setMinLiquidity(rateManagerId, 0);
        vm.prank(address(escrow));
        rateManager.onDepositOptIn(depositId, rateManagerId);
    }

    function test_onDepositOptInRejectsUnauthorizedEscrowAndMissingManager() public {
        vm.prank(other);
        vm.expectRevert(abi.encodeWithSelector(RateManagerV1.UnauthorizedEscrow.selector, other));
        rateManager.onDepositOptIn(depositId, rateManagerId);

        vm.prank(address(escrow));
        vm.expectRevert(abi.encodeWithSelector(RateManagerV1.RateManagerNotFound.selector, MISSING_ID));
        rateManager.onDepositOptIn(depositId, MISSING_ID);
    }

    function test_onDepositOptInAllowsAcceptAllEscrows() public {
        vm.prank(owner);
        escrowRegistry.setAcceptAllEscrows(true);

        vm.prank(other);
        rateManager.onDepositOptIn(depositId, rateManagerId);
    }

    function test_onDepositOptInAllowsExplicitlyWhitelistedEscrowCaller() public {
        vm.prank(owner);
        escrowRegistry.addEscrow(owner);

        vm.prank(owner);
        rateManager.onDepositOptIn(depositId, rateManagerId);
    }

    function test_setEscrowRegistryUpdatesRegistryAndEmitsEvent() public {
        EscrowRegistry newRegistry = new EscrowRegistry();

        vm.expectEmit(true, false, false, true, address(rateManager));
        emit EscrowRegistryUpdated(address(newRegistry));

        vm.prank(owner);
        rateManager.setEscrowRegistry(address(newRegistry));

        assertEq(address(rateManager.escrowRegistry()), address(newRegistry));
    }

    function test_setEscrowRegistryRejectsNonOwnerAndZeroAddress() public {
        EscrowRegistry newRegistry = new EscrowRegistry();

        vm.prank(other);
        vm.expectRevert("Ownable: caller is not the owner");
        rateManager.setEscrowRegistry(address(newRegistry));

        vm.prank(owner);
        vm.expectRevert(RateManagerV1.ZeroAddress.selector);
        rateManager.setEscrowRegistry(address(0));
    }

    function _createRateManager(
        address managerAddress,
        address feeRecipientAddress,
        uint256 maxFee,
        uint256 fee,
        uint256 minLiquidity,
        string memory name,
        string memory uri
    ) internal returns (bytes32 createdId) {
        createdId = rateManager.createRateManager(
            RateManagerV1.RateManagerConfig({
                manager: managerAddress,
                feeRecipient: feeRecipientAddress,
                maxFee: maxFee,
                fee: fee,
                minLiquidity: minLiquidity,
                name: name,
                uri: uri
            })
        );
    }

    function _expectedRateManagerId(uint256 serial) internal view returns (bytes32 expectedId) {
        expectedId = keccak256(abi.encodePacked(address(rateManager), serial));
    }

    function _createHardhatParityDeposit() internal returns (uint256 createdDepositId) {
        IEscrowV2.CreateDepositParams memory params = IEscrowV2.CreateDepositParams({
            token: IERC20(address(usdc)),
            amount: 500e6,
            intentAmountRange: IEscrowV2.Range({min: 10e6, max: 200e6}),
            paymentMethods: _singlePaymentMethods(VENMO),
            paymentMethodData: _singlePaymentMethodData(address(0), keccak256("payee"), ""),
            currencies: _singleDepositCurrencies(USD, 1e18),
            delegate: address(0),
            intentGuardian: address(0),
            retainOnEmpty: false
        });

        vm.prank(depositor);
        escrow.createDeposit(params);
        createdDepositId = escrow.depositCounter() - 1;
    }

    function _currencyArray(bytes32 value) internal pure returns (bytes32[] memory values) {
        values = new bytes32[](1);
        values[0] = value;
    }

    function _rateArray(uint256 value) internal pure returns (uint256[] memory values) {
        values = new uint256[](1);
        values[0] = value;
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {EscrowV2} from "contracts/EscrowV2.sol";
import {RateManagerV1} from "contracts/RateManagerV1.sol";
import {PaymentVerifierMock} from "contracts/mocks/PaymentVerifierMock.sol";
import {USDCMock} from "contracts/mocks/USDCMock.sol";
import {EscrowRegistry} from "contracts/registries/EscrowRegistry.sol";
import {OrchestratorRegistry} from "contracts/registries/OrchestratorRegistry.sol";
import {PaymentVerifierRegistry} from "contracts/registries/PaymentVerifierRegistry.sol";
import {IEscrowV2} from "contracts/interfaces/IEscrowV2.sol";

contract RateManagerV1ParityTest is Test {
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

    bytes32 internal constant METHOD = keccak256("venmo");
    bytes32 internal constant USD = keccak256("USD");
    bytes32 internal constant PAYEE = keccak256("payee");
    bytes32 internal constant MISSING_ID = bytes32("missing-manager");
    uint256 internal constant MAX_FEE = 5e16;
    uint256 internal constant INITIAL_FEE = 1e16;

    address internal manager;
    address internal depositor;
    address internal feeRecipient;
    address internal other;
    EscrowRegistry internal escrowRegistry;
    RateManagerV1 internal rateManager;
    EscrowV2 internal escrow;
    USDCMock internal token;
    bytes32 internal rateManagerId;

    function setUp() public {
        manager = makeAddr("manager");
        depositor = makeAddr("depositor");
        feeRecipient = makeAddr("feeRecipient");
        other = makeAddr("other");
        escrowRegistry = new EscrowRegistry();
        rateManager = new RateManagerV1(address(escrowRegistry));

        token = new USDCMock(1_000_000_000e6, "USDC", "USDC");
        token.transfer(depositor, 100_000e6);
        PaymentVerifierRegistry paymentVerifierRegistry = new PaymentVerifierRegistry();
        OrchestratorRegistry orchestratorRegistry = new OrchestratorRegistry();
        PaymentVerifierMock verifier = new PaymentVerifierMock();
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
        escrowRegistry.addEscrow(address(escrow));
        vm.startPrank(depositor);
        token.approve(address(escrow), 100_000e6);
        _createDeposit();
        vm.stopPrank();
        rateManagerId = _createManager(manager, feeRecipient, MAX_FEE, INITIAL_FEE, 0, "PeerOne", "ipfs://peerone");
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

    function _config(
        address configManager,
        address configFeeRecipient,
        uint256 maxFee,
        uint256 fee,
        uint256 minLiquidity,
        string memory name,
        string memory uri
    ) internal pure returns (RateManagerV1.RateManagerConfig memory) {
        return RateManagerV1.RateManagerConfig({
            manager: configManager,
            feeRecipient: configFeeRecipient,
            maxFee: maxFee,
            fee: fee,
            minLiquidity: minLiquidity,
            name: name,
            uri: uri
        });
    }

    function _createManager(
        address configManager,
        address configFeeRecipient,
        uint256 maxFee,
        uint256 fee,
        uint256 minLiquidity,
        string memory name,
        string memory uri
    ) internal returns (bytes32) {
        return rateManager.createRateManager(
            _config(configManager, configFeeRecipient, maxFee, fee, minLiquidity, name, uri)
        );
    }

    function _setRate(address caller, bytes32 id, bytes32 method, bytes32 currency, uint256 rate) internal {
        vm.prank(caller);
        rateManager.setRate(id, method, currency, rate);
    }

    function _setFee(address caller, bytes32 id, uint256 fee) internal {
        vm.prank(caller);
        rateManager.setFee(id, fee);
    }

    function _setConfig(address caller, bytes32 id, address newManager, address recipient, string memory name)
        internal
    {
        vm.prank(caller);
        rateManager.setRateManagerConfig(id, newManager, recipient, name, "ipfs://updated");
    }

    function _setMin(address caller, bytes32 id, uint256 amount) internal {
        vm.prank(caller);
        rateManager.setMinLiquidity(id, amount);
    }

    function _singleBatch(bytes32 method, bytes32 currency, uint256 rate)
        internal
        pure
        returns (bytes32[] memory methods, bytes32[][] memory currencies, uint256[][] memory rates)
    {
        methods = new bytes32[](1);
        methods[0] = method;
        currencies = new bytes32[][](1);
        currencies[0] = new bytes32[](1);
        currencies[0][0] = currency;
        rates = new uint256[][](1);
        rates[0] = new uint256[](1);
        rates[0][0] = rate;
    }

    function test_CreateRateManagerEmitsAndStoresConfig() public {
        bytes32 expectedId = keccak256(abi.encodePacked(address(rateManager), uint256(2)));
        vm.expectEmit(true, true, true, true, address(rateManager));
        emit RateManagerCreated(expectedId, manager, feeRecipient, MAX_FEE, INITIAL_FEE, "RM", "ipfs://rm");
        bytes32 createdId = _createManager(manager, feeRecipient, MAX_FEE, INITIAL_FEE, 0, "RM", "ipfs://rm");
        assertEq(createdId, expectedId);
        assertTrue(rateManager.isRateManager(createdId));
    }

    function test_CreateRateManagerWithMinimumLiquidityEmitsBothEvents() public {
        bytes32 expectedId = keccak256(abi.encodePacked(address(rateManager), uint256(2)));
        vm.expectEmit(true, true, true, true, address(rateManager));
        emit RateManagerCreated(expectedId, manager, feeRecipient, MAX_FEE, INITIAL_FEE, "RM", "ipfs://rm");
        vm.expectEmit(true, false, false, true, address(rateManager));
        emit MinLiquidityUpdated(expectedId, 50e6);
        _createManager(manager, feeRecipient, MAX_FEE, INITIAL_FEE, 50e6, "RM", "ipfs://rm");
    }

    function test_CreateRejectsMaxFeeAboveGlobalCap() public {
        vm.expectRevert(abi.encodeWithSelector(RateManagerV1.FeeExceedsMaximum.selector, 6e16, MAX_FEE));
        _createManager(manager, feeRecipient, 6e16, INITIAL_FEE, 0, "RM", "ipfs://rm");
    }

    function test_CreateRejectsZeroManager() public {
        vm.expectRevert(RateManagerV1.ZeroAddress.selector);
        _createManager(address(0), feeRecipient, MAX_FEE, INITIAL_FEE, 0, "RM", "ipfs://rm");
    }

    function test_CreateRejectsZeroFeeRecipientForNonzeroFee() public {
        vm.expectRevert(RateManagerV1.ZeroAddress.selector);
        _createManager(manager, address(0), MAX_FEE, INITIAL_FEE, 0, "RM", "ipfs://rm");
    }

    function test_CreateRejectsFeeAboveManagerMaximum() public {
        vm.expectRevert(abi.encodeWithSelector(RateManagerV1.FeeExceedsMaximum.selector, 2e16, 1e16));
        _createManager(manager, feeRecipient, 1e16, 2e16, 0, "RM", "ipfs://rm");
    }

    function test_SetRateStoresRateAndEmits() public {
        vm.expectEmit(true, true, true, true, address(rateManager));
        emit RateManagerRateUpdated(rateManagerId, METHOD, USD, 1.1e18);
        _setRate(manager, rateManagerId, METHOD, USD, 1.1e18);
        assertEq(rateManager.getManagerRate(rateManagerId, METHOD, USD), 1.1e18);
    }

    function test_SetRateRejectsNonManager() public {
        vm.expectRevert(abi.encodeWithSelector(RateManagerV1.UnauthorizedCaller.selector, other, manager));
        _setRate(other, rateManagerId, METHOD, USD, 1.1e18);
    }

    function test_SetRateRejectsMissingManager() public {
        vm.expectRevert(abi.encodeWithSelector(RateManagerV1.RateManagerNotFound.selector, MISSING_ID));
        _setRate(manager, MISSING_ID, METHOD, USD, 1.1e18);
    }

    function test_SetRateRejectsZeroPaymentMethod() public {
        vm.expectRevert(RateManagerV1.ZeroValue.selector);
        _setRate(manager, rateManagerId, bytes32(0), USD, 1.1e18);
    }

    function test_SetRateRejectsZeroCurrency() public {
        vm.expectRevert(RateManagerV1.ZeroValue.selector);
        _setRate(manager, rateManagerId, METHOD, bytes32(0), 1.1e18);
    }

    function test_SetFeeUpdatesFeeAndEmits() public {
        vm.expectEmit(true, false, false, true, address(rateManager));
        emit RateManagerFeeUpdated(rateManagerId, 2e16);
        _setFee(manager, rateManagerId, 2e16);
        (address recipient, uint256 fee) = rateManager.getFee(rateManagerId);
        assertEq(recipient, feeRecipient);
        assertEq(fee, 2e16);
    }

    function test_SetFeeRejectsAboveManagerMaximum() public {
        vm.expectRevert(abi.encodeWithSelector(RateManagerV1.FeeExceedsMaximum.selector, 6e16, MAX_FEE));
        _setFee(manager, rateManagerId, 6e16);
    }

    function test_SetFeeRejectsNonManager() public {
        vm.expectRevert(abi.encodeWithSelector(RateManagerV1.UnauthorizedCaller.selector, other, manager));
        _setFee(other, rateManagerId, 2e16);
    }

    function test_SetFeeRejectsMissingManager() public {
        vm.expectRevert(abi.encodeWithSelector(RateManagerV1.RateManagerNotFound.selector, MISSING_ID));
        _setFee(manager, MISSING_ID, 2e16);
    }

    function test_SetFeeRejectsNonzeroFeeAfterRecipientRemoved() public {
        _setFee(manager, rateManagerId, 0);
        _setConfig(manager, rateManagerId, manager, address(0), "RM");
        vm.expectRevert(RateManagerV1.ZeroAddress.selector);
        _setFee(manager, rateManagerId, 2e16);
    }

    function test_SetConfigUpdatesMutableFieldsAndEmits() public {
        vm.expectEmit(true, true, true, true, address(rateManager));
        emit RateManagerConfigUpdated(rateManagerId, other, other, "Updated RM", "ipfs://updated");
        _setConfig(manager, rateManagerId, other, other, "Updated RM");
        RateManagerV1.RateManagerConfig memory config = rateManager.getRateManager(rateManagerId);
        assertEq(config.manager, other);
        assertEq(config.feeRecipient, other);
        assertEq(config.name, "Updated RM");
        assertEq(config.uri, "ipfs://updated");
        assertEq(config.maxFee, MAX_FEE);
    }

    function test_SetConfigRejectsZeroManager() public {
        vm.expectRevert(RateManagerV1.ZeroAddress.selector);
        _setConfig(manager, rateManagerId, address(0), other, "Updated RM");
    }

    function test_SetConfigRejectsZeroRecipientWhileFeeNonzero() public {
        vm.expectRevert(RateManagerV1.ZeroAddress.selector);
        _setConfig(manager, rateManagerId, other, address(0), "Updated RM");
    }

    function test_SetConfigAllowsZeroRecipientWhenFeeIsZero() public {
        _setFee(manager, rateManagerId, 0);
        _setConfig(manager, rateManagerId, other, address(0), "Updated RM");
        assertEq(rateManager.getRateManager(rateManagerId).feeRecipient, address(0));
    }

    function test_SetConfigRejectsNonManager() public {
        vm.expectRevert(abi.encodeWithSelector(RateManagerV1.UnauthorizedCaller.selector, other, manager));
        _setConfig(other, rateManagerId, other, other, "Updated RM");
    }

    function test_SetConfigRejectsMissingManager() public {
        vm.expectRevert(abi.encodeWithSelector(RateManagerV1.RateManagerNotFound.selector, MISSING_ID));
        _setConfig(manager, MISSING_ID, other, other, "Updated RM");
    }

    function test_SetRateBatchStoresRateAndEmitsAggregate() public {
        (bytes32[] memory methods, bytes32[][] memory currencies, uint256[][] memory rates) =
            _singleBatch(METHOD, USD, 1.15e18);
        vm.expectEmit(true, false, false, true, address(rateManager));
        emit RateManagerRatesBatchUpdated(rateManagerId, 1);
        vm.prank(manager);
        rateManager.setRateBatch(rateManagerId, methods, currencies, rates);
        assertEq(rateManager.getManagerRate(rateManagerId, METHOD, USD), 1.15e18);
    }

    function test_SetRateBatchRejectsMethodCurrencyOuterLengthMismatch() public {
        (bytes32[] memory methods,, uint256[][] memory rates) = _singleBatch(METHOD, USD, 1.15e18);
        bytes32[][] memory currencies = new bytes32[][](0);
        vm.expectRevert(abi.encodeWithSelector(RateManagerV1.ArrayLengthMismatch.selector, 1, 0));
        vm.prank(manager);
        rateManager.setRateBatch(rateManagerId, methods, currencies, rates);
    }

    function test_SetRateBatchRejectsMethodRateOuterLengthMismatch() public {
        (bytes32[] memory methods, bytes32[][] memory currencies,) = _singleBatch(METHOD, USD, 1.15e18);
        uint256[][] memory rates = new uint256[][](0);
        vm.expectRevert(abi.encodeWithSelector(RateManagerV1.ArrayLengthMismatch.selector, 1, 0));
        vm.prank(manager);
        rateManager.setRateBatch(rateManagerId, methods, currencies, rates);
    }

    function test_SetRateBatchRejectsInnerLengthMismatch() public {
        (bytes32[] memory methods,, uint256[][] memory rates) = _singleBatch(METHOD, USD, 1.15e18);
        bytes32[][] memory currencies = new bytes32[][](1);
        currencies[0] = new bytes32[](2);
        currencies[0][0] = USD;
        vm.expectRevert(abi.encodeWithSelector(RateManagerV1.ArrayLengthMismatch.selector, 2, 1));
        vm.prank(manager);
        rateManager.setRateBatch(rateManagerId, methods, currencies, rates);
    }

    function test_SetRateBatchRejectsZeroPaymentMethod() public {
        (bytes32[] memory methods, bytes32[][] memory currencies, uint256[][] memory rates) =
            _singleBatch(bytes32(0), USD, 1.15e18);
        vm.expectRevert(RateManagerV1.ZeroValue.selector);
        vm.prank(manager);
        rateManager.setRateBatch(rateManagerId, methods, currencies, rates);
    }

    function test_SetRateBatchRejectsZeroCurrency() public {
        (bytes32[] memory methods, bytes32[][] memory currencies, uint256[][] memory rates) =
            _singleBatch(METHOD, bytes32(0), 1.15e18);
        vm.expectRevert(RateManagerV1.ZeroValue.selector);
        vm.prank(manager);
        rateManager.setRateBatch(rateManagerId, methods, currencies, rates);
    }

    function test_SetRateBatchRejectsNonManager() public {
        (bytes32[] memory methods, bytes32[][] memory currencies, uint256[][] memory rates) =
            _singleBatch(METHOD, USD, 1.15e18);
        vm.expectRevert(abi.encodeWithSelector(RateManagerV1.UnauthorizedCaller.selector, other, manager));
        vm.prank(other);
        rateManager.setRateBatch(rateManagerId, methods, currencies, rates);
    }

    function test_SetRateBatchRejectsMissingManager() public {
        (bytes32[] memory methods, bytes32[][] memory currencies, uint256[][] memory rates) =
            _singleBatch(METHOD, USD, 1.15e18);
        vm.expectRevert(abi.encodeWithSelector(RateManagerV1.RateManagerNotFound.selector, MISSING_ID));
        vm.prank(manager);
        rateManager.setRateBatch(MISSING_ID, methods, currencies, rates);
    }

    function test_GetRateReturnsStoredManagerRate() public {
        _setRate(manager, rateManagerId, METHOD, USD, 1.1e18);
        assertEq(rateManager.getRate(rateManagerId, address(escrow), 0, METHOD, USD), 1.1e18);
    }

    function test_GetRateReturnsZeroForUnsetPair() public view {
        assertEq(rateManager.getRate(rateManagerId, address(escrow), 0, keccak256("paypal"), USD), 0);
    }

    function test_GetRateReturnsZeroForMissingManager() public view {
        assertEq(rateManager.getRate(MISSING_ID, address(escrow), 0, METHOD, USD), 0);
    }

    function test_GetRateManagerReturnsConfig() public view {
        RateManagerV1.RateManagerConfig memory config = rateManager.getRateManager(rateManagerId);
        assertEq(config.manager, manager);
        assertEq(config.feeRecipient, feeRecipient);
        assertEq(config.maxFee, MAX_FEE);
        assertEq(config.fee, INITIAL_FEE);
        assertEq(config.name, "PeerOne");
        assertEq(config.uri, "ipfs://peerone");
    }

    function test_SetMinLiquidityStoresAndEmits() public {
        vm.expectEmit(true, false, false, true, address(rateManager));
        emit MinLiquidityUpdated(rateManagerId, 100e6);
        _setMin(manager, rateManagerId, 100e6);
        assertEq(rateManager.getRateManager(rateManagerId).minLiquidity, 100e6);
    }

    function test_GetRateManagerReadsMinimumLiquidity() public {
        _setMin(manager, rateManagerId, 100e6);
        assertEq(rateManager.getRateManager(rateManagerId).minLiquidity, 100e6);
    }

    function test_SetMinLiquidityZeroClearsRequirement() public {
        _setMin(manager, rateManagerId, 100e6);
        _setMin(manager, rateManagerId, 0);
        assertEq(rateManager.getRateManager(rateManagerId).minLiquidity, 0);
    }

    function test_SetMinLiquidityRejectsNonManager() public {
        vm.expectRevert(abi.encodeWithSelector(RateManagerV1.UnauthorizedCaller.selector, other, manager));
        _setMin(other, rateManagerId, 100e6);
    }

    function test_SetMinLiquidityRejectsMissingManager() public {
        vm.expectRevert(abi.encodeWithSelector(RateManagerV1.RateManagerNotFound.selector, MISSING_ID));
        _setMin(manager, MISSING_ID, 100e6);
    }

    function test_OptInPassesWhenMinimumLiquidityDisabled() public {
        vm.prank(address(escrow));
        rateManager.onDepositOptIn(0, rateManagerId);
    }

    function test_OptInPassesWhenDepositMeetsMinimumLiquidity() public {
        _setMin(manager, rateManagerId, 100e6);
        vm.prank(address(escrow));
        rateManager.onDepositOptIn(0, rateManagerId);
    }

    function test_OptInRejectsDepositBelowMinimumLiquidity() public {
        _setMin(manager, rateManagerId, 1_000e6);
        vm.expectRevert(abi.encodeWithSelector(RateManagerV1.BelowMinLiquidity.selector, 500e6, 1_000e6));
        vm.prank(address(escrow));
        rateManager.onDepositOptIn(0, rateManagerId);
    }

    function test_OptInPassesAfterMinimumLiquidityCleared() public {
        _setMin(manager, rateManagerId, 1_000e6);
        _setMin(manager, rateManagerId, 0);
        vm.prank(address(escrow));
        rateManager.onDepositOptIn(0, rateManagerId);
    }

    function test_OptInRejectsUnlistedEscrow() public {
        vm.expectRevert(abi.encodeWithSelector(RateManagerV1.UnauthorizedEscrow.selector, other));
        vm.prank(other);
        rateManager.onDepositOptIn(0, rateManagerId);
    }

    function test_OptInPassesForWhitelistedEscrow() public {
        escrowRegistry.addEscrow(address(this));
        rateManager.onDepositOptIn(0, rateManagerId);
    }

    function test_OptInPassesWhenRegistryAcceptsAllEscrows() public {
        escrowRegistry.setAcceptAllEscrows(true);
        vm.prank(other);
        rateManager.onDepositOptIn(0, rateManagerId);
    }

    function test_SetEscrowRegistryUpdatesState() public {
        EscrowRegistry newRegistry = new EscrowRegistry();
        rateManager.setEscrowRegistry(address(newRegistry));
        assertEq(address(rateManager.escrowRegistry()), address(newRegistry));
    }

    function test_SetEscrowRegistryEmits() public {
        EscrowRegistry newRegistry = new EscrowRegistry();
        vm.expectEmit(true, false, false, true, address(rateManager));
        emit EscrowRegistryUpdated(address(newRegistry));
        rateManager.setEscrowRegistry(address(newRegistry));
    }

    function test_SetEscrowRegistryRejectsNonOwner() public {
        EscrowRegistry newRegistry = new EscrowRegistry();
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        vm.prank(other);
        rateManager.setEscrowRegistry(address(newRegistry));
    }

    function test_SetEscrowRegistryRejectsZeroAddress() public {
        vm.expectRevert(RateManagerV1.ZeroAddress.selector);
        rateManager.setEscrowRegistry(address(0));
    }
}

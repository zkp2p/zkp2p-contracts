// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IEscrowV2} from "../../contracts/interfaces/IEscrowV2.sol";
import {EscrowV2LegacyCoverageBase} from "./EscrowV2LegacyCoverageBase.sol";

contract EscrowV2BranchGuardsAndGovernanceTest is EscrowV2LegacyCoverageBase {
    uint256 internal constant MAX_DUST_THRESHOLD = 1e6;
    uint256 internal constant REENTRANCY_GUARD_SLOT = 1;
    uint256 internal constant REENTRANCY_ENTERED = 2;

    function setUp() public {
        _setUpLegacyFixture();
    }

    function test_createDepositGuardBranches() public {
        IEscrowV2.CreateDepositParams memory params = _branchCreateDepositParams(VENMO, delegate, intentGuardian);
        params.intentAmountRange = IEscrowV2.Range({min: 0, max: 100e6});

        vm.expectRevert(IEscrowV2.ZeroMinValue.selector);
        vm.prank(depositor);
        escrow.createDeposit(params);

        params = _branchCreateDepositParams(PAYPAL, depositor, address(0));

        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.CannotDelegateToSelf.selector, depositor));
        vm.prank(depositor);
        escrow.createDeposit(params);
    }

    function test_depositToGuardBranches() public {
        IEscrowV2.CreateDepositParams memory params = _branchCreateDepositParams(PAYPAL, delegate, intentGuardian);

        vm.expectRevert(IEscrowV2.ZeroAddress.selector);
        vm.prank(other);
        escrow.depositTo(address(0), params);

        params = _branchCreateDepositParams(PAYPAL, depositor, address(0));

        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.CannotDelegateToSelf.selector, depositor));
        vm.prank(other);
        escrow.depositTo(depositor, params);
    }

    function test_withdrawDepositRevertsWhenCallerIsNotDepositor() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.UnauthorizedCaller.selector, other, depositor));
        vm.prank(other);
        escrow.withdrawDeposit(depositId);
    }

    function test_withdrawDepositWithoutExpiredIntentsClosesWithoutPruning() public {
        vm.expectEmit(false, false, false, true, address(escrow));
        emit DepositClosed(depositId, depositor);

        vm.prank(depositor);
        escrow.withdrawDeposit(depositId);

        assertEq(orchestratorMock.getPruneCallCount(), 0);
        assertEq(escrow.getDeposit(depositId).depositor, address(0));
    }

    function test_removeDelegateRevertsWhenCallerIsNotDepositor() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.UnauthorizedCaller.selector, other, depositor));
        vm.prank(other);
        escrow.removeDelegate(depositId);
    }

    function test_pruneExpiredIntentsNoOpWhenNothingExpired() public {
        vm.prank(other);
        escrow.pruneExpiredIntents(depositId);

        assertEq(orchestratorMock.getPruneCallCount(), 0);
        assertEq(orchestratorMock.getLastPrunedIntents().length, 0);
    }

    function test_onlyOrchestratorUnauthorizedBranches() public {
        bytes32 directUnlockIntentHash = keccak256("direct-unlock");
        bytes32 directTransferIntentHash = keccak256("direct-transfer");

        vm.startPrank(other);

        vm.expectRevert(
            abi.encodeWithSelector(IEscrowV2.UnauthorizedCaller.selector, other, address(orchestratorRegistry))
        );
        escrow.unlockFunds(depositId, directUnlockIntentHash);

        vm.expectRevert(
            abi.encodeWithSelector(IEscrowV2.UnauthorizedCaller.selector, other, address(orchestratorRegistry))
        );
        escrow.unlockAndTransferFunds(depositId, directTransferIntentHash, 20e6, other);

        vm.stopPrank();
    }

    function test_onlyDepositorOrDelegateRevertsAcrossManagedFunctions() public {
        IEscrowV2.OracleRateConfig memory oracleConfig = _defaultOracleRateConfig();

        vm.startPrank(other);

        vm.expectRevert(_unauthorizedCallerOrDelegateError(other, depositor, delegate));
        escrow.setCurrencyMinRate(depositId, VENMO, USD, 1.1e18);

        vm.expectRevert(_unauthorizedCallerOrDelegateError(other, depositor, delegate));
        escrow.setOracleRateConfig(depositId, VENMO, USD, oracleConfig);

        vm.expectRevert(_unauthorizedCallerOrDelegateError(other, depositor, delegate));
        escrow.setOracleRateConfigBatch(
            depositId,
            _singlePaymentMethods(VENMO),
            _singleCurrencyCodeMatrix(USD),
            _singleOracleConfigMatrix(oracleConfig)
        );

        vm.expectRevert(_unauthorizedCallerOrDelegateError(other, depositor, delegate));
        escrow.updateCurrencyConfigBatch(
            depositId, _singlePaymentMethods(VENMO), _singleCurrencyRateUpdateMatrix(USD, 1.1e18, oracleConfig)
        );

        vm.expectRevert(_unauthorizedCallerOrDelegateError(other, depositor, delegate));
        escrow.removeOracleRateConfig(depositId, VENMO, USD);

        vm.expectRevert(_unauthorizedCallerOrDelegateError(other, depositor, delegate));
        escrow.setIntentRange(depositId, IEscrowV2.Range({min: 5e6, max: 300e6}));

        vm.expectRevert(_unauthorizedCallerOrDelegateError(other, depositor, delegate));
        escrow.addPaymentMethods(
            depositId,
            _singlePaymentMethods(PAYPAL),
            _singlePaymentMethodData(address(0), PAYEE_DETAILS, ""),
            _singleCurrencyMatrix(USD, 1e18)
        );

        vm.expectRevert(_unauthorizedCallerOrDelegateError(other, depositor, delegate));
        escrow.setPaymentMethodActive(depositId, VENMO, false);

        vm.expectRevert(_unauthorizedCallerOrDelegateError(other, depositor, delegate));
        escrow.addCurrencies(depositId, VENMO, _currencyList(EUR, 0.9e18));

        vm.expectRevert(_unauthorizedCallerOrDelegateError(other, depositor, delegate));
        escrow.deactivateCurrency(depositId, VENMO, USD);

        vm.expectRevert(_unauthorizedCallerOrDelegateError(other, depositor, delegate));
        escrow.deactivateCurrenciesBatch(depositId, _singlePaymentMethods(VENMO), _singleCurrencyCodeMatrix(USD));

        vm.expectRevert(_unauthorizedCallerOrDelegateError(other, depositor, delegate));
        escrow.setAcceptingIntents(depositId, false);

        vm.expectRevert(_unauthorizedCallerOrDelegateError(other, depositor, delegate));
        escrow.setRetainOnEmpty(depositId, true);

        vm.stopPrank();
    }

    function test_onlyDepositorOrDelegateRevertsWhenDelegateIsUnset() public {
        uint256 noDelegateDepositId = _createDepositWithDelegate(address(0));

        vm.expectRevert(_unauthorizedCallerOrDelegateError(other, depositor, address(0)));
        vm.prank(other);
        escrow.setCurrencyMinRate(noDelegateDepositId, PAYPAL, USD, 1.1e18);
    }

    function test_governanceSetterInvalidBranches() public {
        vm.startPrank(owner);

        vm.expectRevert(IEscrowV2.ZeroAddress.selector);
        escrow.setOrchestratorRegistry(address(0));

        vm.expectRevert(IEscrowV2.ZeroAddress.selector);
        escrow.setPaymentVerifierRegistry(address(0));

        vm.expectRevert(IEscrowV2.ZeroAddress.selector);
        escrow.setDustRecipient(address(0));

        vm.expectRevert(
            abi.encodeWithSelector(IEscrowV2.AmountAboveMax.selector, MAX_DUST_THRESHOLD + 1, MAX_DUST_THRESHOLD)
        );
        escrow.setDustThreshold(MAX_DUST_THRESHOLD + 1);

        vm.expectRevert(IEscrowV2.ZeroValue.selector);
        escrow.setMaxIntentsPerDeposit(0);

        vm.expectRevert(IEscrowV2.ZeroValue.selector);
        escrow.setIntentExpirationPeriod(0);

        vm.stopPrank();
    }

    function test_governanceSetterNonOwnerBranches() public {
        vm.startPrank(other);

        vm.expectRevert("Ownable: caller is not the owner");
        escrow.setOrchestratorRegistry(address(orchestratorRegistry));

        vm.expectRevert("Ownable: caller is not the owner");
        escrow.setPaymentVerifierRegistry(address(paymentVerifierRegistry));

        vm.expectRevert("Ownable: caller is not the owner");
        escrow.setDustRecipient(dustRecipient);

        vm.expectRevert("Ownable: caller is not the owner");
        escrow.setDustThreshold(1e6);

        vm.expectRevert("Ownable: caller is not the owner");
        escrow.setMaxIntentsPerDeposit(10);

        vm.expectRevert("Ownable: caller is not the owner");
        escrow.setIntentExpirationPeriod(7200);

        vm.expectRevert("Ownable: caller is not the owner");
        escrow.pauseEscrow();

        vm.expectRevert("Ownable: caller is not the owner");
        escrow.unpauseEscrow();

        vm.stopPrank();
    }

    function test_pausedStateBranchesForCreateDepositDepositToAndFunds() public {
        IEscrowV2.CreateDepositParams memory createParams = _branchCreateDepositParams(VENMO, delegate, intentGuardian);

        vm.prank(owner);
        escrow.pauseEscrow();

        vm.expectRevert("Pausable: paused");
        vm.prank(depositor);
        escrow.createDeposit(createParams);

        vm.expectRevert("Pausable: paused");
        vm.prank(other);
        escrow.depositTo(depositor, createParams);

        vm.expectRevert("Pausable: paused");
        vm.prank(other);
        escrow.addFunds(depositId, 10e6);

        vm.expectRevert("Pausable: paused");
        vm.prank(depositor);
        escrow.removeFunds(depositId, 10e6);
    }

    function test_pausedStateBranchesForManagedDepositFunctionsPartOne() public {
        IEscrowV2.OracleRateConfig memory oracleConfig = _defaultOracleRateConfig();

        vm.prank(owner);
        escrow.pauseEscrow();

        vm.startPrank(depositor);

        vm.expectRevert("Pausable: paused");
        escrow.setCurrencyMinRate(depositId, VENMO, USD, 1.1e18);

        vm.expectRevert("Pausable: paused");
        escrow.setOracleRateConfig(depositId, VENMO, USD, oracleConfig);

        vm.expectRevert("Pausable: paused");
        escrow.addPaymentMethods(
            depositId,
            _singlePaymentMethods(PAYPAL),
            _singlePaymentMethodData(address(0), PAYEE_DETAILS, ""),
            _singleCurrencyMatrix(USD, 1e18)
        );

        vm.expectRevert("Pausable: paused");
        escrow.addCurrencies(depositId, VENMO, _currencyList(EUR, 0.9e18));

        vm.expectRevert("Pausable: paused");
        escrow.setPaymentMethodActive(depositId, VENMO, false);

        vm.expectRevert("Pausable: paused");
        escrow.setAcceptingIntents(depositId, false);

        vm.expectRevert("Pausable: paused");
        escrow.setRetainOnEmpty(depositId, true);

        vm.expectRevert("Pausable: paused");
        escrow.setIntentRange(depositId, IEscrowV2.Range({min: 5e6, max: 300e6}));

        vm.stopPrank();
    }

    function test_pausedStateBranchesForManagedDepositFunctionsPartTwo() public {
        IEscrowV2.OracleRateConfig memory oracleConfig = _defaultOracleRateConfig();

        vm.prank(owner);
        escrow.pauseEscrow();

        vm.startPrank(depositor);

        vm.expectRevert("Pausable: paused");
        escrow.setDelegate(depositId, other);

        vm.expectRevert("Pausable: paused");
        escrow.removeDelegate(depositId);

        vm.expectRevert("Pausable: paused");
        escrow.removeOracleRateConfig(depositId, VENMO, USD);

        vm.expectRevert("Pausable: paused");
        escrow.deactivateCurrency(depositId, VENMO, USD);

        vm.expectRevert("Pausable: paused");
        escrow.setRateManager(depositId, address(rateManagerMock), RATE_MANAGER_ID);

        vm.expectRevert("Pausable: paused");
        escrow.clearRateManager(depositId);

        vm.expectRevert("Pausable: paused");
        escrow.setOracleRateConfigBatch(
            depositId,
            _singlePaymentMethods(VENMO),
            _singleCurrencyCodeMatrix(USD),
            _singleOracleConfigMatrix(oracleConfig)
        );

        vm.expectRevert("Pausable: paused");
        escrow.updateCurrencyConfigBatch(
            depositId, _singlePaymentMethods(VENMO), _singleCurrencyRateUpdateMatrix(USD, 1.1e18, oracleConfig)
        );

        vm.expectRevert("Pausable: paused");
        escrow.deactivateCurrenciesBatch(depositId, _singlePaymentMethods(VENMO), _singleCurrencyCodeMatrix(USD));

        vm.stopPrank();
    }

    function test_removeFundsRevertsWhenReentrancyGuardIsEntered() public {
        vm.store(address(escrow), bytes32(REENTRANCY_GUARD_SLOT), bytes32(REENTRANCY_ENTERED));

        vm.expectRevert("ReentrancyGuard: reentrant call");
        vm.prank(depositor);
        escrow.removeFunds(depositId, 10e6);
    }

    function _branchCreateDepositParams(bytes32 paymentMethod, address delegateAddress, address guardian)
        internal
        view
        returns (IEscrowV2.CreateDepositParams memory params)
    {
        params = IEscrowV2.CreateDepositParams({
            token: IERC20(address(usdc)),
            amount: 50e6,
            intentAmountRange: IEscrowV2.Range({min: 10e6, max: 100e6}),
            paymentMethods: _singlePaymentMethods(paymentMethod),
            paymentMethodData: _singlePaymentMethodData(address(0), PAYEE_DETAILS, ""),
            currencies: _singleCurrencyMatrix(USD, 1e18),
            delegate: delegateAddress,
            intentGuardian: guardian,
            retainOnEmpty: false
        });
    }

    function _createDepositWithDelegate(address delegateAddress) internal returns (uint256 createdDepositId) {
        IEscrowV2.CreateDepositParams memory params = _branchCreateDepositParams(PAYPAL, delegateAddress, address(0));

        vm.prank(depositor);
        escrow.createDeposit(params);

        createdDepositId = escrow.depositCounter() - 1;
    }

    function _defaultOracleRateConfig() internal view returns (IEscrowV2.OracleRateConfig memory config) {
        config = _oracleRateConfig(
            address(staticOracleAdapter), _buildOracleAdapterConfig(true, 1.2e18, block.timestamp), 100, 3600
        );
    }

    function _singleCurrencyMatrix(bytes32 currencyCode, uint256 minConversionRate)
        internal
        pure
        returns (IEscrowV2.Currency[][] memory currenciesByMethod)
    {
        currenciesByMethod = new IEscrowV2.Currency[][](1);
        currenciesByMethod[0] = new IEscrowV2.Currency[](1);
        currenciesByMethod[0][0] = IEscrowV2.Currency({
            code: currencyCode,
            minConversionRate: minConversionRate,
            oracleRateConfig: IEscrowV2.OracleRateConfig({
                adapter: address(0),
                adapterConfig: "",
                spreadBps: 0,
                maxStaleness: 0
            })
        });
    }

    function _singleCurrencyCodeMatrix(bytes32 code) internal pure returns (bytes32[][] memory codes) {
        codes = new bytes32[][](1);
        codes[0] = new bytes32[](1);
        codes[0][0] = code;
    }

    function _singleOracleConfigMatrix(IEscrowV2.OracleRateConfig memory config)
        internal
        pure
        returns (IEscrowV2.OracleRateConfig[][] memory configs)
    {
        configs = new IEscrowV2.OracleRateConfig[][](1);
        configs[0] = new IEscrowV2.OracleRateConfig[](1);
        configs[0][0] = config;
    }

    function _singleCurrencyRateUpdateMatrix(
        bytes32 code,
        uint256 minConversionRate,
        IEscrowV2.OracleRateConfig memory config
    ) internal pure returns (IEscrowV2.CurrencyRateUpdate[][] memory updates) {
        updates = new IEscrowV2.CurrencyRateUpdate[][](1);
        updates[0] = new IEscrowV2.CurrencyRateUpdate[](1);
        updates[0][0] = IEscrowV2.CurrencyRateUpdate({
            code: code,
            minConversionRate: minConversionRate,
            updateOracle: true,
            oracleRateConfig: config
        });
    }

    function _unauthorizedCallerOrDelegateError(address caller, address ownerAddress, address delegateAddress)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodeWithSelector(
            IEscrowV2.UnauthorizedCallerOrDelegate.selector, caller, ownerAddress, delegateAddress
        );
    }
}

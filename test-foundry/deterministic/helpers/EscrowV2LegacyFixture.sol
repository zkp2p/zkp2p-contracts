// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {EscrowV2} from "contracts/EscrowV2.sol";
import {OrchestratorMock} from "contracts/mocks/OrchestratorMock.sol";
import {PaymentVerifierMock} from "contracts/mocks/PaymentVerifierMock.sol";
import {RateManagerMock} from "contracts/mocks/RateManagerMock.sol";
import {RevertingOracleAdapterMock} from "contracts/mocks/RevertingOracleAdapterMock.sol";
import {RevertingPruneOrchestratorMock} from "contracts/mocks/RevertingPruneOrchestratorMock.sol";
import {StaticOracleAdapterMock} from "contracts/mocks/StaticOracleAdapterMock.sol";
import {USDCMock} from "contracts/mocks/USDCMock.sol";
import {OrchestratorRegistry} from "contracts/registries/OrchestratorRegistry.sol";
import {PaymentVerifierRegistry} from "contracts/registries/PaymentVerifierRegistry.sol";
import {IEscrowV2} from "contracts/interfaces/IEscrowV2.sol";

interface IEscrowV2Operator {
    function lockFunds(uint256 depositId, bytes32 intentHash, uint256 amount) external;
    function unlockFunds(uint256 depositId, bytes32 intentHash) external;
    function unlockAndTransferFunds(uint256 depositId, bytes32 intentHash, uint256 amount, address to) external;
}

abstract contract EscrowV2LegacyFixture is Test {
    bytes32 internal constant VENMO = keccak256("venmo");
    bytes32 internal constant PAYPAL = keccak256("paypal");
    bytes32 internal constant USD = keccak256("USD");
    bytes32 internal constant EUR = keccak256("EUR");
    bytes32 internal constant PAYEE = keccak256("payee");
    bytes32 internal constant MANAGER_ID = bytes32("manager-1");

    address internal depositor;
    address internal delegate;
    address internal other;
    address internal intentGuardian;
    address internal dustRecipient;
    USDCMock internal token;
    EscrowV2 internal escrow;
    OrchestratorRegistry internal orchestratorRegistry;
    PaymentVerifierRegistry internal paymentVerifierRegistry;
    OrchestratorMock internal orchestratorMock;
    OrchestratorMock internal secondaryOrchestratorMock;
    RevertingPruneOrchestratorMock internal revertingPruneOrchestrator;
    StaticOracleAdapterMock internal adapter;
    RevertingOracleAdapterMock internal revertingAdapter;
    RateManagerMock internal rateManagerMock;
    uint256 internal intentCounter;

    function setUp() public virtual {
        depositor = makeAddr("depositor");
        delegate = makeAddr("delegate");
        other = makeAddr("other");
        intentGuardian = makeAddr("intentGuardian");
        dustRecipient = makeAddr("dustRecipient");
        token = new USDCMock(1_000_000_000e6, "USDC", "USDC");
        token.transfer(depositor, 100_000e6);
        token.transfer(other, 10_000e6);
        paymentVerifierRegistry = new PaymentVerifierRegistry();
        orchestratorRegistry = new OrchestratorRegistry();
        PaymentVerifierMock verifier = new PaymentVerifierMock();
        PaymentVerifierMock otherVerifier = new PaymentVerifierMock();
        rateManagerMock = new RateManagerMock();
        adapter = new StaticOracleAdapterMock();
        revertingAdapter = new RevertingOracleAdapterMock();
        bytes32[] memory currencies = new bytes32[](2);
        currencies[0] = USD;
        currencies[1] = EUR;
        paymentVerifierRegistry.addPaymentMethod(VENMO, address(verifier), currencies);
        paymentVerifierRegistry.addPaymentMethod(PAYPAL, address(otherVerifier), currencies);
        escrow = new EscrowV2(
            address(this),
            1,
            address(orchestratorRegistry),
            address(paymentVerifierRegistry),
            dustRecipient,
            0,
            3,
            1 hours
        );
        orchestratorMock = new OrchestratorMock(address(escrow));
        secondaryOrchestratorMock = new OrchestratorMock(address(escrow));
        revertingPruneOrchestrator = new RevertingPruneOrchestratorMock(address(escrow));
        orchestratorRegistry.addOrchestrator(address(orchestratorMock));
        orchestratorRegistry.addOrchestrator(address(secondaryOrchestratorMock));
        orchestratorRegistry.addOrchestrator(address(revertingPruneOrchestrator));
        vm.prank(depositor);
        token.approve(address(escrow), 100_000e6);
        vm.prank(other);
        token.approve(address(escrow), 10_000e6);
        vm.startPrank(depositor);
        _createDeposit(500e6, IEscrowV2.Range({min: 10e6, max: 200e6}), 1e18, delegate, intentGuardian);
        vm.stopPrank();
    }

    function _emptyOracle() internal pure returns (IEscrowV2.OracleRateConfig memory) {
        return IEscrowV2.OracleRateConfig({adapter: address(0), adapterConfig: "", spreadBps: 0, maxStaleness: 0});
    }

    function _methodData() internal pure returns (IEscrowV2.DepositPaymentMethodData memory) {
        return IEscrowV2.DepositPaymentMethodData({intentGatingService: address(0), payeeDetails: PAYEE, data: ""});
    }

    function _createParams(
        uint256 amount,
        IEscrowV2.Range memory range,
        uint256 minimumRate,
        address depositDelegate,
        address guardian
    ) internal view returns (IEscrowV2.CreateDepositParams memory params) {
        bytes32[] memory methods = new bytes32[](1);
        methods[0] = VENMO;
        IEscrowV2.DepositPaymentMethodData[] memory methodData = new IEscrowV2.DepositPaymentMethodData[](1);
        methodData[0] = _methodData();
        IEscrowV2.Currency[][] memory currencies = new IEscrowV2.Currency[][](1);
        currencies[0] = new IEscrowV2.Currency[](1);
        currencies[0][0] =
            IEscrowV2.Currency({code: USD, minConversionRate: minimumRate, oracleRateConfig: _emptyOracle()});
        params = IEscrowV2.CreateDepositParams({
            token: IERC20(address(token)),
            amount: amount,
            intentAmountRange: range,
            paymentMethods: methods,
            paymentMethodData: methodData,
            currencies: currencies,
            delegate: depositDelegate,
            intentGuardian: guardian,
            retainOnEmpty: false
        });
    }

    function _createDeposit(
        uint256 amount,
        IEscrowV2.Range memory range,
        uint256 minimumRate,
        address depositDelegate,
        address guardian
    ) internal returns (uint256 id) {
        id = escrow.depositCounter();
        IEscrowV2.CreateDepositParams memory params =
            _createParams(amount, range, minimumRate, depositDelegate, guardian);
        escrow.createDeposit(params);
    }

    function _newIntentHash() internal returns (bytes32) {
        ++intentCounter;
        return keccak256(abi.encodePacked("intent-", intentCounter));
    }

    function _lock(address operator, uint256 amount) internal returns (bytes32 intentHash) {
        intentHash = _newIntentHash();
        IEscrowV2Operator(operator).lockFunds(0, intentHash, amount);
    }

    function _intentOrchestrator(bytes32 intentHash) internal view returns (address) {
        bytes32 slot = keccak256(abi.encode(intentHash, uint256(15)));
        return address(uint160(uint256(vm.load(address(escrow), slot))));
    }

    function _clearIntentOrchestrator(bytes32 intentHash) internal {
        vm.store(address(escrow), keccak256(abi.encode(intentHash, uint256(15))), bytes32(0));
    }

    function _oracleConfig(address configAdapter, bool valid, uint256 rate, uint256 updatedAt, int16 spread)
        internal
        pure
        returns (IEscrowV2.OracleRateConfig memory)
    {
        return IEscrowV2.OracleRateConfig({
            adapter: configAdapter,
            adapterConfig: abi.encode(valid, rate, updatedAt),
            spreadBps: spread,
            maxStaleness: 3600
        });
    }
}

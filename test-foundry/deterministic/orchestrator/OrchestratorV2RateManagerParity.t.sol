// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {EscrowV2} from "contracts/EscrowV2.sol";
import {OrchestratorV2} from "contracts/OrchestratorV2.sol";
import {PaymentVerifierMock} from "contracts/mocks/PaymentVerifierMock.sol";
import {RateManagerMock} from "contracts/mocks/RateManagerMock.sol";
import {USDCMock} from "contracts/mocks/USDCMock.sol";
import {EscrowRegistry} from "contracts/registries/EscrowRegistry.sol";
import {OrchestratorRegistry} from "contracts/registries/OrchestratorRegistry.sol";
import {PaymentVerifierRegistry} from "contracts/registries/PaymentVerifierRegistry.sol";
import {IEscrowV2} from "contracts/interfaces/IEscrowV2.sol";
import {IOrchestratorV2} from "contracts/interfaces/IOrchestratorV2.sol";
import {IPostIntentHookV2} from "contracts/interfaces/IPostIntentHookV2.sol";
import {IReferralFee} from "contracts/interfaces/IReferralFee.sol";

contract OrchestratorV2RateManagerParityTest is Test {
    event IntentManagerFeeSnapshotted(bytes32 indexed intentHash, address indexed feeRecipient, uint256 fee);

    uint256 internal constant CIRCOM_PRIME_FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 internal constant DEPOSIT_AMOUNT = 500e6;
    uint256 internal constant INTENT_AMOUNT = 50e6;
    uint256 internal constant MANAGER_RATE = 1.2e18;
    uint256 internal constant MANAGER_FEE = 0.01e18;
    bytes32 internal constant METHOD = keccak256("venmo");
    bytes32 internal constant USD = keccak256("USD");
    bytes32 internal constant PAYEE = keccak256("payee");
    bytes32 internal constant MANAGER_ID = bytes32("manager-v1");

    address internal depositor;
    address internal taker;
    address internal managerFeeRecipient;
    USDCMock internal token;
    EscrowV2 internal escrow;
    OrchestratorV2 internal orchestrator;
    PaymentVerifierMock internal verifier;
    RateManagerMock internal rateManager;

    function setUp() public {
        depositor = makeAddr("depositor");
        taker = makeAddr("taker");
        managerFeeRecipient = makeAddr("managerFeeRecipient");
        token = new USDCMock(1_000_000_000e6, "USDC", "USDC");
        token.transfer(depositor, 100_000e6);

        PaymentVerifierRegistry paymentVerifierRegistry = new PaymentVerifierRegistry();
        EscrowRegistry escrowRegistry = new EscrowRegistry();
        OrchestratorRegistry orchestratorRegistry = new OrchestratorRegistry();
        verifier = new PaymentVerifierMock();
        rateManager = new RateManagerMock();

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
        orchestrator = new OrchestratorV2(
            address(this), 1, address(escrowRegistry), address(paymentVerifierRegistry), 0, address(this)
        );
        escrowRegistry.addEscrow(address(escrow));
        orchestratorRegistry.addOrchestrator(address(orchestrator));
        verifier.setVerificationContext(address(orchestrator), address(escrow));

        vm.startPrank(depositor);
        token.approve(address(escrow), 100_000e6);
        _createDeposit();
        vm.stopPrank();

        rateManager.setManager(MANAGER_ID, true);
        rateManager.setFee(MANAGER_ID, managerFeeRecipient, MANAGER_FEE);
        rateManager.setRate(MANAGER_ID, address(escrow), 0, METHOD, USD, MANAGER_RATE);
        vm.prank(depositor);
        escrow.setRateManager(0, address(rateManager), MANAGER_ID);
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
                amount: DEPOSIT_AMOUNT,
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

    function _signal(uint256 conversionRate) internal returns (bytes32 intentHash) {
        _signalCall(conversionRate);
        bytes32[] memory hashes = orchestrator.getAccountIntents(taker);
        return hashes[hashes.length - 1];
    }

    function _signalCall(uint256 conversionRate) internal {
        IReferralFee.ReferralFee[] memory referralFees = new IReferralFee.ReferralFee[](0);
        vm.prank(taker);
        orchestrator.signalIntent(
            IOrchestratorV2.SignalIntentParams({
                escrow: address(escrow),
                depositId: 0,
                amount: INTENT_AMOUNT,
                to: taker,
                paymentMethod: METHOD,
                fiatCurrency: USD,
                conversionRate: conversionRate,
                referralFees: referralFees,
                gatingServiceSignature: "",
                signatureExpiration: 0,
                postIntentHook: IPostIntentHookV2(address(0)),
                preIntentHookData: "",
                data: ""
            })
        );
    }

    function _nextIntentHash() internal view returns (bytes32) {
        return bytes32(
            uint256(keccak256(abi.encodePacked(address(orchestrator), orchestrator.intentCounter())))
                % CIRCOM_PRIME_FIELD
        );
    }

    function test_SignalUsesDelegatedRateAndSnapshotsManagerFee() public {
        bytes32 expectedIntentHash = _nextIntentHash();
        vm.expectEmit(true, true, false, true, address(orchestrator));
        emit IntentManagerFeeSnapshotted(expectedIntentHash, managerFeeRecipient, MANAGER_FEE);
        bytes32 actualIntentHash = _signal(MANAGER_RATE);
        assertEq(actualIntentHash, expectedIntentHash);
    }

    function test_OrdinaryAccountCanKeepMultipleConcurrentIntents() public {
        bytes32 firstIntentHash = _signal(MANAGER_RATE);
        bytes32 secondIntentHash = _signal(MANAGER_RATE);
        bytes32[] memory accountIntents = orchestrator.getAccountIntents(taker);
        assertEq(accountIntents.length, 2);
        assertEq(accountIntents[0], firstIntentHash);
        assertEq(accountIntents[1], secondIntentHash);
        assertNotEq(firstIntentHash, secondIntentHash);
    }

    function test_RetiredRelayerAndGlobalMultipleIntentSelectorsAreAbsent() public {
        (bool relayerGetterSuccess,) = address(orchestrator).staticcall(abi.encodeWithSignature("relayerRegistry()"));
        (bool multipleGetterSuccess,) =
            address(orchestrator).staticcall(abi.encodeWithSignature("allowMultipleIntents()"));
        (bool relayerSetterSuccess,) =
            address(orchestrator).call(abi.encodeWithSignature("setRelayerRegistry(address)", address(this)));
        (bool multipleSetterSuccess,) =
            address(orchestrator).call(abi.encodeWithSignature("setAllowMultipleIntents(bool)", true));
        assertFalse(relayerGetterSuccess);
        assertFalse(multipleGetterSuccess);
        assertFalse(relayerSetterSuccess);
        assertFalse(multipleSetterSuccess);
    }

    function test_SignalRejectsConversionRateBelowDelegatedRate() public {
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV2.RateBelowMinimum.selector, 1.1e18, MANAGER_RATE));
        _signalCall(1.1e18);
    }

    function test_SignalRejectsDelegatedManagerFeeAboveMaximum() public {
        rateManager.setFee(MANAGER_ID, managerFeeRecipient, 0.06e18);
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV2.FeeExceedsMaximum.selector, 0.06e18, 0.05e18));
        _signalCall(MANAGER_RATE);
    }

    function test_FulfillDeductsManagerFeeAndTransfersNetAmount() public {
        bytes32 intentHash = _signal(MANAGER_RATE);
        uint256 fiatAmount = INTENT_AMOUNT * MANAGER_RATE / 1e18;
        bytes memory paymentProof = abi.encode(fiatAmount, block.timestamp, PAYEE, USD, intentHash);
        uint256 feeBalanceBefore = token.balanceOf(managerFeeRecipient);
        uint256 takerBalanceBefore = token.balanceOf(taker);

        orchestrator.fulfillIntent(
            IOrchestratorV2.FulfillIntentParams({
                paymentProof: paymentProof, intentHash: intentHash, verificationData: "", postIntentHookData: ""
            })
        );

        uint256 expectedManagerFee = INTENT_AMOUNT * MANAGER_FEE / 1e18;
        assertEq(token.balanceOf(managerFeeRecipient) - feeBalanceBefore, expectedManagerFee);
        assertEq(token.balanceOf(taker) - takerBalanceBefore, INTENT_AMOUNT - expectedManagerFee);
        assertEq(token.balanceOf(address(orchestrator)), 0);
        assertEq(orchestrator.getIntent(intentHash).owner, address(0));
    }
}

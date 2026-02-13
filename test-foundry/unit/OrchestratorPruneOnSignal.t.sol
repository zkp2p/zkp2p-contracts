// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { Test } from "forge-std/Test.sol";
import { Vm } from "forge-std/Vm.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { Orchestrator } from "../../contracts/Orchestrator.sol";
import { Escrow } from "../../contracts/Escrow.sol";
import { DepositRateManagerController } from "../../contracts/DepositRateManagerController.sol";
import { IOrchestrator } from "../../contracts/interfaces/IOrchestrator.sol";
import { IEscrow } from "../../contracts/interfaces/IEscrow.sol";
import { USDCMock } from "../../contracts/mocks/USDCMock.sol";
import { PaymentVerifierMock } from "../../contracts/mocks/PaymentVerifierMock.sol";
import { EscrowRegistry } from "../../contracts/registries/EscrowRegistry.sol";
import { PaymentVerifierRegistry } from "../../contracts/registries/PaymentVerifierRegistry.sol";
import { RelayerRegistry } from "../../contracts/registries/RelayerRegistry.sol";
import { IPostIntentHook } from "../../contracts/interfaces/IPostIntentHook.sol";

contract OrchestratorPruneOnSignalTest is Test {
    // Constants
    bytes32 constant VENMO = keccak256("VENMO");
    bytes32 constant USD = keccak256("USD");
    uint256 constant INTENT_EXPIRATION_PERIOD = 7 days;

    // Events (for expectEmit)
    event IntentPruned(bytes32 indexed intentHash);

    // Contracts
    Orchestrator public orchestrator;
    Escrow public escrow;
    USDCMock public usdc;
    PaymentVerifierRegistry public paymentVerifierRegistry;
    EscrowRegistry public escrowRegistry;
    RelayerRegistry public relayerRegistry;
    PaymentVerifierMock public venmoVerifier;
    DepositRateManagerController public rateManagerController;

    // Actors
    address public owner;
    address public depositor;
    address public takerA;
    address public takerB;
    address public protocolFeeRecipient;

    function setUp() public {
        owner = makeAddr("owner");
        depositor = makeAddr("depositor");
        takerA = makeAddr("takerA");
        takerB = makeAddr("takerB");
        protocolFeeRecipient = makeAddr("protocolFeeRecipient");

        // Token
        usdc = new USDCMock(100000000e6, "USDC", "USDC");

        // Registries
        vm.startPrank(owner);
        escrowRegistry = new EscrowRegistry();
        paymentVerifierRegistry = new PaymentVerifierRegistry();
        relayerRegistry = new RelayerRegistry();
        vm.stopPrank();

        // Orchestrator
        vm.prank(owner);
        orchestrator = new Orchestrator(
            owner,
            1,
            address(escrowRegistry),
            address(paymentVerifierRegistry),
            address(relayerRegistry),
            0, // protocol fee 0 for simplicity
            protocolFeeRecipient
        );
        vm.prank(owner);
        rateManagerController = new DepositRateManagerController();
        vm.prank(owner);
        orchestrator.setDepositRateManagerController(address(rateManagerController));

        // Escrow
        vm.prank(owner);
        escrow = new Escrow(
            owner,
            1,
            address(paymentVerifierRegistry),
            protocolFeeRecipient,
            1e4,    // dust threshold
            100,    // max intents
            INTENT_EXPIRATION_PERIOD
        );
        vm.prank(owner);
        escrow.setOrchestrator(address(orchestrator));

        // Payment verifier for VENMO
        venmoVerifier = new PaymentVerifierMock();
        venmoVerifier.setShouldVerifyPayment(true);
        venmoVerifier.setVerificationContext(address(orchestrator), address(escrow));
        bytes32[] memory currencies = new bytes32[](1);
        currencies[0] = USD;
        vm.prank(owner);
        paymentVerifierRegistry.addPaymentMethod(VENMO, address(venmoVerifier), currencies);

        // Whitelist escrow
        vm.prank(owner);
        escrowRegistry.addEscrow(address(escrow));

        // Allow multiple intents for simplicity
        vm.prank(owner);
        orchestrator.setAllowMultipleIntents(true);

        // Fund accounts & approvals
        // Ensure depositor has sufficient balance for large deposits (e.g., 100M USDC)
        deal(address(usdc), depositor, 200_000_000e6);
        vm.prank(depositor);
        usdc.approve(address(escrow), type(uint256).max);
    }

    function _createDeposit(uint256 amount, uint256 minAmt, uint256 maxAmt) internal returns (uint256 depositId) {
        IEscrow.Currency[] memory venmoCurrencies = new IEscrow.Currency[](1);
        venmoCurrencies[0] = IEscrow.Currency({ code: USD, minConversionRate: 1e18 });

        bytes32[] memory methods = new bytes32[](1);
        methods[0] = VENMO;

        IEscrow.DepositPaymentMethodData[] memory methodData = new IEscrow.DepositPaymentMethodData[](1);
        methodData[0] = IEscrow.DepositPaymentMethodData({
            intentGatingService: address(0),
            payeeDetails: keccak256("payee"),
            data: ""
        });

        IEscrow.Currency[][] memory allCurrencies = new IEscrow.Currency[][](1);
        allCurrencies[0] = venmoCurrencies;

        IEscrow.CreateDepositParams memory params = IEscrow.CreateDepositParams({
            token: IERC20(address(usdc)),
            amount: amount,
            intentAmountRange: IEscrow.Range({ min: minAmt, max: maxAmt }),
            paymentMethods: methods,
            paymentMethodData: methodData,
            currencies: allCurrencies,
            delegate: address(0),
            intentGuardian: address(0),
            retainOnEmpty: false
        });

        vm.prank(depositor);
        escrow.createDeposit(params);
        depositId = escrow.depositCounter() - 1;
    }

    function _signal(address taker, uint256 depositId, uint256 amount) internal returns (bytes32 intentHash) {
        // Record logs to capture IntentSignaled
        vm.recordLogs();
        IOrchestrator.SignalIntentParams memory p = IOrchestrator.SignalIntentParams({
            escrow: address(escrow),
            depositId: depositId,
            amount: amount,
            to: taker,
            paymentMethod: VENMO,
            fiatCurrency: USD,
            conversionRate: 1e18,
            referrer: address(0),
            referrerFee: 0,
            gatingServiceSignature: "",
            signatureExpiration: 0,
            postIntentHook: IPostIntentHook(address(0)), // zero
            preIntentHookData: "",
            data: ""
        });
        vm.prank(taker);
        orchestrator.signalIntent(p);

        Vm.Log[] memory entries = vm.getRecordedLogs();
        bytes32 sig = keccak256("IntentSignaled(bytes32,address,uint256,bytes32,address,address,uint256,bytes32,uint256,uint256)");
        for (uint256 i = 0; i < entries.length; i++) {
            if (entries[i].emitter == address(orchestrator) && entries[i].topics.length > 0 && entries[i].topics[0] == sig) {
                // topic1 is indexed intentHash
                return entries[i].topics[1];
            }
        }
        revert("IntentSignaled not found");
    }

    function test_PruneExpiredIntentOnSecondSignal() public {
        uint256 depositId = _createDeposit(100_000_000e6, 10_000_000e6, 80_000_000e6);

        // First intent by takerA for 50M
        bytes32 firstHash = _signal(takerA, depositId, 50_000_000e6);

        // Warp past expiry so the first intent is reclaimable
        vm.warp(block.timestamp + INTENT_EXPIRATION_PERIOD + 1);

        // Expect Orchestrator to emit IntentPruned for the first hash during second signal
        vm.expectEmit(true, false, false, true, address(orchestrator));
        emit IntentPruned(firstHash);

        // Second intent by takerB for 60M — should trigger reclaim + prune of first
        _signal(takerB, depositId, 60_000_000e6);

        // Old intent should be deleted from Orchestrator storage
        IOrchestrator.Intent memory deletedIntent = orchestrator.getIntent(firstHash);
        assertEq(deletedIntent.owner, address(0), "expired intent should be pruned from Orchestrator storage");
    }
}

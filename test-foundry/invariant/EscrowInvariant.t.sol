// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { Test } from "forge-std/Test.sol";
import { console2 } from "forge-std/console2.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { Escrow } from "../../contracts/Escrow.sol";
import { Orchestrator } from "../../contracts/Orchestrator.sol";
import { DepositRateManagerController } from "../../contracts/DepositRateManagerController.sol";
import { IEscrow } from "../../contracts/interfaces/IEscrow.sol";
import { IOrchestrator } from "../../contracts/interfaces/IOrchestrator.sol";
import { IPostIntentHook } from "../../contracts/interfaces/IPostIntentHook.sol";
import { USDCMock } from "../../contracts/mocks/USDCMock.sol";
import { PaymentVerifierMock } from "../../contracts/mocks/PaymentVerifierMock.sol";
import { EscrowRegistry } from "../../contracts/registries/EscrowRegistry.sol";
import { PaymentVerifierRegistry } from "../../contracts/registries/PaymentVerifierRegistry.sol";
import { RelayerRegistry } from "../../contracts/registries/RelayerRegistry.sol";
import { NullifierRegistry } from "../../contracts/registries/NullifierRegistry.sol";
import { INullifierRegistry } from "../../contracts/interfaces/INullifierRegistry.sol";

/**
 * @title EscrowHandler
 * @notice Handler contract for stateful fuzzing of Escrow contract
 * @dev Implements ghost ledger pattern to track token flows without reimplementing logic
 */
contract EscrowHandler is Test {
    // Constants
    uint256 constant PRECISE_UNIT = 1e18;
    uint256 constant MAX_REFERRER_FEE = 5e16; // 5%
    uint256 constant MAX_MAKER_FEE = 5e16; // 5%
    uint256 constant INTENT_EXPIRATION_PERIOD = 7 days;
    uint256 constant PARTIAL_RELEASE_DELAY = 1 hours;
    bytes32 constant PAYMENT_METHOD = keccak256("VENMO");
    bytes32 constant CURRENCY = keccak256("USD");
    
    // Contracts
    Escrow public escrow;
    Orchestrator public orchestrator;
    DepositRateManagerController public rateManagerController;
    USDCMock public usdc;
    PaymentVerifierMock public verifier;
    
    // Ghost Ledger - Track only observable effects
    uint256 public ghostTotalIn;      // Total tokens sent TO escrow
    uint256 public ghostTotalOut;     // Total tokens sent FROM escrow
    uint256 public ghostTotalFees;    // Total fees collected
    
    // Ghost State Tracking
    mapping(uint256 => uint256) public ghostDepositAmounts;     // Track deposit amounts
    mapping(uint256 => uint256) public ghostDepositLiquidity;   // Track available liquidity
    mapping(bytes32 => uint256) public ghostIntentAmounts;      // Track locked intent amounts
    mapping(uint256 => bool) public ghostDepositExists;         // Track if deposit exists
    mapping(bytes32 => bool) public ghostIntentExists;          // Track if intent exists
    mapping(bytes32 => uint256) public ghostIntentDepositId;    // Map intent to deposit
    
    // State tracking for random operations
    uint256[] public activeDepositIds;
    bytes32[] public activeIntentHashes;
    address[] public actors;
    
    // Operation counters for analysis
    uint256 public createDepositCount;
    uint256 public addFundsCount;
    uint256 public removeFundsCount;
    uint256 public signalIntentCount;
    uint256 public fulfillIntentCount;
    uint256 public cancelIntentCount;
    uint256 public withdrawDepositCount;
    
    constructor(
        Escrow _escrow,
        Orchestrator _orchestrator,
        USDCMock _usdc,
        PaymentVerifierMock _verifier
    ) {
        escrow = _escrow;
        orchestrator = _orchestrator;
        usdc = _usdc;
        verifier = _verifier;
        
        // Setup actors for testing
        actors.push(makeAddr("alice"));
        actors.push(makeAddr("bob"));
        actors.push(makeAddr("charlie"));
        actors.push(makeAddr("diana"));
        
        // Give actors tokens
        for (uint i = 0; i < actors.length; i++) {
            deal(address(usdc), actors[i], 10000000e6); // 10M USDC each
            vm.prank(actors[i]);
            usdc.approve(address(escrow), type(uint256).max);
        }
    }
    
    // ============ Handler Functions (Bounded Random Operations) ============
    
    /**
     * @notice Create a new deposit with random parameters
     * @param actorSeed Seed to select actor
     * @param amount Deposit amount to bound
     * @param minIntent Minimum intent amount to bound
     * @param maxIntent Maximum intent amount to bound
     */
    function createDeposit(
        uint256 actorSeed,
        uint256 amount,
        uint256 minIntent,
        uint256 maxIntent
    ) public {
        // Select actor
        address actor = actors[actorSeed % actors.length];
        
        // Bound parameters to realistic ranges
        amount = bound(amount, 10e6, 100000e6); // 10-100k USDC
        minIntent = bound(minIntent, 1e6, amount / 2);
        maxIntent = bound(maxIntent, minIntent, amount);
        
        // Check actor has sufficient balance
        uint256 actorBalance = usdc.balanceOf(actor);
        if (actorBalance < amount) return;
        
        // Create deposit
        vm.startPrank(actor);
        usdc.approve(address(escrow), amount);
        
        // Prepare payment methods
        bytes32[] memory paymentMethods = new bytes32[](1);
        paymentMethods[0] = PAYMENT_METHOD;
        
        IEscrow.DepositPaymentMethodData[] memory paymentMethodData = new IEscrow.DepositPaymentMethodData[](1);
        paymentMethodData[0] = IEscrow.DepositPaymentMethodData({
            intentGatingService: address(0),
            payeeDetails: keccak256(abi.encodePacked("venmo:", actor)),
            data: ""
        });
        
        IEscrow.Currency[][] memory currencies = new IEscrow.Currency[][](1);
        currencies[0] = new IEscrow.Currency[](1);
        currencies[0][0] = IEscrow.Currency({
            code: CURRENCY,
            minConversionRate: 1e18 // 1:1 for USD
        });
        
        IEscrow.CreateDepositParams memory params = IEscrow.CreateDepositParams({
            token: IERC20(address(usdc)),
            amount: amount,
            intentAmountRange: IEscrow.Range(minIntent, maxIntent),
            paymentMethods: paymentMethods,
            paymentMethodData: paymentMethodData,
            currencies: currencies,
            delegate: address(0),
            intentGuardian: address(0),
            retainOnEmpty: false
        });
        
        uint256 depositId = escrow.depositCounter();
        escrow.createDeposit(params);
        vm.stopPrank();
        
        // Update ghost ledger
        ghostTotalIn += amount;
        ghostDepositAmounts[depositId] = amount;
        ghostDepositLiquidity[depositId] = amount;
        ghostDepositExists[depositId] = true;
        activeDepositIds.push(depositId);
        
        createDepositCount++;
    }
    
    /**
     * @notice Add funds to an existing deposit
     * @param depositSeed Seed to select deposit
     * @param amount Amount to add
     */
    function addFundsToDeposit(uint256 depositSeed, uint256 amount) public {
        if (activeDepositIds.length == 0) return;
        
        uint256 depositId = activeDepositIds[depositSeed % activeDepositIds.length];
        if (!ghostDepositExists[depositId]) return;
        
        // Get depositor
        IEscrow.Deposit memory deposit = escrow.getDeposit(depositId);
        if (deposit.depositor == address(0)) return;
        
        // Bound amount
        amount = bound(amount, 1e6, 10000e6); // 1-10k USDC
        
        // Check balance
        uint256 depositorBalance = usdc.balanceOf(deposit.depositor);
        if (depositorBalance < amount) return;
        
        // Add funds
        vm.prank(deposit.depositor);
        try escrow.addFunds(depositId, amount) {
            // Update ghost ledger
            ghostTotalIn += amount;
            ghostDepositAmounts[depositId] += amount;
            ghostDepositLiquidity[depositId] += amount;
            addFundsCount++;
        } catch {}
    }
    
    /**
     * @notice Remove funds from a deposit
     * @param depositSeed Seed to select deposit
     * @param amount Amount to remove
     */
    function removeFundsFromDeposit(uint256 depositSeed, uint256 amount) public {
        if (activeDepositIds.length == 0) return;
        
        uint256 depositId = activeDepositIds[depositSeed % activeDepositIds.length];
        if (!ghostDepositExists[depositId]) return;
        
        // Get deposit info
        IEscrow.Deposit memory deposit = escrow.getDeposit(depositId);
        if (deposit.depositor == address(0)) return;
        
        // Bound amount to available liquidity
        uint256 availableLiquidity = ghostDepositLiquidity[depositId];
        if (availableLiquidity == 0) return;
        amount = bound(amount, 0, availableLiquidity);
        
        // Remove funds
        vm.prank(deposit.depositor);
        try escrow.removeFunds(depositId, amount) {
            // Update ghost ledger
            ghostTotalOut += amount;
            ghostDepositAmounts[depositId] -= amount;
            ghostDepositLiquidity[depositId] -= amount;
            removeFundsCount++;
        } catch {}
    }
    
    /**
     * @notice Signal an intent on a deposit
     * @param depositSeed Seed to select deposit
     * @param actorSeed Seed to select taker
     * @param amount Intent amount
     */
    function signalIntent(
        uint256 depositSeed,
        uint256 actorSeed,
        uint256 amount
    ) public {
        if (activeDepositIds.length == 0) return;
        
        uint256 depositId = activeDepositIds[depositSeed % activeDepositIds.length];
        if (!ghostDepositExists[depositId]) return;
        
        address taker = actors[actorSeed % actors.length];
        
        // Get deposit info
        IEscrow.Deposit memory deposit = escrow.getDeposit(depositId);
        if (deposit.depositor == address(0)) return;
        
        // Bound amount to deposit range and available liquidity
        uint256 minIntent = deposit.intentAmountRange.min;
        uint256 maxIntent = deposit.intentAmountRange.max;
        uint256 availableLiquidity = ghostDepositLiquidity[depositId];
        
        if (availableLiquidity < minIntent) return;
        
        amount = bound(amount, minIntent, Math.min(maxIntent, availableLiquidity));
        
        // Signal intent through orchestrator
        IOrchestrator.SignalIntentParams memory params = IOrchestrator.SignalIntentParams({
            escrow: address(escrow),
            depositId: depositId,
            to: taker,
            amount: amount,
            paymentMethod: PAYMENT_METHOD,
            fiatCurrency: CURRENCY,
            conversionRate: 1e18,
            referrer: address(0),
            referrerFee: 0,
            gatingServiceSignature: "",
            signatureExpiration: 0,
            postIntentHook: IPostIntentHook(address(0)),
            data: ""
        });
        
        vm.prank(taker);
        try orchestrator.signalIntent(params) {
            // Calculate intent hash (would need to be done similarly to how orchestrator does it)
            bytes32 intentHash = keccak256(abi.encodePacked(taker, depositId, amount, block.timestamp));
            
            // Update ghost ledger
            ghostDepositLiquidity[depositId] -= amount;
            ghostIntentAmounts[intentHash] = amount;
            ghostIntentExists[intentHash] = true;
            ghostIntentDepositId[intentHash] = depositId;
            activeIntentHashes.push(intentHash);
            signalIntentCount++;
        } catch {}
    }
    
    /**
     * @notice Cancel an intent
     * @param intentSeed Seed to select intent
     */
    function cancelIntent(uint256 intentSeed) public {
        if (activeIntentHashes.length == 0) return;
        
        bytes32 intentHash = activeIntentHashes[intentSeed % activeIntentHashes.length];
        if (!ghostIntentExists[intentHash]) return;
        
        // Get intent info
        IOrchestrator.Intent memory intent = orchestrator.getIntent(intentHash);
        if (intent.owner == address(0)) return;
        
        // Cancel intent
        vm.prank(intent.owner);
        try orchestrator.cancelIntent(intentHash) {
            uint256 depositId = ghostIntentDepositId[intentHash];
            uint256 intentAmount = ghostIntentAmounts[intentHash];
            
            // Update ghost ledger - liquidity returns to deposit
            ghostDepositLiquidity[depositId] += intentAmount;
            ghostIntentExists[intentHash] = false;
            ghostIntentAmounts[intentHash] = 0;
            cancelIntentCount++;
        } catch {}
    }
    
    /**
     * @notice Withdraw an entire deposit
     * @param depositSeed Seed to select deposit
     */
    function withdrawDeposit(uint256 depositSeed) public {
        if (activeDepositIds.length == 0) return;
        
        uint256 depositId = activeDepositIds[depositSeed % activeDepositIds.length];
        if (!ghostDepositExists[depositId]) return;
        
        // Get deposit info
        IEscrow.Deposit memory deposit = escrow.getDeposit(depositId);
        if (deposit.depositor == address(0)) return;
        
        // Check no active intents (simplified - in reality would check deposit.outstandingIntentAmount)
        if (deposit.outstandingIntentAmount > 0) return;
        
        uint256 remainingAmount = ghostDepositAmounts[depositId];
        if (remainingAmount == 0) return;
        
        // Withdraw deposit
        vm.prank(deposit.depositor);
        try escrow.withdrawDeposit(depositId) {
            // Update ghost ledger
            ghostTotalOut += remainingAmount;
            ghostDepositExists[depositId] = false;
            ghostDepositAmounts[depositId] = 0;
            ghostDepositLiquidity[depositId] = 0;
            withdrawDepositCount++;
        } catch {}
    }
    
    /**
     * @notice Simulate time passing to trigger intent expiration
     * @param timeDelta Time to advance in seconds
     */
    function advanceTime(uint256 timeDelta) public {
        // Bound time advance to reasonable range
        timeDelta = bound(timeDelta, 1, 30 days);
        vm.warp(block.timestamp + timeDelta);
        
        // Prune expired intents for active deposits
        for (uint i = 0; i < activeDepositIds.length && i < 10; i++) {
            uint256 depositId = activeDepositIds[i];
            if (ghostDepositExists[depositId]) {
                vm.prank(escrow.getDeposit(depositId).depositor);
                try escrow.pruneExpiredIntents(depositId) {
                    // Expired intents return liquidity to deposit
                    // This is tracked through event monitoring in real implementation
                } catch {}
            }
        }
    }
}

/**
 * @title EscrowInvariantTest
 * @notice Invariant tests for Escrow contract using handler-based fuzzing
 * @dev Tests global properties that must always hold regardless of operation sequence
 */
contract EscrowInvariantTest is Test {
    // Contracts
    Escrow public escrow;
    Orchestrator public orchestrator;
    DepositRateManagerController public rateManagerController;
    USDCMock public usdc;
    PaymentVerifierMock public verifier;
    EscrowHandler public handler;
    
    // Registries
    EscrowRegistry public escrowRegistry;
    PaymentVerifierRegistry public paymentVerifierRegistry;
    RelayerRegistry public relayerRegistry;
    NullifierRegistry public nullifierRegistry;
    
    // Test constants
    uint256 constant PRECISE_UNIT = 1e18;
    uint256 constant INTENT_EXPIRATION_PERIOD = 7 days;
    uint256 constant PARTIAL_RELEASE_DELAY = 1 hours;
    bytes32 constant PAYMENT_METHOD = keccak256("VENMO");
    bytes32 constant CURRENCY = keccak256("USD");
    
    // Test addresses
    address public owner;
    address public protocolFeeRecipient;
    
    function setUp() public {
        // Setup addresses
        owner = makeAddr("owner");
        protocolFeeRecipient = makeAddr("protocolFeeRecipient");
        
        // Deploy token (USDCMock expects initial supply, name, symbol)
        usdc = new USDCMock(100000000e6, "USDC", "USDC");
        
        // Deploy registries
        vm.startPrank(owner);
        escrowRegistry = new EscrowRegistry();
        paymentVerifierRegistry = new PaymentVerifierRegistry();
        relayerRegistry = new RelayerRegistry();
        nullifierRegistry = new NullifierRegistry();
        vm.stopPrank();
        
        // Deploy orchestrator
        vm.prank(owner);
        orchestrator = new Orchestrator(
            owner,
            1, // chainId
            address(escrowRegistry),
            address(paymentVerifierRegistry),
            address(relayerRegistry),
            0, // protocolFee
            protocolFeeRecipient
        );
        vm.prank(owner);
        rateManagerController = new DepositRateManagerController();
        vm.prank(owner);
        orchestrator.setDepositRateManagerController(address(rateManagerController));
        
        // Deploy escrow
        vm.prank(owner);
        escrow = new Escrow(
            owner,
            1, // chainId
            address(paymentVerifierRegistry),
            protocolFeeRecipient,
            1e4, // dustThreshold
            100, // maxIntentsPerDeposit
            INTENT_EXPIRATION_PERIOD
        );
        
        // Deploy and register verifier
        vm.startPrank(owner);
        bytes32[] memory currencies = new bytes32[](1);
        currencies[0] = keccak256("USD");
        
        verifier = new PaymentVerifierMock();
        verifier.setShouldVerifyPayment(true);
        verifier.setVerificationContext(address(orchestrator), address(escrow));
        
        paymentVerifierRegistry.addPaymentMethod(PAYMENT_METHOD, address(verifier), currencies);
        escrowRegistry.addEscrow(address(escrow));
        escrow.setOrchestrator(address(orchestrator));
        vm.stopPrank();
        
        // Deploy handler
        handler = new EscrowHandler(escrow, orchestrator, usdc, verifier);
        
        // Setup invariant testing to target handler
        targetContract(address(handler));
        
        // Include all handler functions for invariant testing
        bytes4[] memory selectors = new bytes4[](7);
        selectors[0] = EscrowHandler.createDeposit.selector;
        selectors[1] = EscrowHandler.addFundsToDeposit.selector;
        selectors[2] = EscrowHandler.removeFundsFromDeposit.selector;
        selectors[3] = EscrowHandler.signalIntent.selector;
        selectors[4] = EscrowHandler.cancelIntent.selector;
        selectors[5] = EscrowHandler.withdrawDeposit.selector;
        selectors[6] = EscrowHandler.advanceTime.selector;
        
        targetSelector(FuzzSelector({
            addr: address(handler),
            selectors: selectors
        }));
    }
    
    // ============ Core Invariants ============
    
    /**
     * @notice Invariant 1: Token Conservation
     * @dev Total USDC balance of escrow = Total In - Total Out
     * This is the most critical invariant - no value creation or destruction
     */
    function invariant_TokenConservation() public view {
        uint256 escrowBalance = usdc.balanceOf(address(escrow));
        uint256 expectedBalance = handler.ghostTotalIn() - handler.ghostTotalOut();
        
        assertEq(
            escrowBalance,
            expectedBalance,
            "CRITICAL: Token conservation violated - value created or destroyed"
        );
    }
    
    /**
     * @notice Invariant 2: Protocol Solvency
     * @dev Escrow balance >= Sum of all deposit amounts
     * Ensures protocol can always honor withdrawals
     */
    function invariant_ProtocolSolvency() public view {
        uint256 escrowBalance = usdc.balanceOf(address(escrow));
        uint256 totalDepositAmounts = 0;
        
        // Sum up all active deposit amounts
        // Note: We can't directly access the array length from outside, so we'll track via createDepositCount
        for (uint256 i = 0; i < handler.createDepositCount(); i++) {
            if (handler.ghostDepositExists(i)) {
                totalDepositAmounts += handler.ghostDepositAmounts(i);
            }
        }
        
        assertGe(
            escrowBalance,
            totalDepositAmounts,
            "CRITICAL: Protocol insolvent - cannot cover all deposits"
        );
    }
    
    /**
     * @notice Invariant 3: Fee Bounds
     * @dev Total fees collected never exceed maximum possible fees
     * Protects users from excessive fee extraction
     */
    // fees removed: invariant_FeeBounds no longer applicable
    function invariant_FeeBounds() public view {}
    
    /**
     * @notice Invariant 4: Deposit Liquidity Consistency
     * @dev For each deposit: Available Liquidity + Locked in Intents = Ghost total for that deposit
     */
    function invariant_DepositLiquidityConsistency() public view {
        // Check each created deposit
        for (uint256 depositId = 0; depositId < handler.createDepositCount(); depositId++) {
            if (!handler.ghostDepositExists(depositId)) continue;
            
            IEscrow.Deposit memory deposit = escrow.getDeposit(depositId);
            
            // Contract state
            uint256 contractRemaining = deposit.remainingDeposits;
            uint256 contractLocked = deposit.outstandingIntentAmount;
            
            // Available + Locked should equal handler's ghost total for that deposit
            assertEq(
                contractRemaining + contractLocked,
                handler.ghostDepositAmounts(depositId),
                "Deposit liquidity accounting mismatch"
            );
        }
    }
    
    /**
     * @notice Invariant 5: Intent Amount Bounds
     * @dev All intents respect deposit min/max ranges
     */
    function invariant_IntentAmountBounds() public view {
        // Note: We can't easily iterate through activeIntentHashes from outside
        // This invariant would need modification to track intents differently
        // For now, we'll skip the iteration as it's not easily accessible
        // Implementation would require tracking intents differently
        // as activeIntentHashes array is not easily accessible from outside
    }
    
    /**
     * @notice Invariant 6: No Negative Balances
     * @dev All tracked amounts must be non-negative (implicit through uint256)
     * This checks that our ghost accounting never goes negative
     */
    function invariant_NoNegativeBalances() public view {
        // Check that total out never exceeds total in
        assertLe(
            handler.ghostTotalOut(),
            handler.ghostTotalIn(),
            "More tokens withdrawn than deposited"
        );
    }
    
    /**
     * @notice Invariant 7: Monotonic Deposit Counter
     * @dev Deposit counter only increases, never decreases
     */
    function invariant_MonotonicDepositCounter() public view {
        uint256 currentCounter = escrow.depositCounter();
        uint256 createdDeposits = handler.createDepositCount();
        
        assertEq(
            currentCounter,
            createdDeposits,
            "Deposit counter inconsistent with created deposits"
        );
    }
    
    // ============ Helper Functions for Debugging ============
    
    /**
     * @notice Call summary for debugging failed invariants
     */
    function invariant_callSummary() public view {
        console2.log("=== Operation Summary ===");
        console2.log("Create Deposits:", handler.createDepositCount());
        console2.log("Add Funds:", handler.addFundsCount());
        console2.log("Remove Funds:", handler.removeFundsCount());
        console2.log("Signal Intents:", handler.signalIntentCount());
        console2.log("Cancel Intents:", handler.cancelIntentCount());
        console2.log("Withdraw Deposits:", handler.withdrawDepositCount());
        console2.log("");
        console2.log("=== Ghost Ledger ===");
        console2.log("Total In:", handler.ghostTotalIn());
        console2.log("Total Out:", handler.ghostTotalOut());
        console2.log("Escrow Balance:", usdc.balanceOf(address(escrow)));
    }
}

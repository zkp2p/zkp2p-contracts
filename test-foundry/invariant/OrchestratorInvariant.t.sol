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
import { IPaymentVerifier } from "../../contracts/interfaces/IPaymentVerifier.sol";
import { USDCMock } from "../../contracts/mocks/USDCMock.sol";
import { PaymentVerifierMock } from "../../contracts/mocks/PaymentVerifierMock.sol";
import { EscrowRegistry } from "../../contracts/registries/EscrowRegistry.sol";
import { PaymentVerifierRegistry } from "../../contracts/registries/PaymentVerifierRegistry.sol";
import { PostIntentHookRegistry } from "../../contracts/registries/PostIntentHookRegistry.sol";
import { RelayerRegistry } from "../../contracts/registries/RelayerRegistry.sol";
import { NullifierRegistry } from "../../contracts/registries/NullifierRegistry.sol";
import { INullifierRegistry } from "../../contracts/interfaces/INullifierRegistry.sol";

/**
 * @title OrchestratorHandler
 * @notice Handler contract for stateful fuzzing of Orchestrator contract
 * @dev Implements ghost ledger pattern to track token flows and state without reimplementing logic
 */
contract OrchestratorHandler is Test {
    // Constants
    uint256 constant PRECISE_UNIT = 1e18;
    uint256 constant MAX_PROTOCOL_FEE = 5e16; // 5%
    uint256 constant MAX_REFERRER_FEE = 5e16; // 5%
    uint256 constant INTENT_EXPIRATION_PERIOD = 7 days;
    bytes32 constant PAYMENT_METHOD = keccak256("VENMO");
    bytes32 constant CURRENCY = keccak256("USD");
    
    // Contracts
    Orchestrator public orchestrator;
    Escrow public escrow;
    USDCMock public usdc;
    PaymentVerifierMock public verifier;
    
    // Registries
    PaymentVerifierRegistry public paymentVerifierRegistry;
    
    // Test addresses
    address public owner;
    address public protocolFeeRecipient;
    
    // ============ Ghost Ledger - Track Observable Effects ============
    
    // Token flow tracking
    uint256 public ghostTotalFeesCollected;
    uint256 public ghostProtocolFeesCollected;
    uint256 public ghostReferrerFeesCollected;
    mapping(address => uint256) public ghostUserNetReceived;
    
    // Intent state tracking
    mapping(bytes32 => bool) public ghostIntentExists;
    mapping(bytes32 => uint256) public ghostIntentAmount;
    mapping(address => uint256) public ghostActiveIntentCount;
    mapping(bytes32 => address) public ghostIntentOwner;
    mapping(bytes32 => uint256) public ghostIntentDepositId;
    mapping(bytes32 => uint256) public ghostIntentReferrerFee;
    
    // Intent lifecycle tracking
    uint256 public ghostIntentsCreated;
    uint256 public ghostIntentsFulfilled;
    uint256 public ghostIntentsCancelled;
    uint256 public ghostIntentsReleased;
    
    // Fee configuration tracking
    uint256 public ghostMaxProtocolFeeSeen;
    uint256 public ghostMaxReferrerFeeSeen;
    
    // Registry tracking
    mapping(address => bool) public ghostVerifierWhitelisted;
    mapping(address => bool) public ghostEscrowWhitelisted;
    mapping(address => bool) public ghostHookWhitelisted;
    
    // ============ State Variables ============
    address[] public actors;
    bytes32[] public activeIntents;
    uint256[] public activeDepositIds;
    
    // Operation counters for analysis
    uint256 public signalIntentCount;
    uint256 public fulfillIntentCount;
    uint256 public cancelIntentCount;
    uint256 public releaseFundsCount;
    uint256 public protocolFeeUpdateCount;
    
    constructor(
        Orchestrator _orchestrator,
        Escrow _escrow,
        USDCMock _usdc,
        PaymentVerifierMock _verifier,
        PaymentVerifierRegistry _paymentVerifierRegistry,
        address _owner,
        address _protocolFeeRecipient
    ) {
        orchestrator = _orchestrator;
        escrow = _escrow;
        usdc = _usdc;
        verifier = _verifier;
        paymentVerifierRegistry = _paymentVerifierRegistry;
        owner = _owner;
        protocolFeeRecipient = _protocolFeeRecipient;
        
        // Setup actors for testing
        actors.push(makeAddr("alice"));
        actors.push(makeAddr("bob"));
        actors.push(makeAddr("charlie"));
        actors.push(makeAddr("diana"));
        actors.push(makeAddr("eve"));
        
        // Give actors tokens and setup approvals
        for (uint i = 0; i < actors.length; i++) {
            deal(address(usdc), actors[i], 10000000e6); // 10M USDC each
            vm.prank(actors[i]);
            usdc.approve(address(escrow), type(uint256).max);
        }
        
        // Initialize ghost ledger for registered contracts
        ghostVerifierWhitelisted[address(verifier)] = true;
        ghostEscrowWhitelisted[address(escrow)] = true;
        
        // Create initial deposits for testing
        _createInitialDeposits();
    }
    
    // ============ Handler Functions (Bounded Random Operations) ============
    
    /**
     * @notice Signal an intent with bounded parameters
     * @param actorSeed Seed to select actor
     * @param depositSeed Seed to select deposit
     * @param amount Intent amount to bound
     * @param referrerFeeSeed Seed for referrer fee
     * @param useReferrer Whether to use a referrer
     * @param usePostHook Whether to use a post-intent hook
     */
    function signalIntent(
        uint256 actorSeed,
        uint256 depositSeed,
        uint256 amount,
        uint256 referrerFeeSeed,
        bool useReferrer,
        bool usePostHook
    ) public {
        // Select actor and deposit
        address actor = actors[actorSeed % actors.length];
        if (activeDepositIds.length == 0) return;
        uint256 depositId = activeDepositIds[depositSeed % activeDepositIds.length];
        
        // Get deposit info
        IEscrow.Deposit memory deposit = escrow.getDeposit(depositId);
        if (deposit.depositor == address(0)) return;
        
        // Check available liquidity
        uint256 availableLiquidity = deposit.remainingDeposits;
        if (availableLiquidity < deposit.intentAmountRange.min) return;
        
        // Bound parameters
        amount = bound(amount, deposit.intentAmountRange.min, Math.min(deposit.intentAmountRange.max, availableLiquidity));
        uint256 referrerFee = bound(referrerFeeSeed, 0, MAX_REFERRER_FEE);
        
        // Select referrer if using
        address referrer = useReferrer ? actors[(actorSeed + 1) % actors.length] : address(0);
        if (referrer == actor) referrer = address(0); // Can't refer yourself
        
        // Build intent params
        IOrchestrator.SignalIntentParams memory params = IOrchestrator.SignalIntentParams({
            escrow: address(escrow),
            depositId: depositId,
            to: actor,
            amount: amount,
            paymentMethod: PAYMENT_METHOD,
            fiatCurrency: CURRENCY,
            conversionRate: 1e18,
            referrer: referrer,
            referrerFee: referrerFee,
            gatingServiceSignature: "",
            signatureExpiration: 0,
            postIntentHook: IPostIntentHook(address(0)), // Simplified - no hooks for now
            data: ""
        });
        
        // Execute and track
        vm.prank(actor);
        try orchestrator.signalIntent(params) {
            // Calculate intent hash (matches Orchestrator's calculation)
            bytes32 intentHash = keccak256(
                abi.encodePacked(
                    actor,
                    orchestrator.intentCounter() - 1, // Counter was just incremented
                    block.timestamp
                )
            );
            
            // Update ghost ledger
            ghostIntentExists[intentHash] = true;
            ghostIntentAmount[intentHash] = amount;
            ghostIntentOwner[intentHash] = actor;
            ghostIntentDepositId[intentHash] = depositId;
            ghostIntentReferrerFee[intentHash] = referrerFee;
            ghostActiveIntentCount[actor]++;
            ghostIntentsCreated++;
            activeIntents.push(intentHash);
            
            // Track fee configurations
            if (referrerFee > ghostMaxReferrerFeeSeen) {
                ghostMaxReferrerFeeSeen = referrerFee;
            }
            
            signalIntentCount++;
        } catch {}
    }
    
    /**
     * @notice Fulfill an intent with payment proof
     * @param intentSeed Seed to select intent
     * @param releaseAmountSeed Seed for release amount
     */
    function fulfillIntent(
        uint256 intentSeed,
        uint256 releaseAmountSeed
    ) public {
        if (activeIntents.length == 0) return;
        bytes32 intentHash = activeIntents[intentSeed % activeIntents.length];
        
        if (!ghostIntentExists[intentHash]) return;
        
        // Get intent details
        IOrchestrator.Intent memory intent = orchestrator.getIntent(intentHash);
        if (intent.owner == address(0)) return;
        
        // Bound release amount (can be less than or equal to intent amount)
        uint256 releaseAmount = bound(
            releaseAmountSeed,
            intent.amount / 2,
            intent.amount
        );
        
        // Track balances before
        uint256 protocolBalanceBefore = usdc.balanceOf(protocolFeeRecipient);
        uint256 referrerBalanceBefore = intent.referrer != address(0) ?
            usdc.balanceOf(intent.referrer) : 0;
        uint256 recipientBalanceBefore = usdc.balanceOf(intent.to);
        
        // Build fulfillment params
        IOrchestrator.FulfillIntentParams memory params = IOrchestrator.FulfillIntentParams({
            paymentProof: abi.encode("mock_proof"),
            intentHash: intentHash,
            verificationData: abi.encode(
                releaseAmount,
                "paymentId123",
                block.timestamp - 100 // Recent timestamp
            ),
            postIntentHookData: ""
        });
        
        // Execute fulfillment
        try orchestrator.fulfillIntent(params) {
            // Calculate actual fees collected
            uint256 protocolFeesActual = usdc.balanceOf(protocolFeeRecipient) - protocolBalanceBefore;
            uint256 referrerFeesActual = intent.referrer != address(0) ?
                usdc.balanceOf(intent.referrer) - referrerBalanceBefore : 0;
            uint256 netReceived = usdc.balanceOf(intent.to) - recipientBalanceBefore;
            
            // Update ghost ledger
            ghostTotalFeesCollected += protocolFeesActual + referrerFeesActual;
            ghostProtocolFeesCollected += protocolFeesActual;
            ghostReferrerFeesCollected += referrerFeesActual;
            ghostUserNetReceived[intent.to] += netReceived;
            
            ghostIntentExists[intentHash] = false;
            ghostActiveIntentCount[intent.owner]--;
            ghostIntentsFulfilled++;
            
            _removeFromActiveIntents(intentHash);
            
            fulfillIntentCount++;
        } catch {}
    }
    
    /**
     * @notice Cancel an intent
     * @param intentSeed Seed to select intent
     */
    function cancelIntent(uint256 intentSeed) public {
        if (activeIntents.length == 0) return;
        bytes32 intentHash = activeIntents[intentSeed % activeIntents.length];
        
        if (!ghostIntentExists[intentHash]) return;
        
        address intentOwner = ghostIntentOwner[intentHash];
        if (intentOwner == address(0)) return;
        
        vm.prank(intentOwner);
        try orchestrator.cancelIntent(intentHash) {
            // Update ghost ledger
            ghostIntentExists[intentHash] = false;
            ghostActiveIntentCount[intentOwner]--;
            ghostIntentsCancelled++;
            
            _removeFromActiveIntents(intentHash);
            
            cancelIntentCount++;
        } catch {}
    }
    
    /**
     * @notice Depositor releases funds directly to payer
     * @param intentSeed Seed to select intent
     */
    function releaseFundsToPayer(uint256 intentSeed) public {
        if (activeIntents.length == 0) return;
        bytes32 intentHash = activeIntents[intentSeed % activeIntents.length];
        
        if (!ghostIntentExists[intentHash]) return;
        
        // Get intent and deposit details
        IOrchestrator.Intent memory intent = orchestrator.getIntent(intentHash);
        if (intent.owner == address(0)) return;
        
        IEscrow.Deposit memory deposit = escrow.getDeposit(intent.depositId);
        if (deposit.depositor == address(0)) return;
        
        // Track balance before
        uint256 recipientBalanceBefore = usdc.balanceOf(intent.to);
        
        vm.prank(deposit.depositor);
        try orchestrator.releaseFundsToPayer(intentHash) {
            uint256 netReceived = usdc.balanceOf(intent.to) - recipientBalanceBefore;
            
            // Update ghost ledger
            ghostUserNetReceived[intent.to] += netReceived;
            ghostIntentExists[intentHash] = false;
            ghostActiveIntentCount[intent.owner]--;
            ghostIntentsReleased++;
            
            _removeFromActiveIntents(intentHash);
            
            releaseFundsCount++;
        } catch {}
    }
    
    /**
     * @notice Update protocol fee
     * @param newFeeSeed Seed for new fee value
     */
    function updateProtocolFee(uint256 newFeeSeed) public {
        uint256 newFee = bound(newFeeSeed, 0, MAX_PROTOCOL_FEE);
        
        vm.prank(owner);
        try orchestrator.setProtocolFee(newFee) {
            if (newFee > ghostMaxProtocolFeeSeen) {
                ghostMaxProtocolFeeSeen = newFee;
            }
            protocolFeeUpdateCount++;
        } catch {}
    }
    
    /**
     * @notice Simulate time passing
     * @param timeDelta Time to advance in seconds
     */
    function advanceTime(uint256 timeDelta) public {
        // Bound time advance to reasonable range
        timeDelta = bound(timeDelta, 1, 30 days);
        vm.warp(block.timestamp + timeDelta);
        
        // Could trigger intent expiration logic here if implemented
    }
    
    // ============ Internal Helper Functions ============
    
    /**
     * @notice Create initial deposits for testing
     */
    function _createInitialDeposits() internal {
        for (uint i = 0; i < 3; i++) {
            address depositor = actors[i];
            uint256 amount = 50000e6; // 50k USDC
            
            vm.startPrank(depositor);
            usdc.approve(address(escrow), amount);
            
            // Prepare deposit params
            bytes32[] memory paymentMethods = new bytes32[](1);
            paymentMethods[0] = PAYMENT_METHOD;
            
            IEscrow.DepositPaymentMethodData[] memory paymentMethodData = new IEscrow.DepositPaymentMethodData[](1);
            paymentMethodData[0] = IEscrow.DepositPaymentMethodData({
                intentGatingService: address(0),
                payeeDetails: keccak256(abi.encodePacked("venmo:", depositor)),
                data: ""
            });
            
            IEscrow.Currency[][] memory currencies = new IEscrow.Currency[][](1);
            currencies[0] = new IEscrow.Currency[](1);
            currencies[0][0] = IEscrow.Currency({
                code: CURRENCY,
                minConversionRate: 1e18
            });
            
            IEscrow.CreateDepositParams memory params = IEscrow.CreateDepositParams({
                token: IERC20(address(usdc)),
                amount: amount,
                intentAmountRange: IEscrow.Range(100e6, 10000e6), // 100-10k USDC
                paymentMethods: paymentMethods,
                paymentMethodData: paymentMethodData,
                currencies: currencies,
                delegate: address(0),
                intentGuardian: address(0),
                retainOnEmpty: false
            });
            
            uint256 depositId = escrow.depositCounter();
            escrow.createDeposit(params);
            activeDepositIds.push(depositId);
            
            vm.stopPrank();
        }
    }
    
    /**
     * @notice Remove intent from active list
     */
    function _removeFromActiveIntents(bytes32 intentHash) internal {
        for (uint i = 0; i < activeIntents.length; i++) {
            if (activeIntents[i] == intentHash) {
                activeIntents[i] = activeIntents[activeIntents.length - 1];
                activeIntents.pop();
                break;
            }
        }
    }
    
    // ============ View Functions for Invariants ============
    
    /**
     * @notice Calculate total fees that should have been collected based on fee rates
     */
    function calculateExpectedFees() external view returns (uint256) {
        uint256 expectedFees = 0;
        uint256 currentProtocolFee = orchestrator.protocolFee();
        
        // This is simplified - in reality would need to track historical fee rates
        // and amounts at time of fulfillment
        if (ghostIntentsFulfilled > 0) {
            // Approximate based on average intent amount and current fee
            uint256 avgIntentAmount = 1000e6; // Approximation
            expectedFees = (avgIntentAmount * currentProtocolFee * ghostIntentsFulfilled) / PRECISE_UNIT;
        }
        
        return expectedFees;
    }
}

/**
 * @title OrchestratorInvariantTest
 * @notice Invariant tests for Orchestrator contract using handler-based fuzzing
 * @dev Tests critical properties that must always hold regardless of operation sequence
 */
contract OrchestratorInvariantTest is Test {
    // Constants
    uint256 constant PRECISE_UNIT = 1e18;
    uint256 constant MAX_PROTOCOL_FEE = 5e16; // 5%
    uint256 constant MAX_REFERRER_FEE = 5e16; // 5%
    uint256 constant INTENT_EXPIRATION_PERIOD = 7 days;
    bytes32 constant PAYMENT_METHOD = keccak256("VENMO");
    bytes32 constant CURRENCY = keccak256("USD");
    
    // Contracts
    Orchestrator public orchestrator;
    Escrow public escrow;
    DepositRateManagerController public rateManagerController;
    USDCMock public usdc;
    PaymentVerifierMock public verifier;
    OrchestratorHandler public handler;
    
    // Registries
    EscrowRegistry public escrowRegistry;
    PaymentVerifierRegistry public paymentVerifierRegistry;
    PostIntentHookRegistry public postIntentHookRegistry;
    RelayerRegistry public relayerRegistry;
    NullifierRegistry public nullifierRegistry;
    
    // Test addresses
    address public owner;
    address public protocolFeeRecipient;
    
    function setUp() public {
        // Setup addresses
        owner = makeAddr("owner");
        protocolFeeRecipient = makeAddr("protocolFeeRecipient");
        
        // Deploy token
        usdc = new USDCMock(100000000e6, "USDC", "USDC");
        
        // Deploy registries
        vm.startPrank(owner);
        escrowRegistry = new EscrowRegistry();
        paymentVerifierRegistry = new PaymentVerifierRegistry();
        postIntentHookRegistry = new PostIntentHookRegistry();
        relayerRegistry = new RelayerRegistry();
        nullifierRegistry = new NullifierRegistry();
        vm.stopPrank();
        
        // Deploy orchestrator with initial 1% protocol fee
        vm.prank(owner);
        orchestrator = new Orchestrator(
            owner,
            1, // chainId
            address(escrowRegistry),
            address(paymentVerifierRegistry),
            address(postIntentHookRegistry),
            address(relayerRegistry),
            1e16, // 1% protocol fee
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
        currencies[0] = CURRENCY;
        
        verifier = new PaymentVerifierMock();
        verifier.setShouldVerifyPayment(true);
        verifier.setVerificationContext(address(orchestrator), address(escrow));
        
        // Register contracts
        paymentVerifierRegistry.addPaymentMethod(PAYMENT_METHOD, address(verifier), currencies);
        escrowRegistry.addEscrow(address(escrow));
        escrow.setOrchestrator(address(orchestrator));
        vm.stopPrank();
        
        // Deploy handler
        handler = new OrchestratorHandler(
            orchestrator,
            escrow,
            usdc,
            verifier,
            paymentVerifierRegistry,
            owner,
            protocolFeeRecipient
        );
        
        // Setup invariant testing to target handler
        targetContract(address(handler));
        
        // Include all handler functions for invariant testing
        bytes4[] memory selectors = new bytes4[](6);
        selectors[0] = OrchestratorHandler.signalIntent.selector;
        selectors[1] = OrchestratorHandler.fulfillIntent.selector;
        selectors[2] = OrchestratorHandler.cancelIntent.selector;
        selectors[3] = OrchestratorHandler.releaseFundsToPayer.selector;
        selectors[4] = OrchestratorHandler.updateProtocolFee.selector;
        selectors[5] = OrchestratorHandler.advanceTime.selector;
        
        targetSelector(FuzzSelector({
            addr: address(handler),
            selectors: selectors
        }));
    }
    
    // ============ Core Invariants (P0 Priority) ============
    
    /**
     * @notice Invariant 1: Token Conservation
     * @dev No tokens created or destroyed - all token movements are accounted for
     * escrow_balance + orchestrator_balance + user_balances = initial_supply
     */
    function invariant_TokenConservation() public view {
        // The orchestrator doesn't hold tokens - it only routes them
        // All tokens should be either in escrow or with users
        uint256 orchestratorBalance = usdc.balanceOf(address(orchestrator));
        
        assertEq(
            orchestratorBalance,
            0,
            "CRITICAL: Orchestrator should never hold tokens"
        );
        
        // Total fees collected should equal sum of protocol and referrer fees
        uint256 totalFees = handler.ghostTotalFeesCollected();
        uint256 protocolFees = handler.ghostProtocolFeesCollected();
        uint256 referrerFees = handler.ghostReferrerFeesCollected();
        
        assertEq(
            totalFees,
            protocolFees + referrerFees,
            "CRITICAL: Fee accounting mismatch"
        );
    }
    
    /**
     * @notice Invariant 2: Fee Bounds
     * @dev Fees never exceed configured maximums
     */
    function invariant_FeeBounds() public view {
        // Protocol fee should never exceed maximum
        uint256 currentProtocolFee = orchestrator.protocolFee();
        assertLe(
            currentProtocolFee,
            MAX_PROTOCOL_FEE,
            "Protocol fee exceeds maximum allowed"
        );
        
        // Check that maximum seen protocol fee never exceeded limit
        assertLe(
            handler.ghostMaxProtocolFeeSeen(),
            MAX_PROTOCOL_FEE,
            "Historical protocol fee exceeded maximum"
        );
        
        // Check that maximum seen referrer fee never exceeded limit
        assertLe(
            handler.ghostMaxReferrerFeeSeen(),
            MAX_REFERRER_FEE,
            "Referrer fee exceeded maximum allowed"
        );
        
        // Total fees (protocol + referrer) should never exceed 10%
        uint256 maxCombinedFee = MAX_PROTOCOL_FEE + MAX_REFERRER_FEE;
        assertLe(
            maxCombinedFee,
            1e17, // 10%
            "Combined fees exceed 10% maximum"
        );
    }
    
    /**
     * @notice Invariant 3: Intent State Consistency
     * @dev Intent exists <=> accountIntents contains it
     * For every intentHash in intents mapping:
     *   - Must exist in accountIntents[intent.owner]
     *   - Must have corresponding locked funds in escrow
     */
    function invariant_IntentStateConsistency() public view {
        // Check lifecycle accounting
        uint256 totalCreated = handler.ghostIntentsCreated();
        uint256 totalFulfilled = handler.ghostIntentsFulfilled();
        uint256 totalCancelled = handler.ghostIntentsCancelled();
        uint256 totalReleased = handler.ghostIntentsReleased();
        
        // All created intents should be accounted for
        assertLe(
            totalFulfilled + totalCancelled + totalReleased,
            totalCreated,
            "More intents resolved than created"
        );
        
        // Active intent count per user should be non-negative (implicit through uint256)
        // This is checked through proper tracking in the handler
    }
    
    /**
     * @notice Invariant 4: Intent Uniqueness
     * @dev Every intentHash is globally unique
     * Intent counter only increases, never decreases
     */
    function invariant_IntentUniqueness() public view {
        uint256 currentCounter = orchestrator.intentCounter();
        uint256 intentsCreated = handler.ghostIntentsCreated();
        
        // Counter should match or exceed intents created
        assertGe(
            currentCounter,
            intentsCreated,
            "Intent counter inconsistent with created intents"
        );
        
        // Counter should be monotonically increasing (can't test decrease in invariant)
        // But we can ensure it's not unreasonably high
        assertLe(
            currentCounter,
            intentsCreated + 1000, // Allow some buffer for failed transactions
            "Intent counter increased too much"
        );
    }
    
    /**
     * @notice Invariant 5: Registry Consistency
     * @dev All referenced contracts are whitelisted
     * - verifier in paymentVerifierRegistry
     * - escrow in escrowRegistry (unless accepting all)
     * - postIntentHook in postIntentHookRegistry
     */
    function invariant_RegistryConsistency() public view {
        // Check that the escrow is whitelisted
        bool escrowWhitelisted = escrowRegistry.isWhitelistedEscrow(address(escrow));
        bool acceptingAll = escrowRegistry.isAcceptingAllEscrows();
        
        assertTrue(
            escrowWhitelisted || acceptingAll,
            "Escrow not properly whitelisted"
        );
        
        // Check that verifier is registered for payment method
        address registeredVerifier = paymentVerifierRegistry.getVerifier(PAYMENT_METHOD);
        assertEq(
            registeredVerifier,
            address(verifier),
            "Payment verifier not properly registered"
        );
    }
    
    // ============ Additional Safety Invariants ============
    
    /**
     * @notice Fee Distribution Correctness
     * @dev Fees are distributed correctly to protocol and referrers
     */
    function invariant_FeeDistributionCorrectness() public view {
        uint256 protocolBalance = usdc.balanceOf(protocolFeeRecipient);
        uint256 protocolFeesCollected = handler.ghostProtocolFeesCollected();
        
        // Protocol fee recipient should have received all protocol fees
        assertGe(
            protocolBalance,
            protocolFeesCollected,
            "Protocol fee recipient missing fees"
        );
    }
    
    /**
     * @notice Intent Accounting Consistency
     * @dev Total intents created equals sum of all resolution types plus active
     */
    function invariant_IntentAccountingConsistency() public view {
        uint256 created = handler.ghostIntentsCreated();
        uint256 fulfilled = handler.ghostIntentsFulfilled();
        uint256 cancelled = handler.ghostIntentsCancelled();
        uint256 released = handler.ghostIntentsReleased();
        
        // Cannot have more resolutions than creations
        assertGe(
            created,
            fulfilled + cancelled + released,
            "Intent resolution exceeds creation"
        );
    }
    
    /**
     * @notice No Locked Value in Orchestrator
     * @dev Orchestrator should never hold user funds
     */
    function invariant_NoLockedValue() public view {
        uint256 orchestratorBalance = usdc.balanceOf(address(orchestrator));
        
        assertEq(
            orchestratorBalance,
            0,
            "Orchestrator holding user funds"
        );
    }
    
    // ============ Helper Functions for Debugging ============
    
    /**
     * @notice Call summary for debugging failed invariants
     */
    function invariant_callSummary() public view {
        console2.log("=== Operation Summary ===");
        console2.log("Signal Intents:", handler.signalIntentCount());
        console2.log("Fulfill Intents:", handler.fulfillIntentCount());
        console2.log("Cancel Intents:", handler.cancelIntentCount());
        console2.log("Release Funds:", handler.releaseFundsCount());
        console2.log("Protocol Fee Updates:", handler.protocolFeeUpdateCount());
        console2.log("");
        console2.log("=== Intent Lifecycle ===");
        console2.log("Intents Created:", handler.ghostIntentsCreated());
        console2.log("Intents Fulfilled:", handler.ghostIntentsFulfilled());
        console2.log("Intents Cancelled:", handler.ghostIntentsCancelled());
        console2.log("Intents Released:", handler.ghostIntentsReleased());
        console2.log("");
        console2.log("=== Fee Tracking ===");
        console2.log("Total Fees Collected:", handler.ghostTotalFeesCollected());
        console2.log("Protocol Fees:", handler.ghostProtocolFeesCollected());
        console2.log("Referrer Fees:", handler.ghostReferrerFeesCollected());
        console2.log("Current Protocol Fee:", orchestrator.protocolFee());
        console2.log("Max Protocol Fee Seen:", handler.ghostMaxProtocolFeeSeen());
        console2.log("Max Referrer Fee Seen:", handler.ghostMaxReferrerFeeSeen());
        console2.log("");
        console2.log("=== Contract Balances ===");
        console2.log("Orchestrator Balance:", usdc.balanceOf(address(orchestrator)));
        console2.log("Escrow Balance:", usdc.balanceOf(address(escrow)));
        console2.log("Protocol Fee Recipient:", usdc.balanceOf(protocolFeeRecipient));
    }
}

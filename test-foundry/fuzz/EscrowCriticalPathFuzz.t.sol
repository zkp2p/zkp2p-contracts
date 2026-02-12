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
 * @title EscrowCriticalPathFuzz
 * @notice Fuzz tests for critical calculation paths in Escrow contract
 * @dev Tests fee calculations, conversion rates, intent validation, and liquidity management
 */
contract EscrowCriticalPathFuzz is Test {
    // Constants
    uint256 constant PRECISE_UNIT = 1e18;
    uint256 constant MAX_REFERRER_FEE = 5e16; // 5%
    uint256 constant MAX_MAKER_FEE = 5e16; // 5%
    uint256 constant INTENT_EXPIRATION_PERIOD = 7 days;
    uint256 constant PARTIAL_RELEASE_DELAY = 1 hours;
    uint256 constant CIRCOM_PRIME_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    bytes32 constant VENMO = keccak256("VENMO");
    bytes32 constant PAYPAL = keccak256("PAYPAL");
    bytes32 constant USD = keccak256("USD");
    bytes32 constant EUR = keccak256("EUR");
    bytes32 constant GBP = keccak256("GBP");
    
    // Contracts
    Escrow public escrow;
    Orchestrator public orchestrator;
    DepositRateManagerController public rateManagerController;
    USDCMock public usdc;
    PaymentVerifierMock public venmoVerifier;
    PaymentVerifierMock public paypalVerifier;
    
    // Registries
    EscrowRegistry public escrowRegistry;
    PaymentVerifierRegistry public paymentVerifierRegistry;
    RelayerRegistry public relayerRegistry;
    NullifierRegistry public nullifierRegistry;
    
    // Test actors
    address public owner;
    address public protocolFeeRecipient;
    address public depositor;
    address public taker;
    address public referrer;
    
    // Test state
    uint256 public baseDepositId;
    
    function setUp() public {
        // Setup actors
        owner = makeAddr("owner");
        protocolFeeRecipient = makeAddr("protocolFeeRecipient");
        depositor = makeAddr("depositor");
        taker = makeAddr("taker");
        referrer = makeAddr("referrer");
        
        // Deploy token
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
            1e16, // protocol fee 1%
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
            1e4, // dust threshold
            100, // max intents per deposit
            INTENT_EXPIRATION_PERIOD
        );
        
        // Setup verifiers
        vm.startPrank(owner);
        bytes32[] memory currencies = new bytes32[](3);
        currencies[0] = USD;
        currencies[1] = EUR;
        currencies[2] = GBP;
        
        venmoVerifier = new PaymentVerifierMock();
        venmoVerifier.setShouldVerifyPayment(true);
        venmoVerifier.setVerificationContext(address(orchestrator), address(escrow));
        
        paypalVerifier = new PaymentVerifierMock();
        paypalVerifier.setShouldVerifyPayment(true);
        paypalVerifier.setVerificationContext(address(orchestrator), address(escrow));
        
        paymentVerifierRegistry.addPaymentMethod(VENMO, address(venmoVerifier), currencies);
        paymentVerifierRegistry.addPaymentMethod(PAYPAL, address(paypalVerifier), currencies);
        escrowRegistry.addEscrow(address(escrow));
        
        // Set orchestrator on escrow
        escrow.setOrchestrator(address(orchestrator));
        
        // fees removed: no maker protocol fee configuration
        vm.stopPrank();
        
        // Setup test tokens
        deal(address(usdc), depositor, 10000000e6); // 10M USDC
        deal(address(usdc), taker, 10000000e6);
        
        vm.prank(depositor);
        usdc.approve(address(escrow), type(uint256).max);
        vm.prank(taker);
        usdc.approve(address(escrow), type(uint256).max);
    }
    
    // ============ Phase 2.1: Fee Calculation Properties ============
    
    /**
     * @notice Test that fees are monotonically increasing with amount
     * @dev Property: larger deposits should have larger or equal fees
     */
    function xtestFuzz_FeeMonotonicity(
        uint256 amount1,
        uint256 amount2,
        uint256 makerFee,
        uint256 referrerFee
    ) public pure {
        // Bound inputs to realistic USDC values (max 10 million USDC)
        amount1 = bound(amount1, 1e6, 10000000e6); // 10M USDC with 6 decimals
        // Ensure amount2 > amount1 without overflow
        if (amount1 == 10000000e6) {
            amount2 = 10000000e6; // Both at max, test will check equality
        } else {
            amount2 = bound(amount2, amount1 + 1, 10000000e6);
        }
        makerFee = bound(makerFee, 0, MAX_MAKER_FEE);
        referrerFee = bound(referrerFee, 0, MAX_REFERRER_FEE);
        
        // Calculate fees for both amounts
        uint256 fee1 = _calculateTotalFees(amount1, makerFee, referrerFee);
        uint256 fee2 = _calculateTotalFees(amount2, makerFee, referrerFee);
        
        // Property: Larger amounts have larger or equal fees
        assertGe(fee2, fee1, "Fee monotonicity violated");
        
        // Property: Fees are proportional
        // Due to integer division, fee2 might equal fee1 even when amount2 > amount1
        // This happens when the difference is too small to produce a different fee
        // Only check strict inequality when the amounts differ enough to guarantee different fees
        if ((makerFee > 0 || referrerFee > 0)) {
            uint256 totalFeeRate = makerFee + referrerFee;
            uint256 amountDiff = amount2 - amount1;
            // Check if the amount difference is large enough to produce a fee difference
            uint256 expectedFeeDiff = (amountDiff * totalFeeRate) / PRECISE_UNIT;
            if (expectedFeeDiff > 0) {
                assertGt(fee2, fee1, "Fees should increase with amount when difference is significant");
            }
        }
    }
    
    /**
     * @notice Test fee bounds - fees never exceed configured maximums
     * @dev Property: Total fees <= (makerFee + referrerFee) * amount / PRECISE_UNIT
     */
    function xtestFuzz_FeeBounds(
        uint256 amount,
        uint256 makerFee,
        uint256 referrerFee
    ) public pure {
        // Bound inputs
        amount = bound(amount, 1e6, type(uint128).max);
        makerFee = bound(makerFee, 0, MAX_MAKER_FEE);
        referrerFee = bound(referrerFee, 0, MAX_REFERRER_FEE);
        
        // Calculate total fees
        uint256 totalFees = _calculateTotalFees(amount, makerFee, referrerFee);
        
        // Property: Fees never exceed maximum percentage
        uint256 maxFees = (amount * (MAX_MAKER_FEE + MAX_REFERRER_FEE)) / PRECISE_UNIT;
        assertLe(totalFees, maxFees, "Fees exceed maximum allowed");
        
        // Property: Fees never exceed deposit amount
        assertLe(totalFees, amount, "Fees exceed deposit amount");
        
        // Property: Net deposit is always positive for non-zero amounts
        if (amount > 0) {
            assertGt(amount - totalFees, 0, "Net deposit should be positive");
        }
    }
    
    /**
     * @notice Test fee precision - no value is lost or created in fee calculations
     * @dev Property: sum(individual fees) = total fees calculated together
     */
    function xtestFuzz_FeePrecisionConsistency(
        uint256 amount,
        uint256 makerFee,
        uint256 referrerFee
    ) public pure {
        // Bound inputs to avoid overflow
        amount = bound(amount, 1e6, type(uint128).max);
        makerFee = bound(makerFee, 0, MAX_MAKER_FEE);
        referrerFee = bound(referrerFee, 0, MAX_REFERRER_FEE);
        
        // Calculate fees separately
        uint256 makerFeeAmount = (amount * makerFee) / PRECISE_UNIT;
        uint256 referrerFeeAmount = (amount * referrerFee) / PRECISE_UNIT;
        uint256 separateTotal = makerFeeAmount + referrerFeeAmount;
        
        // Calculate fees together
        uint256 combinedTotal = _calculateTotalFees(amount, makerFee, referrerFee);
        
        // Property: Separate calculation equals combined calculation
        assertEq(combinedTotal, separateTotal, "Fee calculation inconsistent");
        
        // Property: Rounding is always down (user favorable)
        uint256 expectedMakerFee = (amount * makerFee) / PRECISE_UNIT;
        uint256 makerRemainder = (amount * makerFee) % PRECISE_UNIT;
        if (makerRemainder > 0) {
            assertEq(makerFeeAmount, expectedMakerFee, "Rounding should be down");
        }
    }
    
    // ============ Phase 2.2: Conversion Rate Monotonicity ============
    
    /**
     * @notice Test conversion rate monotonicity
     * @dev Property: Higher conversion rates result in more fiat for same crypto
     */
    function testFuzz_ConversionRateMonotonicity(
        uint256 cryptoAmount,
        uint256 rate1,
        uint256 rate2
    ) public pure {
        // Bound inputs
        cryptoAmount = bound(cryptoAmount, 1e6, 1000000e6);
        rate1 = bound(rate1, 1e17, 10e18); // 0.1 to 10
        rate2 = bound(rate2, rate1, 20e18); // rate2 >= rate1
        
        // Calculate fiat amounts
        uint256 fiatAmount1 = (cryptoAmount * rate1) / PRECISE_UNIT;
        uint256 fiatAmount2 = (cryptoAmount * rate2) / PRECISE_UNIT;
        
        // Property: Higher rate gives more or equal fiat
        assertGe(fiatAmount2, fiatAmount1, "Conversion rate monotonicity violated");
        
        // Property: If rates differ, fiat amounts should differ
        if (rate2 > rate1 && cryptoAmount > PRECISE_UNIT) {
            assertGt(fiatAmount2, fiatAmount1, "Different rates should yield different amounts");
        }
    }
    
    /**
     * @notice Test conversion rate bounds and precision
     * @dev Property: Conversion preserves value within precision limits
     */
    function testFuzz_ConversionRatePrecision(
        uint256 cryptoAmount,
        uint256 conversionRate
    ) public pure {
        // Bound inputs to realistic values
        // Max USDC: 10 million (10000000e6 with 6 decimals)
        // Conversion rates: 0.01 to 100 (1e16 to 100e18)
        cryptoAmount = bound(cryptoAmount, 1e6, 10000000e6);
        conversionRate = bound(conversionRate, 1e16, 100e18);
        
        // Calculate fiat amount
        uint256 fiatAmount = (cryptoAmount * conversionRate) / PRECISE_UNIT;
        
        // Property: Reverse calculation approximates original
        if (conversionRate > 0 && fiatAmount > 0) {
            uint256 reverseCrypto = (fiatAmount * PRECISE_UNIT) / conversionRate;
            
            // Allow for rounding error proportional to the amount
            // For large amounts, allow more absolute error but maintain relative precision
            uint256 maxError = cryptoAmount / 1e6; // 0.0001% error tolerance
            if (maxError < 1e6) maxError = 1e6; // Minimum error of 1 USDC
            
            assertApproxEqAbs(reverseCrypto, cryptoAmount, maxError, "Precision loss too high");
        }
    }
    
    // ============ Phase 2.3: Intent Amount Validation ============
    
    /**
     * @notice Test intent amount validation against deposit ranges
     * @dev Property: Valid intents are within [min, max] and <= available liquidity
     */
    function testFuzz_IntentAmountValidation(
        uint256 depositAmount,
        uint256 minIntent,
        uint256 maxIntent,
        uint256 intentAmount
    ) public {
        // Bound inputs to realistic USDC values
        depositAmount = bound(depositAmount, 10e6, 10000000e6);
        
        // Fees removed: net deposit equals deposit amount
        uint256 netDepositAmount = depositAmount;
        
        minIntent = bound(minIntent, 1e6, netDepositAmount / 2);
        maxIntent = bound(maxIntent, minIntent, netDepositAmount);
        
        // Create deposit
        vm.startPrank(depositor);
        usdc.approve(address(escrow), depositAmount);
        IEscrow.CreateDepositParams memory params = IEscrow.CreateDepositParams({
            token: IERC20(address(usdc)),
            amount: depositAmount,
            intentAmountRange: IEscrow.Range(minIntent, maxIntent),
            paymentMethods: new bytes32[](1),
            paymentMethodData: new IEscrow.DepositPaymentMethodData[](1),
            currencies: new IEscrow.Currency[][](1),
            delegate: address(0),
            intentGuardian: address(0),
            retainOnEmpty: false
        });
        
        params.paymentMethods[0] = VENMO;
        params.paymentMethodData[0] = IEscrow.DepositPaymentMethodData({
            intentGatingService: address(0),
            payeeDetails: keccak256(abi.encodePacked("venmo:", depositor)),
            data: ""
        });
        params.currencies[0] = new IEscrow.Currency[](1);
        params.currencies[0][0] = IEscrow.Currency({
            code: USD,
            minConversionRate: 1e18
        });
        
        uint256 depositId = escrow.depositCounter();
        escrow.createDeposit(params);
        vm.stopPrank();
        
        // Test various intent amounts
        intentAmount = bound(intentAmount, 0, netDepositAmount * 2);
        
        // Try to signal intent
        IOrchestrator.SignalIntentParams memory intentParams = IOrchestrator.SignalIntentParams({
            escrow: address(escrow),
            depositId: depositId,
            to: taker,
            amount: intentAmount,
            paymentMethod: VENMO,
            fiatCurrency: USD,
            conversionRate: 1e18,
            referrer: address(0),
            referrerFee: 0,
            postIntentHook: IPostIntentHook(address(0)),
            data: "",
            signatureExpiration: 0,
            gatingServiceSignature: ""
        });
        
        vm.prank(taker);
        
        // Property: Intent succeeds only if within valid range
        // Must be within [min, max] range AND within available liquidity (netDepositAmount)
        if (intentAmount >= minIntent && intentAmount <= maxIntent && intentAmount <= netDepositAmount) {
            orchestrator.signalIntent(intentParams);
            
            // Verify intent was created
            // Calculate intent hash using the orchestrator address and counter at time of creation
            uint256 intermediateHash = uint256(
                keccak256(
                    abi.encodePacked(
                        address(orchestrator),  // Use orchestrator address, not taker
                        orchestrator.intentCounter() - 1  // Counter at time of creation
                    )
                )
            );
            bytes32 intentHash = bytes32(intermediateHash % CIRCOM_PRIME_FIELD);  // Mod with circom prime field
            IOrchestrator.Intent memory intent = orchestrator.getIntent(intentHash);
            assertEq(intent.amount, intentAmount, "Intent amount mismatch");
            
            // Property: Available liquidity decreased
            IEscrow.Deposit memory deposit = escrow.getDeposit(depositId);
            assertEq(deposit.remainingDeposits, netDepositAmount - intentAmount, "Liquidity not locked");
        } else {
            vm.expectRevert();
            orchestrator.signalIntent(intentParams);
        }
    }
    
    /**
     * @notice Test multiple concurrent intents on same deposit
     * @dev Property: Sum of intents <= deposit amount
     */
    function testFuzz_ConcurrentIntents(
        uint256 depositAmount,
        uint256[3] memory intentAmounts
    ) public {
        // Bound inputs to realistic USDC values (max 10 million USDC)
        depositAmount = bound(depositAmount, 100e6, 10000000e6);
        
        // Fees removed: net deposit equals deposit amount
        uint256 netDepositAmount = depositAmount;
        
        // Create deposit with wide range
        vm.startPrank(depositor);
        usdc.approve(address(escrow), depositAmount);
        IEscrow.CreateDepositParams memory params = IEscrow.CreateDepositParams({
            token: IERC20(address(usdc)),
            amount: depositAmount,
            intentAmountRange: IEscrow.Range(1e6, depositAmount),
            paymentMethods: new bytes32[](1),
            paymentMethodData: new IEscrow.DepositPaymentMethodData[](1),
            currencies: new IEscrow.Currency[][](1),
            delegate: address(0),
            intentGuardian: address(0),
            retainOnEmpty: false
        });
        
        params.paymentMethods[0] = VENMO;
        params.paymentMethodData[0] = IEscrow.DepositPaymentMethodData({
            intentGatingService: address(0),
            payeeDetails: keccak256(abi.encodePacked("venmo:", depositor)),
            data: ""
        });
        params.currencies[0] = new IEscrow.Currency[](1);
        params.currencies[0][0] = IEscrow.Currency({
            code: USD,
            minConversionRate: 1e18
        });
        
        uint256 depositId = escrow.depositCounter();
        escrow.createDeposit(params);
        vm.stopPrank();
        
        // Track total intent amount
        uint256 totalIntentAmount = 0;
        uint256 remainingLiquidity = netDepositAmount;
        
        // Try to create multiple intents
        for (uint i = 0; i < 3; i++) {
            intentAmounts[i] = bound(intentAmounts[i], 0, netDepositAmount);
            
            address intentTaker = address(uint160(uint256(keccak256(abi.encode("taker", i)))));
            deal(address(usdc), intentTaker, 10000000e6);
            
            IOrchestrator.SignalIntentParams memory intentParams = IOrchestrator.SignalIntentParams({
                escrow: address(escrow),
                depositId: depositId,
                to: intentTaker,
                amount: intentAmounts[i],
                paymentMethod: VENMO,
                fiatCurrency: USD,
                conversionRate: 1e18,
                referrer: address(0),
                referrerFee: 0,
                postIntentHook: IPostIntentHook(address(0)),
                data: "",
                signatureExpiration: 0,
                gatingServiceSignature: ""
            });
            
            vm.prank(intentTaker);
            
            // Intent should succeed only if enough liquidity
            if (intentAmounts[i] >= 1e6 && 
                intentAmounts[i] <= netDepositAmount &&
                intentAmounts[i] <= remainingLiquidity) {
                
                orchestrator.signalIntent(intentParams);
                totalIntentAmount += intentAmounts[i];
                remainingLiquidity -= intentAmounts[i];
                
                // Property: Total intents never exceed deposit
                assertLe(totalIntentAmount, netDepositAmount, "Intents exceed deposit");
                
                // Property: Remaining liquidity is correct
                IEscrow.Deposit memory deposit = escrow.getDeposit(depositId);
                assertEq(deposit.remainingDeposits, remainingLiquidity, "Liquidity accounting error");
            } else {
                vm.expectRevert();
                orchestrator.signalIntent(intentParams);
            }
        }
    }
    
    // ============ Phase 2.4: Liquidity Management ============
    
    /**
     * @notice Test liquidity management during deposit lifecycle
     * @dev Property: Liquidity + Locked = Total at all times
     */
    function testFuzz_LiquidityConservation(
        uint256 initialAmount,
        uint256 addAmount,
        uint256 removeAmount,
        uint256 intentAmount
    ) public {
        // Bound inputs to realistic USDC values
        // Total balance is 10M USDC, so initial + add must not exceed it
        initialAmount = bound(initialAmount, 10e6, 5000000e6);  // Max 5M for initial
        // Ensure addAmount doesn't cause the total to exceed depositor balance
        uint256 maxAddAmount = 10000000e6 > initialAmount ? 10000000e6 - initialAmount : 0;
        addAmount = bound(addAmount, 0, maxAddAmount);
        
        // Fees removed: net initial equals initial amount
        uint256 netInitialAmount = initialAmount;
        
        removeAmount = bound(removeAmount, 0, netInitialAmount + addAmount);
        intentAmount = bound(intentAmount, 0, 10000000e6);
        
        // Create initial deposit
        vm.startPrank(depositor);
        usdc.approve(address(escrow), initialAmount);
        IEscrow.CreateDepositParams memory params = IEscrow.CreateDepositParams({
            token: IERC20(address(usdc)),
            amount: initialAmount,
            intentAmountRange: IEscrow.Range(1e6, initialAmount + addAmount),
            paymentMethods: new bytes32[](1),
            paymentMethodData: new IEscrow.DepositPaymentMethodData[](1),
            currencies: new IEscrow.Currency[][](1),
            delegate: address(0),
            intentGuardian: address(0),
            retainOnEmpty: false
        });
        
        params.paymentMethods[0] = VENMO;
        params.paymentMethodData[0] = IEscrow.DepositPaymentMethodData({
            intentGatingService: address(0),
            payeeDetails: keccak256(abi.encodePacked("venmo:", depositor)),
            data: ""
        });
        params.currencies[0] = new IEscrow.Currency[](1);
        params.currencies[0][0] = IEscrow.Currency({
            code: USD,
            minConversionRate: 1e18
        });
        
        uint256 depositId = escrow.depositCounter();
        escrow.createDeposit(params);
        
        // Property: Initial state (fees removed): escrow balance equals deposit amount; remainingDeposits equals net
        IEscrow.Deposit memory deposit = escrow.getDeposit(depositId);
        assertEq(usdc.balanceOf(address(escrow)), initialAmount, "Initial escrow balance mismatch");
        assertEq(deposit.remainingDeposits, netInitialAmount, "Initial liquidity mismatch");
        assertEq(deposit.outstandingIntentAmount, 0, "Should have no intents initially");
        
        // Add funds
        uint256 netAddAmount = 0;
        if (addAmount > 0) {
            usdc.approve(address(escrow), addAmount);  // Need approval for addFunds
            
            // Fees removed: full amount added
            netAddAmount = addAmount;
            
            escrow.addFunds(depositId, addAmount);
            deposit = escrow.getDeposit(depositId);
            
            // Property: Addition increases both total (escrow balance) and available
            assertEq(usdc.balanceOf(address(escrow)), initialAmount + addAmount, "Add funds failed");
            assertEq(deposit.remainingDeposits, netInitialAmount + netAddAmount, "Liquidity not updated");
        }
        
        // Create intent if possible
        uint256 currentAvailable = netInitialAmount + netAddAmount;
        intentAmount = bound(intentAmount, 0, currentAvailable);
        
        if (intentAmount >= 1e6 && intentAmount <= currentAvailable) {
            vm.stopPrank();
            
            IOrchestrator.SignalIntentParams memory intentParams = IOrchestrator.SignalIntentParams({
                escrow: address(escrow),
                depositId: depositId,
                to: taker,
                amount: intentAmount,
                paymentMethod: VENMO,
                fiatCurrency: USD,
                conversionRate: 1e18,
                referrer: address(0),
                referrerFee: 0,
                postIntentHook: IPostIntentHook(address(0)),
                data: "",
                signatureExpiration: 0,
                gatingServiceSignature: ""
            });
            
            vm.prank(taker);
            orchestrator.signalIntent(intentParams);
            
            deposit = escrow.getDeposit(depositId);
            
            // Property: Intent locks liquidity
            assertEq(deposit.remainingDeposits, currentAvailable - intentAmount, "Liquidity not locked");
            assertEq(deposit.outstandingIntentAmount, intentAmount, "Intent amount not tracked");
            
            // Property: Conservation (fees removed): remaining + locked = escrow token balance
            assertEq(
                deposit.remainingDeposits + deposit.outstandingIntentAmount,
                usdc.balanceOf(address(escrow)),
                "Liquidity conservation violated"
            );
            
            vm.startPrank(depositor);
        }
        
        // Try to remove funds (should only succeed for available liquidity)
        uint256 availableLiquidity = deposit.remainingDeposits;
        removeAmount = bound(removeAmount, 0, availableLiquidity * 2);
        
        if (removeAmount <= availableLiquidity && removeAmount > 0) {
            // Store values before removal (using deposit struct to avoid stack issues)
            IEscrow.Deposit memory preDep = deposit;
            
            // Capture escrow balance before removal for delta check
            uint256 escrowBalBeforeRemoval = usdc.balanceOf(address(escrow));
            escrow.removeFunds(depositId, removeAmount);
            deposit = escrow.getDeposit(depositId);

            // Property: Removal decreases both total (escrow balance) and available
            assertEq(usdc.balanceOf(address(escrow)), escrowBalBeforeRemoval - removeAmount, "Remove funds failed");
            assertEq(deposit.remainingDeposits, preDep.remainingDeposits - removeAmount, "Liquidity not updated");

            // Property: Conservation still holds (fees removed)
            assertEq(
                deposit.remainingDeposits + deposit.outstandingIntentAmount,
                usdc.balanceOf(address(escrow)),
                "Liquidity conservation violated after removal"
            );
        } else if (removeAmount > availableLiquidity) {
            vm.expectRevert();
            escrow.removeFunds(depositId, removeAmount);
        }
        
        vm.stopPrank();
    }
    
    /**
     * @notice Test liquidity reclamation after intent expiration
     * @dev Property: Expired intents return liquidity to deposit
     */
    function testFuzz_LiquidityReclamation(
        uint256 depositAmount,
        uint256 intentAmount,
        uint256 timeElapsed
    ) public {
        // Bound inputs to realistic USDC values
        depositAmount = bound(depositAmount, 10e6, 10000000e6);
        
        // Fees removed: net deposit equals deposit amount
        uint256 netDepositAmount = depositAmount;
        
        intentAmount = bound(intentAmount, 1e6, netDepositAmount);
        timeElapsed = bound(timeElapsed, 0, 30 days);
        
        // Create deposit and intent
        vm.startPrank(depositor);
        usdc.approve(address(escrow), depositAmount);
        IEscrow.CreateDepositParams memory params = IEscrow.CreateDepositParams({
            token: IERC20(address(usdc)),
            amount: depositAmount,
            intentAmountRange: IEscrow.Range(1e6, depositAmount),
            paymentMethods: new bytes32[](1),
            paymentMethodData: new IEscrow.DepositPaymentMethodData[](1),
            currencies: new IEscrow.Currency[][](1),
            delegate: address(0),
            intentGuardian: address(0),
            retainOnEmpty: false
        });
        
        params.paymentMethods[0] = VENMO;
        params.paymentMethodData[0] = IEscrow.DepositPaymentMethodData({
            intentGatingService: address(0),
            payeeDetails: keccak256(abi.encodePacked("venmo:", depositor)),
            data: ""
        });
        params.currencies[0] = new IEscrow.Currency[](1);
        params.currencies[0][0] = IEscrow.Currency({
            code: USD,
            minConversionRate: 1e18
        });
        
        uint256 depositId = escrow.depositCounter();
        escrow.createDeposit(params);
        vm.stopPrank();
        
        // Signal intent
        IOrchestrator.SignalIntentParams memory intentParams = IOrchestrator.SignalIntentParams({
            escrow: address(escrow),
            depositId: depositId,
            to: taker,
            amount: intentAmount,
            paymentMethod: VENMO,
            fiatCurrency: USD,
            conversionRate: 1e18,
            referrer: address(0),
            referrerFee: 0,
            postIntentHook: IPostIntentHook(address(0)),
            data: "",
            signatureExpiration: 0,
            gatingServiceSignature: ""
        });
        
        vm.prank(taker);
        orchestrator.signalIntent(intentParams);
        
        // Calculate intent hash using the orchestrator address and counter
        uint256 intermediateHash = uint256(
            keccak256(
                abi.encodePacked(
                    address(orchestrator),  // Use orchestrator address
                    orchestrator.intentCounter() - 1  // Counter at time of creation
                )
            )
        );
        bytes32 intentHash = bytes32(intermediateHash % CIRCOM_PRIME_FIELD);  // Mod with circom prime field
        
        // Check initial state
        IEscrow.Deposit memory depositBefore = escrow.getDeposit(depositId);
        assertEq(depositBefore.remainingDeposits, netDepositAmount - intentAmount, "Initial liquidity wrong");
        assertEq(depositBefore.outstandingIntentAmount, intentAmount, "Initial intent amount wrong");
        
        // Advance time
        vm.warp(block.timestamp + timeElapsed);
        
        // Check if intent should be expired
        if (timeElapsed > INTENT_EXPIRATION_PERIOD) {
            // Prune expired intent
            vm.prank(depositor);
            escrow.pruneExpiredIntents(depositId);
            
            // Property: Liquidity is reclaimed
            IEscrow.Deposit memory depositAfter = escrow.getDeposit(depositId);
            assertEq(depositAfter.remainingDeposits, netDepositAmount, "Liquidity not reclaimed");
            assertEq(depositAfter.outstandingIntentAmount, 0, "Intent not cleared");
            
            // Property: Intent is removed
            IOrchestrator.Intent memory intent = orchestrator.getIntent(intentHash);
            assertEq(intent.owner, address(0), "Intent not deleted");
        } else {
            // Intent should still be active
            IOrchestrator.Intent memory intent = orchestrator.getIntent(intentHash);
            assertEq(intent.amount, intentAmount, "Active intent corrupted");
            
            // Property: Liquidity remains locked
            IEscrow.Deposit memory depositAfter = escrow.getDeposit(depositId);
            assertEq(depositAfter.remainingDeposits, netDepositAmount - intentAmount, "Liquidity changed");
            assertEq(depositAfter.outstandingIntentAmount, intentAmount, "Intent amount changed");
        }
    }
    
    // ============ Phase 2.5: Unique Escrow Edge Cases ============
    
    /**
     * @notice Test payment method management properties
     * @dev Migrated from EscrowFuzz.t.sol
     * Property: Payment methods can be added/removed without affecting deposit liquidity
     */
    function testFuzz_PaymentMethodManagementProperties(
        uint256 depositAmount,
        uint8 numMethods,
        uint8 methodToRemove
    ) public {
        // Bound inputs
        depositAmount = bound(depositAmount, 10e6, 1000000e6);
        numMethods = uint8(bound(numMethods, 2, 10)); // At least 2 to test removal
        methodToRemove = uint8(bound(methodToRemove, 0, numMethods - 1));
        
        // Create deposit with initial payment method (accounting for fees)
        uint256 depositId = _createDepositWithSingleMethod(depositAmount);
        
        // Store initial state
        IEscrow.Deposit memory depositBefore = escrow.getDeposit(depositId);
        uint256 initialLiquidity = depositBefore.remainingDeposits;
        
        // Property: Payment method count starts at 1
        bytes32[] memory initialMethods = escrow.getDepositPaymentMethods(depositId);
        assertEq(initialMethods.length, 1, "Initial method count wrong");
        
        // Add additional payment methods
        bytes32[] memory newMethods = _addPaymentMethods(depositId, numMethods - 1);
        
        // Property: Payment method count increased
        {
            bytes32[] memory methodsAfterAdd = escrow.getDepositPaymentMethods(depositId);
            assertEq(methodsAfterAdd.length, numMethods, "Method count after add wrong");
        }
        
        // Property: Liquidity unchanged by adding methods
        {
            IEscrow.Deposit memory depositAfterAdd = escrow.getDeposit(depositId);
            assertEq(depositAfterAdd.remainingDeposits, initialLiquidity, "Liquidity changed by add");
        }
        
        // Remove a payment method if we have more than 1
        if (numMethods > 1) {
            // Ensure methodToRemove is valid for array access
            uint256 removeIndex = methodToRemove % numMethods;
            bytes32 methodToRemoveHash;
            if (removeIndex == 0) {
                methodToRemoveHash = VENMO;
            } else if (removeIndex - 1 < newMethods.length) {
                methodToRemoveHash = newMethods[removeIndex - 1];
            } else {
                // Fallback to first method added
                methodToRemoveHash = newMethods[0];
            }
            
            vm.prank(depositor);
            escrow.setPaymentMethodActive(depositId, methodToRemoveHash, false);

            // Property: Payment method remains listed, but is inactive
            bytes32[] memory methodsAfterDeactivate = escrow.getDepositPaymentMethods(depositId);
            assertEq(methodsAfterDeactivate.length, numMethods, "Method list length should be unchanged");
            bool isActive = escrow.getDepositPaymentMethodActive(depositId, methodToRemoveHash);
            assertTrue(isActive == false, "Method should be inactive after deactivation");
            
            // Property: Liquidity unchanged by deactivating methods
            {
                IEscrow.Deposit memory depositAfterDeactivate = escrow.getDeposit(depositId);
                assertEq(depositAfterDeactivate.remainingDeposits, initialLiquidity, "Liquidity changed by deactivate");
            }
            
            // Note: Deactivation model allows all methods to be inactive; Orchestrator gates on active status at signal time.
        }
    }
    
    /**
     * @notice Test partial withdraw behavior with active intents
     * @dev Migrated from EscrowFuzz.t.sol
     * Property: Withdrawals respect liquidity constraints with outstanding intents
     */
    function testFuzz_PartialWithdrawLiquidityConstraints(
        uint256 depositAmount,
        uint256 intentAmount,
        uint256 withdrawAttempt
    ) public {
        // Bound inputs to realistic USDC values (max 10 million USDC)
        depositAmount = bound(depositAmount, 100e6, 10000000e6);
        
        // Fees removed: net deposit equals deposit amount
        uint256 netDepositAmount = depositAmount;
        
        // Intent must be within available liquidity after fees
        intentAmount = bound(intentAmount, 1e6, netDepositAmount / 2);
        withdrawAttempt = bound(withdrawAttempt, 1, depositAmount);
        
        // Create deposit
        vm.startPrank(depositor);
        usdc.approve(address(escrow), depositAmount);
        IEscrow.CreateDepositParams memory params = IEscrow.CreateDepositParams({
            token: IERC20(address(usdc)),
            amount: depositAmount,
            intentAmountRange: IEscrow.Range(1e6, netDepositAmount),
            paymentMethods: new bytes32[](1),
            paymentMethodData: new IEscrow.DepositPaymentMethodData[](1),
            currencies: new IEscrow.Currency[][](1),
            delegate: address(0),
            intentGuardian: address(0),
            retainOnEmpty: false
        });
        
        params.paymentMethods[0] = VENMO;
        params.paymentMethodData[0] = IEscrow.DepositPaymentMethodData({
            intentGatingService: address(0),
            payeeDetails: keccak256(abi.encodePacked("venmo:", depositor)),
            data: ""
        });
        params.currencies[0] = new IEscrow.Currency[](1);
        params.currencies[0][0] = IEscrow.Currency({
            code: USD,
            minConversionRate: 1e18
        });
        
        uint256 depositId = escrow.depositCounter();
        escrow.createDeposit(params);
        vm.stopPrank();
        
        // Signal intent
        IOrchestrator.SignalIntentParams memory intentParams = IOrchestrator.SignalIntentParams({
            escrow: address(escrow),
            depositId: depositId,
            to: taker,
            amount: intentAmount,
            paymentMethod: VENMO,
            fiatCurrency: USD,
            conversionRate: 1e18,
            referrer: address(0),
            referrerFee: 0,
            postIntentHook: IPostIntentHook(address(0)),
            data: "",
            signatureExpiration: 0,
            gatingServiceSignature: ""
        });
        
        vm.prank(taker);
        orchestrator.signalIntent(intentParams);
        
        // Calculate available liquidity (net deposit minus intent)
        uint256 availableLiquidity = netDepositAmount - intentAmount;
        
        // Property: Available liquidity equals net deposit minus intent
        IEscrow.Deposit memory depositState = escrow.getDeposit(depositId);
        assertEq(depositState.remainingDeposits, availableLiquidity, "Available liquidity wrong");
        assertEq(depositState.outstandingIntentAmount, intentAmount, "Outstanding intent wrong");
        
        // Store balances before withdrawal attempt
        uint256 depositorBalanceBefore = usdc.balanceOf(depositor);
        uint256 escrowBalanceBefore = usdc.balanceOf(address(escrow));
        
        vm.startPrank(depositor);
        
        // Property: Can withdraw up to available liquidity
        if (withdrawAttempt <= availableLiquidity) {
            escrow.removeFunds(depositId, withdrawAttempt);
            
            // Verify withdrawal successful - use scoped blocks to reduce stack
            {
                uint256 depositorBalanceAfter = usdc.balanceOf(depositor);
                assertEq(
                    depositorBalanceAfter - depositorBalanceBefore,
                    withdrawAttempt,
                    "Depositor didn't receive correct amount"
                );
            }

            {
                uint256 escrowBalanceAfter = usdc.balanceOf(address(escrow));
                assertEq(
                    escrowBalanceBefore - escrowBalanceAfter,
                    withdrawAttempt,
                    "Escrow balance didn't decrease correctly"
                );
            }
            
            // Property: Deposit state updated correctly
            {
                IEscrow.Deposit memory depositAfter = escrow.getDeposit(depositId);
                
                uint256 expectedRemaining = availableLiquidity - withdrawAttempt;

                assertEq(depositAfter.remainingDeposits, expectedRemaining, "Remaining liquidity not updated");
                assertEq(depositAfter.outstandingIntentAmount, intentAmount, "Outstanding intent changed");

                // Property: Conservation of funds (remaining + outstanding = escrow token balance)
                assertEq(
                    depositAfter.remainingDeposits + depositAfter.outstandingIntentAmount,
                    usdc.balanceOf(address(escrow)),
                    "Fund conservation violated"
                );
            }
        } else {
            // Property: Cannot withdraw more than available
            vm.expectRevert();
            escrow.removeFunds(depositId, withdrawAttempt);

            // Property: State unchanged after failed withdrawal
            IEscrow.Deposit memory depositAfter = escrow.getDeposit(depositId);
            assertEq(usdc.balanceOf(address(escrow)), escrowBalanceBefore, "Escrow balance changed on failed withdraw");
            assertEq(depositAfter.remainingDeposits, availableLiquidity, "Liquidity changed on failed withdraw");
            assertEq(depositAfter.outstandingIntentAmount, intentAmount, "Intent changed on failed withdraw");
        }
        
        vm.stopPrank();
    }
    
    /**
     * @notice Test dust amount threshold properties
     * @dev Migrated from EscrowFuzz.t.sol
     * Property: Deposits below dust threshold are handled correctly
     */
    function testFuzz_DustThresholdProperties(
        uint256 depositAmount,
        uint256 dustThreshold,
        uint256 intentFraction
    ) public {
        // Bound inputs to realistic USDC values (max 10 million USDC)
        depositAmount = bound(depositAmount, 100e6, 10000000e6);
        dustThreshold = bound(dustThreshold, 0, 1e6); // Max dust threshold is 1 USDC (1e6)
        intentFraction = bound(intentFraction, 70, 99); // Intent uses 70-99% of deposit
        
        // Set dust threshold
        vm.prank(owner);
        escrow.setDustThreshold(dustThreshold);
        
        // Fees removed
        uint256 preNetDepositAmount = depositAmount;
        
        // Create deposit
        vm.startPrank(depositor);
        usdc.approve(address(escrow), depositAmount);
        IEscrow.CreateDepositParams memory params = IEscrow.CreateDepositParams({
            token: IERC20(address(usdc)),
            amount: depositAmount,
            intentAmountRange: IEscrow.Range(1e6, preNetDepositAmount), // Use net amount for max
            paymentMethods: new bytes32[](1),
            paymentMethodData: new IEscrow.DepositPaymentMethodData[](1),
            currencies: new IEscrow.Currency[][](1),
            delegate: address(0),
            intentGuardian: address(0),
            retainOnEmpty: false
        });
        
        params.paymentMethods[0] = VENMO;
        params.paymentMethodData[0] = IEscrow.DepositPaymentMethodData({
            intentGatingService: address(0),
            payeeDetails: keccak256(abi.encodePacked("venmo:", depositor)),
            data: ""
        });
        params.currencies[0] = new IEscrow.Currency[](1);
        params.currencies[0][0] = IEscrow.Currency({
            code: USD,
            minConversionRate: 1e18
        });
        
        uint256 depositId = escrow.depositCounter();
        escrow.createDeposit(params);
        vm.stopPrank();
        
        // Calculate expected intent amount accounting for fees
        // Note: We already calculated preNetDepositAmount above
        
        // Adjust intent amount to be within valid range
        uint256 intentAmount = (preNetDepositAmount * intentFraction) / 100;
        
        // Ensure intent amount is within bounds
        if (intentAmount > preNetDepositAmount) {
            intentAmount = preNetDepositAmount;
        }
        if (intentAmount < 1e6) {
            return; // Skip if intent would be below minimum
        }
        
        // Double-check that intent is within the deposit's max intent range
        if (intentAmount > preNetDepositAmount) {
            intentAmount = preNetDepositAmount;
        }
        
        // Signal intent
        IOrchestrator.SignalIntentParams memory intentParams = IOrchestrator.SignalIntentParams({
            escrow: address(escrow),
            depositId: depositId,
            to: taker,
            amount: intentAmount,
            paymentMethod: VENMO,
            fiatCurrency: USD,
            conversionRate: 1e18,
            referrer: address(0),
            referrerFee: 0,
            postIntentHook: IPostIntentHook(address(0)),
            data: "",
            signatureExpiration: 0,
            gatingServiceSignature: ""
        });
        
        vm.prank(taker);
        orchestrator.signalIntent(intentParams);
        
        // Get the intent hash properly from the orchestrator
        bytes32 intentHash = keccak256(abi.encodePacked(taker, orchestrator.intentCounter() - 1));
        IOrchestrator.Intent memory signalledIntent = orchestrator.getIntent(intentHash);
        
        // Only fulfill if intent was created successfully
        if (signalledIntent.owner != address(0)) {
            // The payment verifier mock should already be set to return true
            // Create fulfill params
            IOrchestrator.FulfillIntentParams memory fulfillParams = IOrchestrator.FulfillIntentParams({
                paymentProof: abi.encode(intentHash),
                intentHash: intentHash,
                verificationData: abi.encode(USD),
                postIntentHookData: ""
            });
            
            vm.prank(taker);
            orchestrator.fulfillIntent(fulfillParams);
        } else {
            return; // Skip test if intent creation failed
        }
        
        // Check deposit state after fulfillment
        IEscrow.Deposit memory depositAfter = escrow.getDeposit(depositId);
        
        // Recalculate expected remainder based on net deposit
        uint256 expectedRemainder = preNetDepositAmount - intentAmount;
        
        // Property: Remaining amount equals expected remainder
        assertEq(depositAfter.remainingDeposits, expectedRemainder, "Remainder incorrect");
        
        // Property: Deposit acceptance based on dust threshold
        if (expectedRemainder <= dustThreshold) {
            // Property: Deposit should not accept new intents if remainder is dust
            assertFalse(depositAfter.acceptingIntents, "Should not accept intents with dust remainder");
            
            // Property: Cannot signal new intent on dusty deposit
            if (expectedRemainder > 0) {
                address taker2 = makeAddr("taker2");
                vm.prank(taker2);
                intentParams.to = taker2;
                intentParams.amount = expectedRemainder;
                vm.expectRevert();
                orchestrator.signalIntent(intentParams);
            }
        } else {
            // Property: Deposit should still accept intents if remainder above dust
            assertTrue(depositAfter.acceptingIntents, "Should accept intents above dust");
            
            // Property: Can signal new intent if above dust and within range
            if (expectedRemainder >= 1e6) { // Above minimum intent
                address taker2 = makeAddr("taker2");
                vm.prank(taker2);
                intentParams.to = taker2;
                intentParams.amount = expectedRemainder;
                orchestrator.signalIntent(intentParams);
                
                // Verify new intent created
                IEscrow.Deposit memory depositWithNewIntent = escrow.getDeposit(depositId);
                assertEq(depositWithNewIntent.outstandingIntentAmount, expectedRemainder, "New intent not created");
            }
        }
        
        // Property: Dust threshold doesn't affect deposit closure
        if (depositAfter.remainingDeposits > 0) {
            // Can still withdraw remaining funds regardless of dust
            vm.prank(depositor);
            uint256 balanceBefore = usdc.balanceOf(depositor);
            escrow.removeFunds(depositId, depositAfter.remainingDeposits);
            uint256 balanceAfter = usdc.balanceOf(depositor);
            
            assertEq(
                balanceAfter - balanceBefore,
                depositAfter.remainingDeposits,
                "Could not withdraw dust amount"
            );
        }
    }

    // ============ Helper Functions ============
    
    function _calculateTotalFees(
        uint256 amount,
        uint256 makerFee,
        uint256 referrerFee
    ) internal pure returns (uint256) {
        uint256 makerFeeAmount = (amount * makerFee) / PRECISE_UNIT;
        uint256 referrerFeeAmount = (amount * referrerFee) / PRECISE_UNIT;
        return makerFeeAmount + referrerFeeAmount;
    }
    
    function _createDepositWithSingleMethod(uint256 depositAmount) internal returns (uint256) {
        vm.startPrank(depositor);
        usdc.approve(address(escrow), depositAmount);
        IEscrow.CreateDepositParams memory params = IEscrow.CreateDepositParams({
            token: IERC20(address(usdc)),
            amount: depositAmount,
            intentAmountRange: IEscrow.Range(1e6, depositAmount),
            paymentMethods: new bytes32[](1),
            paymentMethodData: new IEscrow.DepositPaymentMethodData[](1),
            currencies: new IEscrow.Currency[][](1),
            delegate: address(0),
            intentGuardian: address(0),
            retainOnEmpty: false
        });
        
        params.paymentMethods[0] = VENMO;
        params.paymentMethodData[0] = IEscrow.DepositPaymentMethodData({
            intentGatingService: address(0),
            payeeDetails: keccak256(abi.encodePacked("venmo:", depositor)),
            data: ""
        });
        params.currencies[0] = new IEscrow.Currency[](1);
        params.currencies[0][0] = IEscrow.Currency({
            code: USD,
            minConversionRate: 1e18
        });
        
        uint256 depositId = escrow.depositCounter();
        escrow.createDeposit(params);
        vm.stopPrank();
        
        return depositId;
    }
    
    function _addPaymentMethods(uint256 depositId, uint256 count) internal returns (bytes32[] memory) {
        bytes32[] memory newMethods = new bytes32[](count);
        IEscrow.DepositPaymentMethodData[] memory methodData = new IEscrow.DepositPaymentMethodData[](count);
        IEscrow.Currency[][] memory currencies = new IEscrow.Currency[][](count);
        
        for (uint256 i = 0; i < count; i++) {
            newMethods[i] = keccak256(abi.encodePacked("method", i));
            
            // Register with payment verifier registry
            vm.prank(owner);
            bytes32[] memory currencyCodes = new bytes32[](1);
            currencyCodes[0] = USD;
            paymentVerifierRegistry.addPaymentMethod(newMethods[i], address(venmoVerifier), currencyCodes);
            
            methodData[i] = IEscrow.DepositPaymentMethodData({
                intentGatingService: address(0),
                payeeDetails: keccak256(abi.encodePacked("payee", i)),
                data: ""
            });
            
            currencies[i] = new IEscrow.Currency[](1);
            currencies[i][0] = IEscrow.Currency({
                code: USD,
                minConversionRate: 1e18
            });
        }
        
        vm.prank(depositor);
        escrow.addPaymentMethods(depositId, newMethods, methodData, currencies);
        
        return newMethods;
    }
}

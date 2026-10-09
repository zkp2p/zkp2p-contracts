// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {StakeVault} from "contracts/StakeVault.sol";
import {DisputeProtectionPolicy} from "contracts/hooks/DisputeProtectionPolicy.sol";
import {IntentLifecycleHookV1} from "contracts/hooks/IntentLifecycleHookV1.sol";
import {WhitelistPolicy} from "contracts/hooks/WhitelistPolicy.sol";
import {IDisputeProtectionPolicy} from "contracts/interfaces/IDisputeProtectionPolicy.sol";
import {IStakeVault} from "contracts/interfaces/IStakeVault.sol";
import {IEscrowV2} from "contracts/interfaces/IEscrowV2.sol";
import {IOrchestratorV3} from "contracts/interfaces/IOrchestratorV3.sol";
import {IPostIntentHookV2} from "contracts/interfaces/IPostIntentHookV2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AddressGroupRegistry} from "contracts/registries/AddressGroupRegistry.sol";
import {NullifierRegistry} from "contracts/registries/NullifierRegistry.sol";
import {NullifierRegistryV2} from "contracts/registries/NullifierRegistryV2.sol";
import {DisputeVerifier} from "contracts/unifiedVerifier/DisputeVerifier.sol";
import {MultiAttestationVerifier} from "contracts/unifiedVerifier/MultiAttestationVerifier.sol";
import {UnifiedPaymentVerifierV4} from "contracts/unifiedVerifier/UnifiedPaymentVerifierV4.sol";
import {UnifiedPaymentVerifierV3} from "contracts/unifiedVerifier/UnifiedPaymentVerifierV3.sol";
import {OrchestratorV3Fixture} from "../helpers/OrchestratorV3Fixture.sol";

contract ValidationEnvelopePostHookMock is IPostIntentHookV2 {
    function execute(HookExecutionContext calldata context, bytes calldata) external {
        (, bytes memory hookData) = abi.decode(context.intent.signalHookData, (address, bytes));
        (, address recipient) = abi.decode(hookData, (bool, address));
        IERC20(context.token).transferFrom(msg.sender, recipient, context.executableAmount);
    }
}

contract DisputeWindowBypassTest is OrchestratorV3Fixture {
    event DisputeProtectionIntentStakeModeChanged(bytes32 indexed intentHash, address indexed stakeOwner, bool noStake);

    uint256 internal constant WITNESS_KEY = 0xA11CE;
    bytes32 internal constant PAYMENT_ID = keccak256("canonical-venmo-payment-id");
    uint64 internal constant RISK_WINDOW = 14 days;

    StakeVault internal vault;
    DisputeProtectionPolicy internal protection;
    NullifierRegistry internal disputeNullifiers;
    DisputeVerifier internal disputeVerifier;
    WhitelistPolicy internal whitelist;
    MultiAttestationVerifier internal witnesses;
    UnifiedPaymentVerifierV3 internal predecessor;
    UnifiedPaymentVerifierV4 internal upv;
    NullifierRegistryV2 internal nullifiers;
    IntentLifecycleHookV1 internal policy;
    IntentLifecycleHookV1 internal oldHook;

    function _defaultParams() internal view override returns (IOrchestratorV3.SignalIntentParams memory params) {
        params = super._defaultParams();
        params.data = abi.encode(address(protection), abi.encode(false));
    }

    function setUp() public override {
        vm.warp(1_000_000);
        super.setUp();
        address[] memory signers = new address[](1);
        signers[0] = vm.addr(WITNESS_KEY);
        witnesses = new MultiAttestationVerifier(signers, 1);
        nullifiers = new NullifierRegistryV2(new NullifierRegistry());
        predecessor = new UnifiedPaymentVerifierV3(orchestratorRegistry, nullifiers, witnesses);
        predecessor.addPaymentMethod(METHOD);
        paymentVerifierRegistry.removePaymentMethod(METHOD);
        bytes32[] memory currencies = new bytes32[](1);
        currencies[0] = USD;
        paymentVerifierRegistry.addPaymentMethod(METHOD, address(predecessor), currencies);

        vault = new StakeVault(address(this), token, address(0), 1 days);
        disputeNullifiers = new NullifierRegistry();
        disputeVerifier = new DisputeVerifier(address(this), nullifiers, witnesses);
        protection = new DisputeProtectionPolicy(address(this), vault, disputeVerifier, disputeNullifiers);
        vault.initializeController(address(protection));
        disputeNullifiers.addWritePermission(address(protection));
        protection.setRiskWindow(METHOD, RISK_WINDOW);
        upv = new UnifiedPaymentVerifierV4(orchestratorRegistry, nullifiers, witnesses);
        upv.addPaymentMethod(METHOD);
        nullifiers.addWritePermission(address(upv));
        _routeVerifier(address(upv));
        whitelist = new WhitelistPolicy(new AddressGroupRegistry(), escrowRegistry, orchestratorRegistry);
        oldHook = new IntentLifecycleHookV1(orchestratorRegistry, whitelist, protection);
        protection.setLifecycleHookAuthorization(address(oldHook), true);
        policy = new IntentLifecycleHookV1(orchestratorRegistry, whitelist, protection);
        protection.setLifecycleHookAuthorization(address(policy), true);
        orchestrator.setLifecycleHook(policy);
    }

    function test_NoStakeSignalHonorsAdmissionPauseAndDepositorOptOut() public {
        protection.setAdmissionsPaused(true);
        vm.expectRevert(IDisputeProtectionPolicy.AdmissionsPaused.selector);
        _signalCall(taker, _unstakedParams());
        protection.setAdmissionsPaused(false);

        vm.prank(depositor);
        protection.setDisputeProtectionEnabled(address(escrow), depositId, METHOD, false);
        bytes32 hash = _signalUnstaked();
        assertEq(
            uint256(protection.getDisputeProtectionIntent(hash).status),
            uint256(IDisputeProtectionPolicy.DisputeProtectionIntentStatus.NONE)
        );
        _settle(hash, _proof(hash, PAYMENT_ID, abi.encode(false)));
        assertEq(token.balanceOf(taker), INTENT_AMOUNT);
        assertEq(vault.lockedStake(taker), 0);
    }

    function testFuzz_StakeAndBypassAccounting(bool noStake, bool funded, bool bypass, uint96 release) public {
        uint256 releaseAmount = bound(release, 1, INTENT_AMOUNT);
        if (!noStake) _stake();
        bytes32 hash = noStake ? _signalUnstaked() : _signalDefault();
        if (noStake && funded) _stake();
        uint256 deposited = !noStake || funded ? 500e6 : 0;
        assertEq(vault.lockedStake(taker), noStake ? 0 : INTENT_AMOUNT);
        bytes memory proof = _signedProof(
            hash, _data(hash, PAYMENT_ID, abi.encode(bypass)), releaseAmount, WITNESS_KEY, upv.DOMAIN_SEPARATOR()
        );
        if (deposited == 0 && !bypass) {
            vm.expectRevert(abi.encodeWithSelector(IStakeVault.InsufficientFreeStake.selector, taker, 0, INTENT_AMOUNT));
            _setNoStake(hash, false);
            assertEq(token.balanceOf(taker), 0);
            assertEq(protection.getDisputeProtectionIntent(hash).stakeOwner, address(0));
            assertTrue(protection.getDisputeProtectionIntent(hash).noStake);
            assertEq(orchestrator.getIntent(hash).owner, taker);
            assertFalse(nullifiers.isNullified(keccak256(abi.encodePacked(METHOD, PAYMENT_ID))));
            return;
        }
        if (noStake != bypass) _setNoStake(hash, bypass);
        _settle(hash, proof);
        assertEq(protection.getDisputeProtectionIntent(hash).riskWindow, RISK_WINDOW);
        assertEq(token.balanceOf(taker), releaseAmount);
        assertEq(vault.lockedStake(taker), bypass ? 0 : releaseAmount);
        assertEq(vault.freeStake(taker), deposited - (bypass ? 0 : releaseAmount));
        assertEq(
            protection.getDisputeProtectionIntent(hash).releaseEligibleAt, block.timestamp + (bypass ? 0 : RISK_WINDOW)
        );
        assertEq(
            uint256(protection.getDisputeProtectionIntent(hash).status),
            uint256(
                bypass
                    ? IDisputeProtectionPolicy.DisputeProtectionIntentStatus.RELEASED
                    : IDisputeProtectionPolicy.DisputeProtectionIntentStatus.SETTLED
            )
        );
    }

    function testFuzz_SignedBypassDoesNotChangeSelectedMode(bool initiallyStaked) public {
        _stake();
        bytes32 hash = initiallyStaked ? _signalDefault() : _signalUnstaked();
        vm.prank(other);
        _settle(hash, _proof(hash, PAYMENT_ID, abi.encode(true)));
        assertEq(vault.lockedStake(taker), initiallyStaked ? INTENT_AMOUNT : 0);
        assertEq(vault.freeStake(taker), 500e6 - (initiallyStaked ? INTENT_AMOUNT : 0));
        assertEq(protection.getDisputeProtectionIntent(hash).riskWindow, RISK_WINDOW);
        assertEq(
            protection.getDisputeProtectionIntent(hash).releaseEligibleAt,
            block.timestamp + (initiallyStaked ? RISK_WINDOW : 0)
        );
        assertEq(token.balanceOf(taker), INTENT_AMOUNT);
    }

    function test_StakeModeChangesRequireTakerAndPreserveWindow() public {
        _stake();
        bytes32 hash = _signalUnstaked();
        vm.expectRevert("DPP: Only taker");
        vm.prank(other);
        protection.setIntentNoStake(orchestrator, hash, false);
        vm.expectRevert("DPP: Mode unchanged");
        _setNoStake(hash, true);

        vm.expectEmit(true, true, false, true, address(protection));
        emit DisputeProtectionIntentStakeModeChanged(hash, taker, false);
        _setNoStake(hash, false);
        assertFalse(protection.getDisputeProtectionIntent(hash).noStake);
        assertEq(vault.lockedStake(taker), INTENT_AMOUNT);
        vm.expectRevert("DPP: Only taker");
        vm.prank(other);
        protection.setIntentNoStake(orchestrator, hash, true);
        vm.expectRevert("DPP: Mode unchanged");
        _setNoStake(hash, false);

        vm.expectEmit(true, true, false, true, address(protection));
        emit DisputeProtectionIntentStakeModeChanged(hash, address(0), true);
        _setNoStake(hash, true);
        assertEq(vault.lockedStake(taker), 0);
        assertEq(protection.getDisputeProtectionIntent(hash).stakeOwner, address(0));
        assertTrue(protection.getDisputeProtectionIntent(hash).noStake);
        _setNoStake(hash, false);
        assertFalse(protection.getDisputeProtectionIntent(hash).noStake);
        assertEq(vault.lockedStake(taker), INTENT_AMOUNT);
        assertEq(protection.getDisputeProtectionIntent(hash).riskWindow, RISK_WINDOW);
    }

    function test_StakeModeCannotChangeAfterCancellationOrSettlement() public {
        _stake();
        for (uint256 i; i < 3; i++) {
            bytes32 hash = i == 2 ? _signalUnstaked() : _signalDefault();
            if (i == 0) {
                vm.prank(taker);
                orchestrator.cancelIntent(hash);
            } else {
                bytes memory proof = _proof(hash, keccak256(abi.encode(i)), abi.encode(i == 2));
                _settle(hash, proof);
            }
            vm.expectRevert("DPP: Intent not pending");
            _setNoStake(hash, i != 2);
        }
        assertEq(vault.lockedStake(taker), INTENT_AMOUNT);
    }

    function test_BypassUsesDecodedSignedBoolean() public {
        bytes32 hash = _signalUnstaked();
        bytes[4] memory suffixes = [bytes(""), abi.encode(false), abi.encode(uint256(2)), abi.encode(false, true)];
        for (uint256 i; i < suffixes.length; i++) {
            bytes memory proof = _proof(hash, PAYMENT_ID, suffixes[i]);
            if (i == 1 || i == 3) {
                vm.expectRevert("DPP: Payment cannot bypass");
            } else {
                vm.expectRevert();
            }
            _settle(hash, proof);
        }
        assertEq(protection.getDisputeProtectionIntent(hash).riskWindow, RISK_WINDOW);
        assertEq(token.balanceOf(taker), 0);
        assertFalse(nullifiers.isNullified(keccak256(abi.encodePacked(METHOD, PAYMENT_ID))));

        _settle(hash, _proof(hash, PAYMENT_ID, abi.encode(true, false)));
        assertEq(token.balanceOf(taker), INTENT_AMOUNT);
        assertEq(vault.lockedStake(taker), 0);
    }

    function test_BypassRollsBackOnBadSignatureTamperingAndMismatchedIntent() public {
        bytes32 hash = _signalUnstaked();
        bytes memory proof =
            _signedProof(hash, _data(hash, PAYMENT_ID, abi.encode(true)), INTENT_AMOUNT, 0xBAD, upv.DOMAIN_SEPARATOR());
        vm.expectRevert("ThresholdSigVerifierUtils: Not enough valid witness signatures");
        _settle(hash, proof);
        UnifiedPaymentVerifierV3.PaymentAttestation memory attestation =
            abi.decode(_proof(hash, PAYMENT_ID, abi.encode(false)), (UnifiedPaymentVerifierV3.PaymentAttestation));
        attestation.data = _data(hash, PAYMENT_ID, abi.encode(true));
        vm.expectRevert("UPV: Data hash mismatch");
        _settle(hash, abi.encode(attestation));
        bytes32 otherHash = _signalUnstaked();
        proof = _proof(otherHash, PAYMENT_ID, abi.encode(true));
        vm.expectRevert("UPV: Attestation hash mismatch");
        _settle(hash, proof);
        assertEq(protection.getDisputeProtectionIntent(hash).riskWindow, RISK_WINDOW);
        assertEq(
            uint256(protection.getDisputeProtectionIntent(hash).status),
            uint256(IDisputeProtectionPolicy.DisputeProtectionIntentStatus.PENDING)
        );
        assertEq(orchestrator.getIntent(hash).owner, taker);
        assertFalse(nullifiers.isNullified(keccak256(abi.encodePacked(METHOD, PAYMENT_ID))));
    }

    function test_BypassUsesNormalFulfillmentAndVerifiesSignaturesOnce() public {
        bytes32 hash = _signalUnstaked();
        bytes memory proof = _proof(hash, PAYMENT_ID, abi.encode(true));
        vm.expectCall(
            address(protection),
            abi.encodeWithSelector(
                protection.validatePayment.selector, hash, _data(hash, PAYMENT_ID, abi.encode(true)), abi.encode(true)
            ),
            1
        );
        vm.expectCall(address(witnesses), abi.encodeWithSelector(witnesses.verify.selector), 1);
        _settle(hash, proof);
        assertEq(protection.getDisputeProtectionIntent(hash).riskWindow, RISK_WINDOW);
        assertEq(protection.getDisputeProtectionIntent(hash).releaseEligibleAt, block.timestamp);
    }

    function test_BypassRejectsUnregisteredOrchestratorAndUnauthorizedHook() public {
        bytes32 hash = _signalUnstaked();
        bytes memory proof = _proof(hash, PAYMENT_ID, abi.encode(true));
        vm.mockCall(
            other,
            abi.encodeWithSelector(IOrchestratorV3.getIntentLifecycleHook.selector, hash),
            abi.encode(address(policy))
        );
        vm.expectRevert("DPP: Unregistered orchestrator");
        vm.prank(taker);
        protection.setIntentNoStake(IOrchestratorV3(other), hash, false);
        protection.setLifecycleHookAuthorization(address(policy), false);
        vm.expectRevert(
            abi.encodeWithSelector(IDisputeProtectionPolicy.UnauthorizedLifecycleHook.selector, address(policy))
        );
        _settle(hash, proof);
        vm.expectRevert(
            abi.encodeWithSelector(IDisputeProtectionPolicy.UnauthorizedLifecycleHook.selector, address(policy))
        );
        _setNoStake(hash, false);
        assertEq(protection.getDisputeProtectionIntent(hash).riskWindow, RISK_WINDOW);
        assertFalse(nullifiers.isNullified(keccak256(abi.encodePacked(METHOD, PAYMENT_ID))));
    }

    function test_BypassOfAnotherIntentDoesNotApplyToDefaultPayment() public {
        bytes32 bypassHash = _signalUnstaked();
        _settle(bypassHash, _proof(bypassHash, PAYMENT_ID, abi.encode(true)));
        bytes32 hash = _signalUnstaked();
        bytes memory proof = _proof(hash, keccak256("different-payment"), abi.encode(false));
        vm.expectRevert("DPP: Payment cannot bypass");
        _settle(hash, proof);
        assertEq(protection.getDisputeProtectionIntent(hash).riskWindow, RISK_WINDOW);
        _stake();
        _setNoStake(hash, false);
        _settle(hash, proof);
        assertEq(vault.lockedStake(taker), INTENT_AMOUNT);
        assertEq(protection.getDisputeProtectionIntent(hash).releaseEligibleAt, block.timestamp + RISK_WINDOW);
    }

    function test_ExplicitStakeSwitchKeepsSavedWindowAndSettlementResizesLock() public {
        bytes32 hash = _signalUnstaked();
        protection.setRiskWindow(METHOD, 0);
        protection.setAdmissionsPaused(true);
        vm.prank(depositor);
        protection.setDisputeProtectionEnabled(address(escrow), depositId, METHOD, false);
        _stake();
        assertEq(vault.lockedStake(taker), 0);
        bytes memory proof =
            _signedProof(hash, _data(hash, PAYMENT_ID, abi.encode(false)), 40e6, WITNESS_KEY, upv.DOMAIN_SEPARATOR());
        vm.expectRevert("DPP: Payment cannot bypass");
        _settle(hash, proof);
        _setNoStake(hash, false);
        assertFalse(protection.getDisputeProtectionIntent(hash).noStake);
        assertEq(vault.lockedStake(taker), INTENT_AMOUNT);
        _settle(hash, proof);
        assertEq(vault.lockedStake(taker), 40e6);
        assertEq(vault.freeStake(taker), 460e6);
        assertEq(protection.getDisputeProtectionIntent(hash).stakeOwner, taker);
        assertFalse(protection.getDisputeProtectionIntent(hash).noStake);
        assertEq(protection.getDisputeProtectionIntent(hash).riskWindow, RISK_WINDOW);
        assertEq(protection.getDisputeProtectionIntent(hash).releaseEligibleAt, block.timestamp + RISK_WINDOW);
    }

    function test_StakeSwitchCannotReuseTheSameFreeStake() public {
        bytes32 first = _signalUnstaked();
        bytes32 second = _signalUnstaked();
        token.transfer(taker, INTENT_AMOUNT);
        vm.startPrank(taker);
        token.approve(address(vault), INTENT_AMOUNT);
        vault.depositStake(INTENT_AMOUNT);
        vm.stopPrank();
        _setNoStake(first, false);
        _settle(first, _proof(first, PAYMENT_ID, abi.encode(false)));
        bytes32 secondPayment = keccak256("second-payment");
        vm.expectRevert(abi.encodeWithSelector(IStakeVault.InsufficientFreeStake.selector, taker, 0, INTENT_AMOUNT));
        _setNoStake(second, false);
        assertEq(vault.lockedStake(taker), INTENT_AMOUNT);
        assertEq(vault.freeStake(taker), 0);
        assertEq(orchestrator.getIntent(second).owner, taker);
        assertFalse(nullifiers.isNullified(keccak256(abi.encodePacked(METHOD, secondPayment))));
    }

    function test_CancelAndManualReleaseForUnstakedAndStakedIntents() public {
        _stake();
        for (uint256 i; i < 4; i++) {
            bytes32 hash = i < 2 ? _signalUnstaked() : _signalDefault();
            if (i % 2 == 0) {
                vm.prank(taker);
                orchestrator.cancelIntent(hash);
                assertEq(
                    uint256(protection.getDisputeProtectionIntent(hash).status),
                    uint256(IDisputeProtectionPolicy.DisputeProtectionIntentStatus.CANCELLED)
                );
            } else {
                vm.prank(depositor);
                orchestrator.releaseFundsToPayer(hash);
                assertEq(
                    protection.getDisputeProtectionIntent(hash).releaseEligibleAt,
                    block.timestamp + (i < 2 ? 0 : RISK_WINDOW)
                );
            }
        }
        assertEq(vault.lockedStake(taker), INTENT_AMOUNT);
        assertEq(token.balanceOf(taker), 2 * INTENT_AMOUNT);
    }

    function test_NoStakeAdmissionFollowsStakedAccessOnWhitelistEnabledDeposit() public {
        vm.prank(depositor);
        whitelist.setEnabled(address(escrow), depositId, METHOD, true);
        assertFalse(whitelist.isTakerAllowed(address(escrow), depositId, METHOD, taker));
        bytes32 hash = _signalUnstaked();
        assertEq(
            uint256(protection.getDisputeProtectionIntent(hash).status),
            uint256(IDisputeProtectionPolicy.DisputeProtectionIntentStatus.PENDING)
        );
        assertEq(protection.getDisputeProtectionIntent(hash).stakeOwner, address(0));
        assertTrue(protection.getDisputeProtectionIntent(hash).noStake);
        assertEq(vault.lockedStake(taker), 0);

        bytes memory proof = _proof(hash, PAYMENT_ID, abi.encode(false));
        vm.expectRevert("DPP: Payment cannot bypass");
        _settle(hash, proof);
        assertFalse(nullifiers.isNullified(keccak256(abi.encodePacked(METHOD, PAYMENT_ID))));

        _settle(hash, _proof(hash, PAYMENT_ID, abi.encode(true)));
        assertEq(
            uint256(protection.getDisputeProtectionIntent(hash).status),
            uint256(IDisputeProtectionPolicy.DisputeProtectionIntentStatus.RELEASED)
        );
        assertEq(protection.getDisputeProtectionIntent(hash).stakeOwner, address(0));
        assertTrue(protection.getDisputeProtectionIntent(hash).noStake);
        assertEq(protection.getDisputeProtectionIntent(hash).releaseAmount, INTENT_AMOUNT);
        assertEq(vault.lockedStake(taker), 0);
        assertEq(token.balanceOf(taker), INTENT_AMOUNT);
    }

    function test_ModeChangeToNoStakeAllowedOnWhitelistEnabledDeposit() public {
        vm.prank(depositor);
        whitelist.setEnabled(address(escrow), depositId, METHOD, true);
        assertFalse(whitelist.isTakerAllowed(address(escrow), depositId, METHOD, taker));
        _stake();
        bytes32 hash = _signalDefault();
        assertEq(vault.lockedStake(taker), INTENT_AMOUNT);
        _setNoStake(hash, true);
        assertEq(vault.lockedStake(taker), 0);
        assertEq(vault.freeStake(taker), 500e6);
        assertEq(protection.getDisputeProtectionIntent(hash).stakeOwner, address(0));
        assertTrue(protection.getDisputeProtectionIntent(hash).noStake);
    }

    function test_ModeChangeToNoStakeDoesNotReadOrchestrator() public {
        _stake();
        bytes32 hash = _signalDefault();
        assertEq(vault.lockedStake(taker), INTENT_AMOUNT);
        vm.prank(taker);
        protection.setIntentNoStake(IOrchestratorV3(other), hash, true);
        assertEq(vault.lockedStake(taker), 0);
        assertEq(vault.freeStake(taker), 500e6);
        assertEq(protection.getDisputeProtectionIntent(hash).stakeOwner, address(0));
        assertTrue(protection.getDisputeProtectionIntent(hash).noStake);
    }

    function testFuzz_PayoutFailureRollsBackCollateralPaymentAndWindow(bool bypass) public {
        bytes32 hash = _signalUnstaked();
        _stake();
        if (!bypass) _setNoStake(hash, false);
        bytes memory proof = _proof(hash, PAYMENT_ID, abi.encode(bypass));
        vm.mockCallRevert(
            address(token),
            abi.encodeWithSignature("transfer(address,uint256)", taker, INTENT_AMOUNT),
            abi.encodeWithSignature("Error(string)", "payout failed")
        );
        vm.expectRevert("payout failed");
        _settle(hash, proof);
        assertEq(vault.lockedStake(taker), bypass ? 0 : INTENT_AMOUNT);
        assertEq(vault.freeStake(taker), bypass ? 500e6 : 450e6);
        assertEq(protection.getDisputeProtectionIntent(hash).stakeOwner, bypass ? address(0) : taker);
        assertEq(protection.getDisputeProtectionIntent(hash).noStake, bypass);
        assertEq(orchestrator.getIntent(hash).owner, taker);
        assertFalse(nullifiers.isNullified(keccak256(abi.encodePacked(METHOD, PAYMENT_ID))));
        assertEq(protection.getDisputeProtectionIntent(hash).riskWindow, RISK_WINDOW);
        vm.clearMockedCalls();
        _settle(hash, proof);
        assertEq(vault.lockedStake(taker), bypass ? 0 : INTENT_AMOUNT);
        assertEq(protection.getDisputeProtectionIntent(hash).riskWindow, RISK_WINDOW);
        assertEq(token.balanceOf(taker), INTENT_AMOUNT);
    }

    function test_StakeSwitchUsesCurrentSponsorAuthorizationAndSnapshottedHook() public {
        token.transfer(other, 100e6);
        vm.startPrank(other);
        token.approve(address(vault), 100e6);
        vault.depositStake(100e6);
        vault.setTakerAuthorization(taker, true);
        vm.stopPrank();
        vm.prank(taker);
        vault.selectStakeOwner(other);
        bytes32 hash = _signalUnstaked();
        orchestrator.setLifecycleHook(oldHook);
        bytes memory proof = _proof(hash, PAYMENT_ID, abi.encode(false));
        vm.prank(other);
        vault.setTakerAuthorization(taker, false);
        vm.expectRevert(abi.encodeWithSelector(IStakeVault.InsufficientFreeStake.selector, taker, 0, INTENT_AMOUNT));
        _setNoStake(hash, false);
        vm.prank(other);
        vault.setTakerAuthorization(taker, true);
        vm.prank(taker);
        vault.selectStakeOwner(other);
        _setNoStake(hash, false);
        vm.prank(other);
        vault.setTakerAuthorization(taker, false);
        _settle(hash, proof);
        assertEq(protection.getDisputeProtectionIntent(hash).stakeOwner, other);
        assertFalse(protection.getDisputeProtectionIntent(hash).noStake);
        assertEq(vault.lockedStake(other), INTENT_AMOUNT);
        assertEq(vault.freeStake(other), 50e6);
    }

    function test_AnyWindowedMethodCanDeferStakeAndBypassWindow() public {
        bytes32[2] memory methods = [keccak256("paypal"), keccak256("another-method")];
        _stake();
        for (uint256 i; i < methods.length; i++) {
            bytes32 method = methods[i];
            upv.addPaymentMethod(method);
            bytes32[] memory supportedCurrencies = new bytes32[](1);
            supportedCurrencies[0] = USD;
            paymentVerifierRegistry.addPaymentMethod(method, address(upv), supportedCurrencies);
            bytes32[] memory depositMethods = new bytes32[](1);
            depositMethods[0] = method;
            IEscrowV2.DepositPaymentMethodData[] memory methodData = new IEscrowV2.DepositPaymentMethodData[](1);
            methodData[0] = IEscrowV2.DepositPaymentMethodData(address(0), PAYEE, "");
            IEscrowV2.Currency[][] memory currencies = new IEscrowV2.Currency[][](1);
            currencies[0] = new IEscrowV2.Currency[](1);
            currencies[0][0] = IEscrowV2.Currency(USD, CONVERSION_RATE, _emptyOracle());
            vm.prank(depositor);
            escrow.addPaymentMethods(depositId, depositMethods, methodData, currencies);
            protection.setRiskWindow(method, RISK_WINDOW);
            IOrchestratorV3.SignalIntentParams memory params = _unstakedParams();
            params.paymentMethod = method;
            bytes32 hash = _signal(taker, params);
            assertEq(protection.getDisputeProtectionIntent(hash).stakeOwner, address(0));
            assertTrue(protection.getDisputeProtectionIntent(hash).noStake);
            _settle(hash, _proof(hash, PAYMENT_ID, abi.encode(true)));
            assertEq(protection.getDisputeProtectionIntent(hash).releaseEligibleAt, block.timestamp);
            assertEq(vault.lockedStake(taker), i * INTENT_AMOUNT);

            hash = _signal(taker, params);
            _setNoStake(hash, false);
            _settle(hash, _proof(hash, keccak256("non-bypass-payment"), abi.encode(false)));
            assertEq(protection.getDisputeProtectionIntent(hash).releaseEligibleAt, block.timestamp + RISK_WINDOW);
            assertEq(vault.lockedStake(taker), (i + 1) * INTENT_AMOUNT);

            protection.setRiskWindow(method, 0);
            hash = _signal(taker, params);
            assertEq(
                uint256(protection.getDisputeProtectionIntent(hash).status),
                uint256(IDisputeProtectionPolicy.DisputeProtectionIntentStatus.NONE)
            );
        }
    }

    function test_ServiceSignedProofSmoke() public {
        string memory attestor = vm.envOr("ATTESTOR_POLICY_SMOKE_ROOT", string(""));
        if (bytes(attestor).length == 0) {
            vm.skip(true);
            return;
        }
        assertEq(block.chainid, 31337);
        _stake();
        string[3] memory modes = [string("personal"), "goods", "balance"];
        for (uint256 i; i < modes.length; i++) {
            bytes32 hash = _signalUnstaked();
            IOrchestratorV3.Intent memory intent = orchestrator.getIntent(hash);
            string[] memory command = new string[](11);
            command[0] = "node";
            command[1] = string.concat(attestor, "/node_modules/tsx/dist/cli.mjs");
            command[2] = "--tsconfig";
            command[3] = string.concat(attestor, "/tsconfig.json");
            command[4] = string.concat(attestor, "/scripts/stake-policy-smoke.ts");
            command[5] = vm.toString(address(upv));
            command[6] = vm.toString(hash);
            command[7] = vm.toString(intent.amount);
            command[8] = vm.toString(intent.timestamp);
            command[9] = modes[i];
            command[10] = vm.toString(i);
            bytes memory proof = vm.ffi(command);
            UnifiedPaymentVerifierV3.PaymentAttestation memory attestation =
                abi.decode(proof, (UnifiedPaymentVerifierV3.PaymentAttestation));
            assertEq(attestation.data.length, 480);
            if (i != 2) _setNoStake(hash, false);
            _settle(hash, proof);
            assertEq(attestation.releaseAmount, i == 1 ? 45e6 : 50e6);
            assertEq(
                protection.getDisputeProtectionIntent(hash).releaseEligibleAt,
                block.timestamp + (i == 2 ? 0 : RISK_WINDOW)
            );
        }
        assertEq(token.balanceOf(taker), 145e6);
        assertEq(vault.lockedStake(taker), 95e6);
    }

    function test_ControllerHandoverWithPendingIntentRevertsFulfillmentAndCancellation() public {
        _stake();
        bytes32 hash = _signalDefault();
        bytes memory proof = _proof(hash, PAYMENT_ID, abi.encode(false));
        DisputeProtectionPolicy successor =
            new DisputeProtectionPolicy(address(this), vault, disputeVerifier, disputeNullifiers);
        vault.proposeController(address(successor));
        vm.warp(vault.pendingControllerValidAt());
        successor.acceptVaultController();

        vm.expectRevert(abi.encodeWithSelector(IStakeVault.UnauthorizedController.selector, address(protection)));
        _settle(hash, proof);
        vm.expectRevert(abi.encodeWithSelector(IStakeVault.UnauthorizedController.selector, address(protection)));
        vm.prank(taker);
        orchestrator.cancelIntent(hash);

        assertEq(orchestrator.getIntent(hash).owner, taker);
        assertEq(vault.lockedStake(taker), INTENT_AMOUNT);
        assertEq(token.balanceOf(taker), 0);
        assertFalse(nullifiers.isNullified(keccak256(abi.encodePacked(METHOD, PAYMENT_ID))));
        assertEq(
            uint256(protection.getDisputeProtectionIntent(hash).status),
            uint256(IDisputeProtectionPolicy.DisputeProtectionIntentStatus.PENDING)
        );
    }

    function test_VerifierCutoverRequiresV4SignatureForPendingIntent() public {
        _stake();
        _routeVerifier(address(predecessor));
        nullifiers.addWritePermission(address(predecessor));
        bytes32 hash = _signalDefault();
        bytes memory data = _data(hash, PAYMENT_ID, abi.encode(false));
        bytes memory issuedProof = _signedProof(hash, data, INTENT_AMOUNT, WITNESS_KEY, predecessor.DOMAIN_SEPARATOR());

        _routeVerifier(address(upv));
        nullifiers.removeWritePermission(address(predecessor));
        vm.expectRevert("ThresholdSigVerifierUtils: Not enough valid witness signatures");
        _settle(hash, issuedProof);
        assertEq(orchestrator.getIntent(hash).owner, taker);
        assertFalse(nullifiers.isNullified(keccak256(abi.encodePacked(METHOD, PAYMENT_ID))));

        _settle(hash, _proof(hash, PAYMENT_ID, abi.encode(false)));
        assertEq(vault.lockedStake(taker), INTENT_AMOUNT);
        assertEq(protection.getDisputeProtectionIntent(hash).releaseEligibleAt, block.timestamp + RISK_WINDOW);
        assertEq(token.balanceOf(taker), INTENT_AMOUNT);
    }

    function test_PaymentConsumedByV3CannotReplayThroughV4() public {
        _stake();
        _routeVerifier(address(predecessor));
        nullifiers.addWritePermission(address(predecessor));
        bytes32 first = _signalDefault();
        _settle(
            first,
            _signedProof(
                first, _data(first, PAYMENT_ID, ""), INTENT_AMOUNT, WITNESS_KEY, predecessor.DOMAIN_SEPARATOR()
            )
        );
        _routeVerifier(address(upv));
        nullifiers.removeWritePermission(address(predecessor));
        bytes32 second = _signalDefault();
        bytes memory proof = _proof(second, PAYMENT_ID, "");
        vm.expectRevert("Nullifier has already been used");
        _settle(second, proof);
        assertEq(nullifiers.intentHashByNullifier(keccak256(abi.encodePacked(METHOD, PAYMENT_ID))), first);
        assertEq(orchestrator.getIntent(second).owner, taker);
    }

    function test_ProtectedAdmissionRequiresCanonicalValidatorInBothStakeModes() public {
        _stake();
        for (uint256 i; i < 2; i++) {
            IOrchestratorV3.SignalIntentParams memory params = i == 0 ? _defaultParams() : _unstakedParams();
            params.data = "";
            vm.expectRevert();
            _signalCall(taker, params);
            params.data = abi.encode(other, abi.encode(i == 1));
            vm.expectRevert("ILH: Invalid payment validation hook");
            _signalCall(taker, params);
            params.data = abi.encode(address(protection), abi.encode(uint256(2)));
            vm.expectRevert();
            _signalCall(taker, params);
        }
        assertEq(vault.lockedStake(taker), 0);
    }

    function testFuzz_PostHookSupportsExplicitStakeModes(bool initiallyNoStake, bool finalNoStake) public {
        _stake();
        IOrchestratorV3.SignalIntentParams memory params = _defaultParams();
        params.postIntentHook = new ValidationEnvelopePostHookMock();
        params.data = abi.encode(address(protection), abi.encode(initiallyNoStake, other));
        bytes32 hash = _signal(taker, params);
        if (initiallyNoStake != finalNoStake) _setNoStake(hash, finalNoStake);
        if (finalNoStake) {
            bytes memory invalidProof = _proof(hash, PAYMENT_ID, abi.encode(false));
            vm.expectRevert("DPP: Payment cannot bypass");
            _settle(hash, invalidProof);
        }
        _settle(hash, _proof(hash, PAYMENT_ID, abi.encode(finalNoStake)));
        assertEq(token.balanceOf(other), INTENT_AMOUNT);
        assertEq(token.balanceOf(address(protection)), 0);
        assertEq(vault.lockedStake(taker), finalNoStake ? 0 : INTENT_AMOUNT);
        assertEq(vault.freeStake(taker), finalNoStake ? 500e6 : 450e6);
        assertEq(protection.getDisputeProtectionIntent(hash).riskWindow, RISK_WINDOW);
        assertEq(
            protection.getDisputeProtectionIntent(hash).releaseEligibleAt,
            block.timestamp + (finalNoStake ? 0 : RISK_WINDOW)
        );
    }

    function test_NoStakePostHookFailureRollsBackFulfillment() public {
        _stake();
        IOrchestratorV3.SignalIntentParams memory params = _defaultParams();
        params.postIntentHook = new ValidationEnvelopePostHookMock();
        params.data = abi.encode(address(protection), abi.encode(false, other));
        bytes32 hash = _signal(taker, params);
        _setNoStake(hash, true);
        bytes memory proof = _proof(hash, PAYMENT_ID, abi.encode(true));
        vm.mockCallRevert(
            address(token),
            abi.encodeWithSelector(IERC20.transferFrom.selector, address(orchestrator), other, INTENT_AMOUNT),
            abi.encodeWithSignature("Error(string)", "post hook payout failed")
        );
        vm.expectRevert("post hook payout failed");
        _settle(hash, proof);
        assertEq(
            uint256(protection.getDisputeProtectionIntent(hash).status),
            uint256(IDisputeProtectionPolicy.DisputeProtectionIntentStatus.PENDING)
        );
        assertEq(protection.getDisputeProtectionIntent(hash).stakeOwner, address(0));
        assertTrue(protection.getDisputeProtectionIntent(hash).noStake);
        assertEq(vault.lockedStake(taker), 0);
        assertEq(vault.freeStake(taker), 500e6);
        assertEq(orchestrator.getIntent(hash).owner, taker);
        assertEq(token.balanceOf(other), 0);
        assertFalse(nullifiers.isNullified(keccak256(abi.encodePacked(METHOD, PAYMENT_ID))));
        vm.clearMockedCalls();
        _settle(hash, proof);
        assertEq(token.balanceOf(other), INTENT_AMOUNT);
    }

    function _routeVerifier(address verifierAddress) internal {
        paymentVerifierRegistry.removePaymentMethod(METHOD);
        bytes32[] memory currencies = new bytes32[](1);
        currencies[0] = USD;
        paymentVerifierRegistry.addPaymentMethod(METHOD, verifierAddress, currencies);
    }

    function _setNoStake(bytes32 intentHash, bool noStake) internal {
        vm.prank(taker);
        protection.setIntentNoStake(orchestrator, intentHash, noStake);
    }

    function _stake() internal {
        token.transfer(taker, 500e6);
        vm.startPrank(taker);
        token.approve(address(vault), 500e6);
        vault.depositStake(500e6);
        vm.stopPrank();
    }

    function _signalUnstaked() internal returns (bytes32) {
        return _signal(taker, _unstakedParams());
    }

    function _unstakedParams() internal view returns (IOrchestratorV3.SignalIntentParams memory params) {
        params = _defaultParams();
        params.data = abi.encode(address(protection), abi.encode(true));
    }

    function _data(bytes32 intentHash, bytes32 paymentId, bytes memory suffix) internal view returns (bytes memory) {
        IOrchestratorV3.Intent memory intent = orchestrator.getIntent(intentHash);
        return bytes.concat(
            abi.encode(
                UnifiedPaymentVerifierV3.PaymentDetails(
                    intent.paymentMethod, PAYEE, 5000, USD, block.timestamp * 1000, paymentId
                ),
                UnifiedPaymentVerifierV3.IntentSnapshot(
                    intentHash, intent.amount, intent.paymentMethod, USD, PAYEE, CONVERSION_RATE, intent.timestamp, 0
                )
            ),
            suffix
        );
    }

    function _proof(bytes32 intentHash, bytes32 paymentId, bytes memory suffix) internal view returns (bytes memory) {
        return _signedProof(
            intentHash, _data(intentHash, paymentId, suffix), INTENT_AMOUNT, WITNESS_KEY, upv.DOMAIN_SEPARATOR()
        );
    }

    function _signedProof(bytes32 hash, bytes memory data, uint256 amount, uint256 key, bytes32 domainSeparator)
        internal
        view
        returns (bytes memory)
    {
        bytes32 dataHash = keccak256(data);
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                domainSeparator,
                keccak256(
                    abi.encode(
                        keccak256("PaymentAttestation(bytes32 intentHash,uint256 releaseAmount,bytes32 dataHash)"),
                        hash,
                        amount,
                        dataHash
                    )
                )
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        bytes[] memory signatures = new bytes[](1);
        signatures[0] = abi.encodePacked(r, s, v);
        return abi.encode(UnifiedPaymentVerifierV3.PaymentAttestation(hash, amount, dataHash, signatures, data, ""));
    }

    function _settle(bytes32 intentHash, bytes memory proof) internal {
        orchestrator.fulfillIntent(IOrchestratorV3.FulfillIntentParams(proof, intentHash, "", ""));
    }
}

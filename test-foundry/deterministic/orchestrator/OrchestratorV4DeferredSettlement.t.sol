// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {OrchestratorV4Fixture} from "../helpers/OrchestratorV4Fixture.sol";
import {OrchestratorV3} from "contracts/OrchestratorV3.sol";
import {IOrchestratorV3} from "contracts/interfaces/IOrchestratorV3.sol";
import {IOrchestratorV4} from "contracts/interfaces/IOrchestratorV4.sol";
import {IIntentLifecycleHookV2} from "contracts/interfaces/IIntentLifecycleHookV2.sol";
import {IntentLifecycleHookV1} from "contracts/hooks/IntentLifecycleHookV1.sol";
import {IWhitelistPolicy} from "contracts/interfaces/IWhitelistPolicy.sol";
import {IDisputeProtectionPolicy} from "contracts/interfaces/IDisputeProtectionPolicy.sol";
import {PaymentVerifierMock} from "contracts/mocks/PaymentVerifierMock.sol";
import {LifecycleHookV2Mock} from "../../mocks/LifecycleHookV2Mock.sol";

contract WrongLifecycleInterface {
    /// @notice Rejects only the hook interface, including an invalid ERC-165 advertisement.
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId != type(IIntentLifecycleHookV2).interfaceId;
    }
}

contract ERC165OnlyHook {
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7;
    }
}

contract ShortERC165Response {
    fallback() external {
        assembly {
            return(0, 1)
        }
    }
}

contract InvalidERC165Response {
    fallback() external {
        bytes4 marker = type(IIntentLifecycleHookV2).interfaceId;
        assembly {
            mstore(0, or(marker, 1))
            return(0, 32)
        }
    }
}

contract OrchestratorV4DeferredSettlementTest is OrchestratorV4Fixture {
    event IntentPayoutDeferred(bytes32 indexed intentHash, address indexed recipient, address indexed vault, uint256 amount);
    event IntentFulfilled(bytes32 indexed intentHash, address indexed fundsTransferredTo, uint256 amount, bool manual);
    LifecycleHookV2Mock internal hook;

    function setUp() public override {
        super.setUp();
        hook = new LifecycleHookV2Mock();
        orchestrator.setLifecycleHook(hook);
    }

    function test_PayNowPathMatchesV3() public {
        IOrchestratorV4.SignalIntentParams memory params = _defaultParams();
        params.postIntentHook = postIntentHook;
        params.data = abi.encode(taker);
        params.referralFees = _twoReferralFees();
        bytes32 hash = _signal(taker, params);
        vm.expectCall(address(postIntentHook), abi.encodeWithSelector(postIntentHook.execute.selector));
        _fulfill(hash, INTENT_AMOUNT, CONVERSION_RATE);
        assertEq(token.balanceOf(taker), INTENT_AMOUNT - 250_000);
        assertEq(hook.fundedCalls(), 0);
    }

    function test_DeferredSendsNetToVaultAndCallsBack() public {
        hook.setDeferralVault(address(hook));
        IOrchestratorV4.SignalIntentParams memory params = _defaultParams();
        params.referralFees = _twoReferralFees();
        bytes32 hash = _signal(taker, params);
        uint256 net = INTENT_AMOUNT - 250_000;
        vm.expectEmit(true, true, true, true, address(orchestrator));
        emit IntentPayoutDeferred(hash, taker, address(hook), net);
        vm.expectEmit(true, true, false, true, address(orchestrator));
        emit IntentFulfilled(hash, address(hook), net, false);
        _fulfill(hash, INTENT_AMOUNT, CONVERSION_RATE);
        assertEq(token.balanceOf(address(hook)), net);
        assertEq(hook.balanceAtFunding(), net);
        assertEq(hook.fundedCalls(), 1);
        assertEq(hook.lastFundedIntentHash(), hash);
        assertEq(token.balanceOf(taker), 0);
        assertEq(orchestrator.getIntent(hash).owner, address(0));
        assertEq(address(orchestrator.getIntentLifecycleHook(hash)), address(0));
    }

    function test_DeferredSkipsPostIntentHook() public {
        hook.setDeferralVault(address(hook));
        IOrchestratorV4.SignalIntentParams memory params = _defaultParams();
        params.postIntentHook = postIntentHook;
        params.data = abi.encode(address(0));
        bytes32 hash = _signal(taker, params);
        hook.setDeferralVault(address(0));
        vm.expectRevert("Target address cannot be zero");
        _fulfill(hash, INTENT_AMOUNT, CONVERSION_RATE);
        hook.setDeferralVault(address(hook));
        _fulfill(hash, INTENT_AMOUNT, CONVERSION_RATE);
        assertEq(token.balanceOf(address(hook)), INTENT_AMOUNT);
        assertEq(token.allowance(address(orchestrator), address(postIntentHook)), 0);
    }

    function test_FeesPaidBeforeDeferral() public {
        hook.setDeferralVault(address(hook));
        orchestrator.setProtocolFee(1e16);
        vm.mockCall(address(escrow), abi.encodeWithSignature("getManagerFee(uint256)", depositId), abi.encode(delegate, 2e16));
        IOrchestratorV4.SignalIntentParams memory params = _defaultParams();
        params.referralFees = _twoReferralFees();
        bytes32 hash = _signal(taker, params);
        hook.expectFeeBalances(protocolFeeRecipient, 500_000, referrer, 150_000, delegate, 1_000_000);
        _fulfill(hash, INTENT_AMOUNT, CONVERSION_RATE);
        assertEq(token.balanceOf(protocolFeeRecipient), 500_000);
        assertEq(token.balanceOf(referrer), 150_000);
        assertEq(token.balanceOf(other), 100_000);
        assertEq(token.balanceOf(delegate), 1_000_000);
        assertEq(token.balanceOf(address(hook)), INTENT_AMOUNT - 1_750_000);
    }

    function test_ExtensionWordZeroForwarded() public {
        verifier.setExtensionData(abi.encode(uint256(1)));
        _fulfill(_signalDefault(), INTENT_AMOUNT, CONVERSION_RATE);
        (,,,,,, bytes memory extensionData,) = hook.lastSettlementContext();
        assertEq(extensionData, abi.encode(uint256(1)));
        verifier.setExtensionData(abi.encode(uint256(0)));
        _fulfill(_signalDefault(), INTENT_AMOUNT, CONVERSION_RATE);
        (,,,,,, extensionData,) = hook.lastSettlementContext();
        assertEq(extensionData, abi.encode(uint256(0)));
    }

    function test_ManualReleasePassesEmptyExtension() public {
        verifier.setExtensionData(abi.encode(uint256(1)));
        bytes32 hash = _signalDefault();
        vm.prank(depositor);
        orchestrator.releaseFundsToPayer(hash);
        (,,,,,, bytes memory extensionData, bool manual) = hook.lastSettlementContext();
        assertEq(extensionData, "");
        assertTrue(manual);
        assertEq(token.balanceOf(taker), INTENT_AMOUNT);
    }

    function test_RevertsAgainstThreeFieldVerifier() public {
        bytes32 hash = _signalDefault();
        PaymentVerifierMock oldVerifier = new PaymentVerifierMock();
        oldVerifier.setVerificationContext(address(orchestrator), address(escrow));
        paymentVerifierRegistry.removePaymentMethod(METHOD);
        bytes32[] memory currencies = new bytes32[](1);
        currencies[0] = USD;
        paymentVerifierRegistry.addPaymentMethod(METHOD, address(oldVerifier), currencies);
        vm.expectRevert();
        _fulfill(hash, INTENT_AMOUNT, CONVERSION_RATE);
        assertEq(orchestrator.getIntent(hash).owner, taker);
        assertEq(token.balanceOf(taker), 0);
    }

    function test_HookRevertOnFundingRollsBackFulfil() public {
        hook.setDeferralVault(address(hook));
        hook.setRevertOnFunding(true);
        orchestrator.setProtocolFee(1e16);
        bytes32 hash = _signalDefault();
        uint256 escrowBalance = token.balanceOf(address(escrow));
        vm.expectRevert("risk funding failed");
        _fulfill(hash, INTENT_AMOUNT, CONVERSION_RATE);
        assertEq(orchestrator.getIntent(hash).owner, taker);
        assertEq(address(orchestrator.getIntentLifecycleHook(hash)), address(hook));
        assertEq(token.balanceOf(address(escrow)), escrowBalance);
        assertEq(token.balanceOf(protocolFeeRecipient), 0);
        assertEq(token.balanceOf(address(hook)), 0);
        assertEq(hook.settlementCalls(), 0);
        assertEq(hook.fundedCalls(), 0);
        assertEq(escrow.getDeposit(depositId).remainingDeposits, 500e6 - INTENT_AMOUNT);
    }

    function test_InterfaceId() public view {
        assertTrue(orchestrator.supportsInterface(type(IOrchestratorV4).interfaceId));
        assertTrue(orchestrator.supportsInterface(0x01ffc9a7));
        assertFalse(orchestrator.supportsInterface(0xffffffff));
        assertFalse(orchestrator.supportsInterface(type(IIntentLifecycleHookV2).interfaceId));
        assertTrue(hook.supportsInterface(type(IIntentLifecycleHookV2).interfaceId));
        assertTrue(hook.supportsInterface(0x01ffc9a7));
        assertFalse(hook.supportsInterface(0xffffffff));
    }

    function test_IntentHashesDifferFromV3() public {
        OrchestratorV3 oldOrchestrator = new OrchestratorV3(
            address(this),
            CHAIN_ID,
            address(escrowRegistry),
            address(paymentVerifierRegistry),
            address(relayerRegistry),
            0,
            protocolFeeRecipient
        );
        orchestratorRegistry.addOrchestrator(address(oldOrchestrator));
        assertEq(orchestrator.intentCounter(), oldOrchestrator.intentCounter());
        bytes32 hash = _signalDefault();
        vm.prank(taker);
        oldOrchestrator.signalIntent(abi.decode(abi.encode(_defaultParams()), (IOrchestratorV3.SignalIntentParams)));
        bytes32[] memory hashes = oldOrchestrator.getAccountIntents(taker);
        assertEq(hashes.length, 1);
        assertNotEq(hash, hashes[0]);
        assertEq(orchestrator.intentCounter(), oldOrchestrator.intentCounter());
    }

    function test_SetLifecycleHookRejectsV1Hook() public {
        IntentLifecycleHookV1 oldHook = new IntentLifecycleHookV1(
            orchestratorRegistry, IWhitelistPolicy(address(token)), IDisputeProtectionPolicy(address(token))
        );
        _rejectHook(address(oldHook));
    }

    function test_SetLifecycleHookRejectsWrongInterfaceAndCodeless() public {
        _rejectHook(address(new WrongLifecycleInterface()));
        _rejectHook(address(new ERC165OnlyHook()));
        _rejectHook(address(token));
        _rejectHook(other);
        _rejectHook(address(new ShortERC165Response()));
        _rejectHook(address(new InvalidERC165Response()));
    }

    function test_SetLifecycleHookAcceptsV2AndZero() public {
        orchestrator.setLifecycleHook(hook);
        assertEq(address(orchestrator.lifecycleHook()), address(hook));
        orchestrator.setLifecycleHook(IIntentLifecycleHookV2(address(0)));
        assertEq(address(orchestrator.lifecycleHook()), address(0));
    }

    function _rejectHook(address candidate) internal {
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV4.InvalidLifecycleHook.selector, candidate));
        orchestrator.setLifecycleHook(IIntentLifecycleHookV2(candidate));
        assertEq(address(orchestrator.lifecycleHook()), address(hook));
    }
}

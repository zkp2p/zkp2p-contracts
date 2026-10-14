// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {OrchestratorV3Fixture} from "../helpers/OrchestratorV3Fixture.sol";
import {IntentLifecycleHookV2} from "contracts/hooks/IntentLifecycleHookV2.sol";
import {IIntentLifecycleHook} from "contracts/interfaces/IIntentLifecycleHook.sol";
import {IIntentLifecycleHookV2} from "contracts/interfaces/IIntentLifecycleHookV2.sol";
import {IOrchestratorV3} from "contracts/interfaces/IOrchestratorV3.sol";
import {IOrchestratorRegistry} from "contracts/interfaces/IOrchestratorRegistry.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IEscrowV2} from "contracts/interfaces/IEscrowV2.sol";
import {IOrchestratorV4} from "contracts/interfaces/IOrchestratorV4.sol";
import {IWhitelistPolicy} from "contracts/interfaces/IWhitelistPolicy.sol";
import {IDisputeProtectionPolicyV2 as P} from "contracts/interfaces/IDisputeProtectionPolicyV2.sol";
import {DisputeProtectionPolicyV2} from "contracts/hooks/DisputeProtectionPolicyV2.sol";
import {WhitelistPolicy} from "contracts/hooks/WhitelistPolicy.sol";
import {StakeVault} from "contracts/StakeVault.sol";
import {AddressGroupRegistry} from "contracts/registries/AddressGroupRegistry.sol";
import {NullifierRegistry} from "contracts/registries/NullifierRegistry.sol";
import {NullifierRegistryV2} from "contracts/registries/NullifierRegistryV2.sol";
import {DisputeVerifier} from "contracts/unifiedVerifier/DisputeVerifier.sol";
import {AttestationVerifierMock} from "../../mocks/AttestationVerifierMock.sol";
import {OrchestratorV4Stub} from "../../mocks/OrchestratorV4Stub.sol";

contract IntentLifecycleHookV2Test is OrchestratorV3Fixture {
    bytes32 internal constant ID = keccak256("intent");
    uint256 internal constant NET = INTENT_AMOUNT - 1e6;
    StakeVault internal vault;
    DisputeProtectionPolicyV2 internal policy;
    WhitelistPolicy internal whitelist;
    AddressGroupRegistry internal groups;
    IntentLifecycleHookV2 internal hook;
    OrchestratorV4Stub internal stub;

    function setUp() public override {
        super.setUp();
        groups = new AddressGroupRegistry();
        whitelist = new WhitelistPolicy(groups, escrowRegistry, orchestratorRegistry);
        vault = new StakeVault(address(this), token, address(0), 0);
        policy = new DisputeProtectionPolicyV2(
            address(this), vault,
            new DisputeVerifier(address(this), new NullifierRegistryV2(new NullifierRegistry()), new AttestationVerifierMock()),
            new NullifierRegistry()
        );
        vault.initializeController(address(policy));
        policy.setRiskWindow(METHOD, 14 days);
        hook = new IntentLifecycleHookV2(orchestratorRegistry, whitelist, policy);
        policy.setLifecycleHookAuthorization(address(hook), true);
        stub = new OrchestratorV4Stub();
        stub.setRelayerRegistry(relayerRegistry);
        orchestratorRegistry.addOrchestrator(address(stub));
        _store(ID, "");
    }

    function _store(bytes32 id, bytes memory data) internal {
        IOrchestratorV4.Intent memory intent;
        intent.owner = taker;
        intent.to = other;
        intent.escrow = address(escrow);
        intent.depositId = depositId;
        intent.paymentMethod = METHOD;
        intent.amount = INTENT_AMOUNT;
        intent.data = data;
        stub.setIntent(id, intent);
    }

    function _context(bytes32 id, bool balanceFunded) internal view returns (IIntentLifecycleHookV2.SettlementContext memory) {
        return IIntentLifecycleHookV2.SettlementContext(id, address(token), taker, other, address(escrow), depositId, METHOD, INTENT_AMOUNT, NET, "", abi.encode(balanceFunded), false);
    }

    function _whitelistTaker() internal {
        bytes32 group = groups.createGroup("Takers");
        address[] memory members = new address[](1);
        members[0] = taker;
        groups.addMembers(group, members);
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = group;
        vm.prank(depositor);
        whitelist.configureDeposit(address(escrow), depositId, METHOD, true, ids, new address[](0));
    }

    function test_WhitelistedTakerGoesThroughCascade() public {
        _whitelistTaker();
        stub.signal(hook, ID, "");
        assertEq(uint256(policy.getDisputeProtectionIntent(ID).status), uint256(P.DisputeProtectionIntentStatus.NONE));
        assertEq(stub.settle(hook, _context(ID, false)), address(vault));
        assertEq(uint256(policy.getDisputeProtectionIntent(ID).collateralSource), uint256(P.CollateralSource.DEFERRED_PAYOUT));
    }

    function test_NonWhitelistedTakerGoesThroughCascadeWhenWhitelistDisabled() public {
        stub.signal(hook, ID, "");
        assertEq(uint256(policy.getDisputeProtectionIntent(ID).status), uint256(P.DisputeProtectionIntentStatus.NONE));
        assertEq(stub.settle(hook, _context(ID, false)), address(vault));
        P.DisputeProtectionIntent memory record = policy.getDisputeProtectionIntent(ID);
        assertEq(record.recipient, other);
        assertEq(record.taker, taker);
    }

    function test_WhitelistRejectsNonMemberEvenOnProtectedMethod() public {
        vm.prank(depositor);
        whitelist.setEnabled(address(escrow), depositId, METHOD, true);
        vm.expectRevert(abi.encodeWithSelector(IntentLifecycleHookV2.TakerNotWhitelisted.selector, address(escrow), depositId, METHOD, taker));
        stub.signal(hook, ID, "");
    }

    function test_SignalOnlyReadsPolicy() public {
        vm.record();
        stub.signal(hook, ID, "");
        (, bytes32[] memory writes) = vm.accesses(address(policy));
        assertEq(writes.length, 0);
    }

    function test_SignalRejectsTokenMismatch() public {
        IEscrowV2.Deposit memory deposit = escrow.getDeposit(depositId);
        deposit.token = IERC20(other);
        vm.mockCall(address(escrow), abi.encodeCall(IEscrowV2.getDeposit, (depositId)), abi.encode(deposit));
        vm.expectRevert(abi.encodeWithSelector(IntentLifecycleHookV2.IntentTokenMismatch.selector, address(token), other));
        stub.signal(hook, ID, "");
    }

    function test_SignalRejectsUnauthorizedHook() public {
        policy.setLifecycleHookAuthorization(address(hook), false);
        vm.expectRevert(abi.encodeWithSelector(IntentLifecycleHookV2.LifecycleHookNotAuthorized.selector, address(hook)));
        stub.signal(hook, ID, "");
    }

    function test_SignalRejectsPausedAdmissionsIncludingWhitelistMembers() public {
        policy.setAdmissionsPaused(true);
        vm.expectRevert(IntentLifecycleHookV2.AdmissionsPaused.selector);
        stub.signal(hook, ID, "");
        _whitelistTaker();
        vm.expectRevert(IntentLifecycleHookV2.AdmissionsPaused.selector);
        stub.signal(hook, ID, "");
    }

    function test_UnprotectedMethodSkipsReadOnlyProtectionChecks() public {
        policy.setRiskWindow(METHOD, 0);
        policy.setAdmissionsPaused(true);
        policy.setLifecycleHookAuthorization(address(hook), false);
        IEscrowV2.Deposit memory deposit = escrow.getDeposit(depositId);
        deposit.token = IERC20(other);
        vm.mockCall(address(escrow), abi.encodeCall(IEscrowV2.getDeposit, (depositId)), abi.encode(deposit));
        stub.signal(hook, ID, "");
        assertEq(uint256(policy.getDisputeProtectionIntent(ID).status), uint256(P.DisputeProtectionIntentStatus.NONE));
    }

    function test_UnprotectedMethodSettlesWithoutRecord() public {
        policy.setRiskWindow(METHOD, 0);
        stub.signal(hook, ID, "");
        assertEq(stub.settle(hook, _context(ID, false)), address(0));
        assertEq(uint256(policy.getDisputeProtectionIntent(ID).status), uint256(P.DisputeProtectionIntentStatus.NONE));
    }

    function test_RelayerTakerBypassesWithoutBalanceFunding() public {
        relayerRegistry.addRelayer(taker);
        stub.signal(hook, ID, "");
        assertEq(stub.settle(hook, _context(ID, false)), address(0));
        P.DisputeProtectionIntent memory record = policy.getDisputeProtectionIntent(ID);
        assertEq(uint256(record.status), uint256(P.DisputeProtectionIntentStatus.RELEASED));
        assertEq(uint256(record.collateralSource), uint256(P.CollateralSource.BYPASS));
        assertEq(record.lockedAmount, 0);
    }

    function test_RecipientRelayerDoesNotBypass() public {
        relayerRegistry.addRelayer(other);
        stub.signal(hook, ID, "");
        assertEq(stub.settle(hook, _context(ID, false)), address(vault));
    }

    function _v1Data() internal pure returns (bytes memory) {
        return abi.encode(uint8(1), keccak256("conditions"));
    }

    function _useGatedDeposit() internal {
        vm.startPrank(depositor);
        depositId = _createDeposit(gatingService, delegate);
        vm.stopPrank();
        _store(ID, "");
    }

    function _malformedData() internal pure returns (bytes[] memory data) {
        data = new bytes[](8);
        data[0] = hex"01";
        data[1] = new bytes(63);
        data[2] = bytes.concat(_v1Data(), hex"00");
        data[3] = abi.encode(uint8(0), keccak256("conditions"));
        data[4] = abi.encode(uint8(2), keccak256("conditions"));
        data[5] = abi.encode(uint8(1), bytes32(0));
        data[6] = abi.encode(uint256(257), keccak256("conditions"));
        data[7] = abi.encode(uint256(1) << 255 | 1, keccak256("conditions"));
    }

    function test_ConditionsHashOf() public {
        assertEq(hook.conditionsHashOf(""), bytes32(0));
        assertEq(hook.conditionsHashOf(_v1Data()), keccak256("conditions"));
        bytes[] memory data = _malformedData();
        for (uint256 i; i < data.length; ++i) {
            vm.expectRevert(IntentLifecycleHookV2.InvalidLifecycleHookData.selector);
            hook.conditionsHashOf(data[i]);
        }
    }

    function test_AdmissionRejectsMalformedDataWithoutPolicyRecord() public {
        _useGatedDeposit();
        bytes[] memory data = _malformedData();
        for (uint256 i; i < data.length; ++i) {
            vm.expectRevert(IntentLifecycleHookV2.InvalidLifecycleHookData.selector);
            stub.signal(hook, ID, data[i]);
            assertEq(uint256(policy.getDisputeProtectionIntent(ID).status), uint256(P.DisputeProtectionIntentStatus.NONE));
        }
    }

    function test_V1DataRequiresGatingService() public {
        vm.expectRevert(IntentLifecycleHookV2.ConditionsRequireGatingService.selector);
        stub.signal(hook, ID, _v1Data());
        assertEq(uint256(policy.getDisputeProtectionIntent(ID).status), uint256(P.DisputeProtectionIntentStatus.NONE));
        _useGatedDeposit();
        stub.signal(hook, ID, _v1Data());
        assertEq(uint256(policy.getDisputeProtectionIntent(ID).status), uint256(P.DisputeProtectionIntentStatus.NONE));
    }

    function test_WhitelistedTakerStillValidatesDataAndGatingService() public {
        _whitelistTaker();
        vm.expectRevert(IntentLifecycleHookV2.InvalidLifecycleHookData.selector);
        stub.signal(hook, ID, hex"01");
        vm.expectRevert(IntentLifecycleHookV2.ConditionsRequireGatingService.selector);
        stub.signal(hook, ID, _v1Data());
        _useGatedDeposit();
        _whitelistTaker();
        stub.signal(hook, ID, _v1Data());
        assertEq(uint256(policy.getDisputeProtectionIntent(ID).status), uint256(P.DisputeProtectionIntentStatus.NONE));
    }

    function test_HookDoesNotWriteStorage() public {
        _useGatedDeposit();
        vm.record();
        stub.signal(hook, ID, _v1Data());
        IIntentLifecycleHookV2.SettlementContext memory context = _context(ID, true);
        context.data = _v1Data();
        context.extensionData = abi.encode(uint256(1), keccak256("conditions"));
        stub.settle(hook, context);
        (, bytes32[] memory writes) = vm.accesses(address(hook));
        assertEq(writes.length, 0);
    }

    function test_SettlementRejectsMalformedHookDataEvenForManualRelease() public {
        stub.signal(hook, ID, "");
        IIntentLifecycleHookV2.SettlementContext memory context = _context(ID, false);
        context.data = hex"01";
        vm.expectRevert(IntentLifecycleHookV2.InvalidLifecycleHookData.selector);
        stub.settle(hook, context);
        context.isManualRelease = true;
        vm.expectRevert(IntentLifecycleHookV2.InvalidLifecycleHookData.selector);
        stub.settle(hook, context);
    }

    function test_OrchestratorV3SignalRevertsBeforeCreatingIntentOrEscrowLock() public {
        orchestrator.setLifecycleHook(IIntentLifecycleHook(address(hook)));
        uint256 counterBefore = orchestrator.intentCounter();
        bytes32 intentHash = _intentHash(counterBefore);
        uint256 availableBefore = escrow.getDeposit(depositId).remainingDeposits;
        IOrchestratorV3.SignalIntentParams memory params = _defaultParams();

        vm.expectCall(address(hook), abi.encodeCall(IIntentLifecycleHook.onIntentSignaled, (intentHash)));
        vm.expectRevert(bytes(""));
        _signalCall(taker, params);

        assertEq(orchestrator.intentCounter(), counterBefore);
        assertEq(orchestrator.getIntent(intentHash).owner, address(0));
        assertEq(orchestrator.getAccountIntents(taker).length, 0);
        assertEq(address(orchestrator.getIntentLifecycleHook(intentHash)), address(0));
        assertEq(escrow.getDeposit(depositId).remainingDeposits, availableBefore);
        assertEq(escrow.getDeposit(depositId).outstandingIntentAmount, 0);
        assertEq(escrow.getDepositIntentHashes(depositId).length, 0);
        assertEq(escrow.getDepositIntent(depositId, intentHash).amount, 0);
        assertEq(uint256(policy.getDisputeProtectionIntent(intentHash).status), uint256(P.DisputeProtectionIntentStatus.NONE));
    }

    function test_RegisteredNonERC165CallerCanUseV2Callbacks() public {
        stub.signal(hook, ID, "");
        assertEq(uint256(policy.getDisputeProtectionIntent(ID).status), uint256(P.DisputeProtectionIntentStatus.NONE));

        address deferralVault = stub.settle(hook, _context(ID, false));
        assertEq(deferralVault, address(vault));
        token.transfer(deferralVault, NET);
        stub.fund(hook, ID);
        assertEq(vault.lockedStake(other), NET);
        assertEq(uint256(policy.getDisputeProtectionIntent(ID).status), uint256(P.DisputeProtectionIntentStatus.SETTLED));

        bytes32 cancelledId = keccak256("cancelled");
        _store(cancelledId, "");
        stub.signal(hook, cancelledId, "");
        stub.cancel(hook, cancelledId);
        assertEq(uint256(policy.getDisputeProtectionIntent(cancelledId).status), uint256(P.DisputeProtectionIntentStatus.NONE));
    }

    function test_UnregisteredCallerRejected() public {
        bytes memory reason = abi.encodeWithSelector(IntentLifecycleHookV2.UnauthorizedOrchestrator.selector, address(this));
        vm.expectRevert(reason);
        hook.onIntentSignaled(ID, "");
        IIntentLifecycleHookV2.SettlementContext memory context = _context(ID, false);
        vm.expectRevert(reason);
        hook.settleIntent(context);
        vm.expectRevert(reason);
        hook.onDeferredPayoutFunded(ID);
    }

    function test_SettleReturnsVaultOnlyWhenDeferred() public {
        stub.signal(hook, ID, "");
        assertEq(stub.settle(hook, _context(ID, true)), address(0));
        token.transfer(taker, INTENT_AMOUNT);
        vm.startPrank(taker);
        token.approve(address(vault), INTENT_AMOUNT);
        vault.depositStake(INTENT_AMOUNT);
        vm.stopPrank();
        bytes32 stakeId = keccak256("stake");
        _store(stakeId, "");
        stub.signal(hook, stakeId, "");
        assertEq(stub.settle(hook, _context(stakeId, false)), address(0));
        assertEq(vault.lockedStake(taker), INTENT_AMOUNT);
        bytes32 deferredId = keccak256("deferred");
        _store(deferredId, "");
        stub.signal(hook, deferredId, "");
        assertEq(stub.settle(hook, _context(deferredId, false)), address(vault));
        assertEq(policy.getDisputeProtectionIntent(deferredId).lockedAmount, NET);
    }

    function test_InvalidBalanceFundedFlagReverts() public {
        stub.signal(hook, ID, "");
        IIntentLifecycleHookV2.SettlementContext memory context = _context(ID, false);
        context.extensionData = abi.encode(uint256(2));
        vm.expectRevert(abi.encodeWithSelector(IntentLifecycleHookV2.InvalidBalanceFundedFlag.selector, 2));
        stub.settle(hook, context);
        assertEq(uint256(policy.getDisputeProtectionIntent(ID).status), uint256(P.DisputeProtectionIntentStatus.NONE));
    }

    function test_MissingCompleteWordsMeanZero() public {
        bytes[5] memory extensions = [bytes(""), bytes(hex"ff"), new bytes(31), abi.encode(uint256(0)), bytes.concat(abi.encode(uint256(0)), new bytes(31))];
        for (uint256 i; i < extensions.length; ++i) {
            bytes32 id = keccak256(abi.encode("missing", i));
            _store(id, "");
            stub.signal(hook, id, "");
            IIntentLifecycleHookV2.SettlementContext memory context = _context(id, false);
            context.extensionData = extensions[i];
            assertEq(stub.settle(hook, context), address(vault));
        }
    }

    function test_ConditionsMatchAndReservedWordsAreIgnored() public {
        stub.signal(hook, ID, "");
        IIntentLifecycleHookV2.SettlementContext memory context = _context(ID, true);
        context.data = abi.encode(uint8(1), keccak256("conditions"));
        context.extensionData = abi.encode(uint256(1), keccak256("conditions"), type(uint256).max, uint256(2));
        assertEq(stub.settle(hook, context), address(0));
        assertEq(uint256(policy.getDisputeProtectionIntent(ID).collateralSource), uint256(P.CollateralSource.BYPASS));
    }

    function test_ConditionsMismatchIncludingMissingWordsReverts() public {
        stub.signal(hook, ID, "");
        IIntentLifecycleHookV2.SettlementContext memory context = _context(ID, false);
        context.data = abi.encode(uint8(1), keccak256("conditions"));
        bytes[5] memory extensions = [bytes(""), new bytes(31), abi.encode(uint256(1)), bytes.concat(abi.encode(uint256(1)), new bytes(31)), abi.encode(uint256(0), keccak256("wrong"))];
        for (uint256 i; i < extensions.length; ++i) {
            context.extensionData = extensions[i];
            vm.expectRevert(abi.encodeWithSelector(IntentLifecycleHookV2.ConditionsNotAttested.selector, ID));
            stub.settle(hook, context);
        }
        assertEq(uint256(policy.getDisputeProtectionIntent(ID).status), uint256(P.DisputeProtectionIntentStatus.NONE));
    }

    function test_UnconditionedIntentRejectsNonzeroAttestedConditions() public {
        stub.signal(hook, ID, "");
        IIntentLifecycleHookV2.SettlementContext memory context = _context(ID, false);
        context.extensionData = abi.encode(uint256(0), keccak256("unexpected conditions"));
        vm.expectRevert(abi.encodeWithSelector(IntentLifecycleHookV2.ConditionsNotAttested.selector, ID));
        stub.settle(hook, context);
    }

    function test_ManualReleaseIgnoresInvalidExtensionAndConditions() public {
        stub.signal(hook, ID, "");
        IIntentLifecycleHookV2.SettlementContext memory context = _context(ID, false);
        context.isManualRelease = true;
        context.data = abi.encode(uint8(1), keccak256("conditions"));
        context.extensionData = abi.encode(uint256(2), keccak256("wrong"));
        relayerRegistry.addRelayer(taker);
        vm.expectCall(address(policy), abi.encodeCall(P.onIntentSettled, (P.SettleParams(ID, taker, other, address(escrow), depositId, METHOD, INTENT_AMOUNT, NET, false, true))));
        assertEq(stub.settle(hook, context), address(0));
    }

    function test_FundForwardsToPolicy() public {
        stub.signal(hook, ID, "");
        assertEq(stub.settle(hook, _context(ID, false)), address(vault));
        token.transfer(address(vault), NET);
        stub.fund(hook, ID);
        assertEq(vault.lockedStake(other), NET);
        assertEq(uint256(policy.getDisputeProtectionIntent(ID).status), uint256(P.DisputeProtectionIntentStatus.SETTLED));
    }

    function test_CancelIsUnrestrictedNoopForUnknownAndSettledIntents() public {
        hook.onIntentCancelled(keccak256("unknown"));
        stub.signal(hook, ID, "");
        stub.cancel(hook, ID);
        assertEq(uint256(policy.getDisputeProtectionIntent(ID).status), uint256(P.DisputeProtectionIntentStatus.NONE));
        stub.settle(hook, _context(ID, true));
        vm.record();
        vm.prank(other);
        hook.onIntentCancelled(ID);
        (, bytes32[] memory hookWrites) = vm.accesses(address(hook));
        (, bytes32[] memory policyWrites) = vm.accesses(address(policy));
        assertEq(hookWrites.length, 0);
        assertEq(policyWrites.length, 0);
        assertEq(uint256(policy.getDisputeProtectionIntent(ID).status), uint256(P.DisputeProtectionIntentStatus.RELEASED));
    }

    function test_ConstructorRejectsZeroOrCodelessDependencies() public {
        for (uint256 i; i < 3; ++i) {
            for (uint256 j; j < 2; ++j) {
                address bad = j == 0 ? address(0) : other;
                if (j == 0) vm.expectRevert(IntentLifecycleHookV2.ZeroAddress.selector);
                else vm.expectRevert(abi.encodeWithSelector(IntentLifecycleHookV2.InvalidDependency.selector, bad));
                new IntentLifecycleHookV2(
                    i == 0 ? IOrchestratorRegistry(bad) : orchestratorRegistry,
                    i == 1 ? IWhitelistPolicy(bad) : whitelist,
                    i == 2 ? P(bad) : policy
                );
            }
        }
    }

    function test_SupportsInterface() public {
        bytes4 expected = IIntentLifecycleHookV2.onIntentSignaled.selector
            ^ IIntentLifecycleHookV2.onIntentCancelled.selector ^ IIntentLifecycleHookV2.settleIntent.selector
            ^ IIntentLifecycleHookV2.onDeferredPayoutFunded.selector;
        assertTrue(hook.supportsInterface(expected));
        assertTrue(hook.supportsInterface(0x01ffc9a7));
        assertFalse(hook.supportsInterface(0xffffffff));
        assertFalse(hook.supportsInterface(type(IOrchestratorV4).interfaceId));
        assertEq(expected, type(IIntentLifecycleHookV2).interfaceId);
        assertEq(address(hook.orchestratorRegistry()), address(orchestratorRegistry));
        assertEq(address(hook.whitelistPolicy()), address(whitelist));
        assertEq(address(hook.disputeProtectionPolicy()), address(policy));
    }

    function test_IntentNotFound() public {
        bytes32 missing = keccak256("missing");
        vm.expectRevert(abi.encodeWithSelector(IntentLifecycleHookV2.IntentNotFound.selector, missing));
        stub.signal(hook, missing, "");
    }
}

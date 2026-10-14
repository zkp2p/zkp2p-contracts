// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {OrchestratorV3Fixture} from "../helpers/OrchestratorV3Fixture.sol";
import {IntentLifecycleHookV2} from "contracts/hooks/IntentLifecycleHookV2.sol";
import {IIntentLifecycleHookV2} from "contracts/interfaces/IIntentLifecycleHookV2.sol";
import {IIntentLifecycleHook} from "contracts/interfaces/IIntentLifecycleHook.sol";
import {IOrchestratorRegistry} from "contracts/interfaces/IOrchestratorRegistry.sol";
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
        return IIntentLifecycleHookV2.SettlementContext(id, address(token), other, INTENT_AMOUNT, NET, bytes32(0), abi.encode(balanceFunded), false);
    }

    function _optOut() internal {
        vm.prank(depositor);
        policy.setDisputeProtectionEnabled(address(escrow), depositId, METHOD, false);
    }

    function test_WhitelistedTakerSkipsPolicy() public {
        bytes32 group = groups.createGroup("Takers");
        address[] memory members = new address[](1);
        members[0] = taker;
        groups.addMembers(group, members);
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = group;
        vm.prank(depositor);
        whitelist.configureDeposit(address(escrow), depositId, METHOD, true, ids, new address[](0));
        stub.signal(hook, ID);
        assertEq(uint256(policy.getDisputeProtectionIntent(ID).status), uint256(P.DisputeProtectionIntentStatus.NONE));
    }

    function test_ProtectedTakerOpensPolicyRecordWithRecipient() public {
        stub.signal(hook, ID);
        P.DisputeProtectionIntent memory record = policy.getDisputeProtectionIntent(ID);
        assertEq(record.recipient, other);
        assertEq(record.taker, taker);
        assertEq(uint256(record.status), uint256(P.DisputeProtectionIntentStatus.PENDING));
    }

    function test_OptedOutWithWhitelistRejectsNonMember() public {
        _optOut();
        vm.prank(depositor);
        whitelist.setEnabled(address(escrow), depositId, METHOD, true);
        vm.expectRevert(abi.encodeWithSelector(IntentLifecycleHookV2.TakerNotWhitelisted.selector, address(escrow), depositId, METHOD, taker));
        stub.signal(hook, ID);
    }

    function test_OptedOutWithoutWhitelistIsOpen() public {
        _optOut();
        stub.signal(hook, ID);
        assertEq(uint256(policy.getDisputeProtectionIntent(ID).status), uint256(P.DisputeProtectionIntentStatus.NONE));
    }

    function test_IgnoresIntentData() public {
        _store(ID, hex"ff0102030405");
        stub.signal(hook, ID);
        assertEq(policy.getDisputeProtectionIntent(ID).recipient, other);
        assertEq(uint256(policy.getDisputeProtectionIntent(ID).status), uint256(P.DisputeProtectionIntentStatus.PENDING));
    }

    function test_RejectsOrchestratorWithoutV2Settlement() public {
        orchestrator.setLifecycleHook(IIntentLifecycleHook(address(hook)));
        uint256 beforeCounter = orchestrator.intentCounter();
        vm.expectRevert(abi.encodeWithSelector(IntentLifecycleHookV2.UnsupportedOrchestrator.selector, address(orchestrator)));
        _signalCall(taker, _defaultParams());
        assertEq(orchestrator.intentCounter(), beforeCounter);
    }

    function test_RejectsRegisteredNonERC165Caller() public {
        orchestratorRegistry.addOrchestrator(address(token));
        vm.prank(address(token));
        vm.expectRevert(abi.encodeWithSelector(IntentLifecycleHookV2.UnsupportedOrchestrator.selector, address(token)));
        hook.onIntentSignaled(ID);
    }

    function test_UnregisteredCallerRejected() public {
        bytes memory reason = abi.encodeWithSelector(IntentLifecycleHookV2.UnauthorizedOrchestrator.selector, address(this));
        vm.expectRevert(reason);
        hook.onIntentSignaled(ID);
        vm.expectRevert(reason);
        hook.onIntentCancelled(ID);
        IIntentLifecycleHookV2.SettlementContext memory context = _context(ID, false);
        vm.expectRevert(reason);
        hook.settleIntent(context);
        vm.expectRevert(reason);
        hook.onDeferredPayoutFunded(ID);
    }

    function test_SettleReturnsVaultOnlyWhenDeferred() public {
        stub.signal(hook, ID);
        assertEq(stub.settle(hook, _context(ID, true)), address(0));
        token.transfer(taker, INTENT_AMOUNT);
        vm.startPrank(taker);
        token.approve(address(vault), INTENT_AMOUNT);
        vault.depositStake(INTENT_AMOUNT);
        vm.stopPrank();
        bytes32 stakeId = keccak256("stake");
        _store(stakeId, "");
        stub.signal(hook, stakeId);
        assertEq(stub.settle(hook, _context(stakeId, false)), address(0));
        assertEq(vault.lockedStake(taker), INTENT_AMOUNT);
        bytes32 deferredId = keccak256("deferred");
        _store(deferredId, "");
        stub.signal(hook, deferredId);
        assertEq(stub.settle(hook, _context(deferredId, false)), address(vault));
        assertEq(policy.getDisputeProtectionIntent(deferredId).lockedAmount, NET);
    }

    function test_InvalidBalanceFundedFlagReverts() public {
        stub.signal(hook, ID);
        IIntentLifecycleHookV2.SettlementContext memory context = _context(ID, false);
        context.extensionData = abi.encode(uint256(2));
        vm.expectRevert(abi.encodeWithSelector(IntentLifecycleHookV2.InvalidBalanceFundedFlag.selector, 2));
        stub.settle(hook, context);
        assertEq(uint256(policy.getDisputeProtectionIntent(ID).status), uint256(P.DisputeProtectionIntentStatus.PENDING));
    }

    function test_MissingCompleteWordsMeanZero() public {
        bytes[5] memory extensions = [bytes(""), bytes(hex"ff"), new bytes(31), abi.encode(uint256(0)), bytes.concat(abi.encode(uint256(0)), new bytes(31))];
        for (uint256 i; i < extensions.length; ++i) {
            bytes32 id = keccak256(abi.encode("missing", i));
            _store(id, "");
            stub.signal(hook, id);
            IIntentLifecycleHookV2.SettlementContext memory context = _context(id, false);
            context.extensionData = extensions[i];
            assertEq(stub.settle(hook, context), address(vault));
        }
    }

    function test_ConditionsMatchAndReservedWordsAreIgnored() public {
        stub.signal(hook, ID);
        IIntentLifecycleHookV2.SettlementContext memory context = _context(ID, true);
        context.conditionsHash = keccak256("conditions");
        context.extensionData = abi.encode(uint256(1), context.conditionsHash, type(uint256).max, uint256(2));
        assertEq(stub.settle(hook, context), address(0));
        assertEq(uint256(policy.getDisputeProtectionIntent(ID).collateralSource), uint256(P.CollateralSource.BYPASS));
    }

    function test_ConditionsMismatchIncludingMissingWordsReverts() public {
        stub.signal(hook, ID);
        IIntentLifecycleHookV2.SettlementContext memory context = _context(ID, false);
        context.conditionsHash = keccak256("conditions");
        bytes[5] memory extensions = [bytes(""), new bytes(31), abi.encode(uint256(1)), bytes.concat(abi.encode(uint256(1)), new bytes(31)), abi.encode(uint256(0), keccak256("wrong"))];
        for (uint256 i; i < extensions.length; ++i) {
            context.extensionData = extensions[i];
            vm.expectRevert(abi.encodeWithSelector(IntentLifecycleHookV2.ConditionsNotAttested.selector, ID));
            stub.settle(hook, context);
        }
        assertEq(uint256(policy.getDisputeProtectionIntent(ID).status), uint256(P.DisputeProtectionIntentStatus.PENDING));
    }

    function test_UnconditionedIntentRejectsNonzeroAttestedConditions() public {
        stub.signal(hook, ID);
        IIntentLifecycleHookV2.SettlementContext memory context = _context(ID, false);
        context.extensionData = abi.encode(uint256(0), keccak256("unexpected conditions"));
        vm.expectRevert(abi.encodeWithSelector(IntentLifecycleHookV2.ConditionsNotAttested.selector, ID));
        stub.settle(hook, context);
    }

    function test_ManualReleaseIgnoresInvalidExtensionAndConditions() public {
        stub.signal(hook, ID);
        IIntentLifecycleHookV2.SettlementContext memory context = _context(ID, false);
        context.isManualRelease = true;
        context.conditionsHash = keccak256("conditions");
        context.extensionData = abi.encode(uint256(2), keccak256("wrong"));
        vm.expectCall(address(policy), abi.encodeCall(P.onIntentSettled, (ID, INTENT_AMOUNT, NET, false, true)));
        assertEq(stub.settle(hook, context), address(0));
    }

    function test_FundForwardsToPolicy() public {
        stub.signal(hook, ID);
        assertEq(stub.settle(hook, _context(ID, false)), address(vault));
        token.transfer(address(vault), NET);
        stub.fund(hook, ID);
        assertEq(vault.lockedStake(other), NET);
        assertEq(uint256(policy.getDisputeProtectionIntent(ID).status), uint256(P.DisputeProtectionIntentStatus.SETTLED));
    }

    function test_CancelForwardsToPolicy() public {
        stub.signal(hook, ID);
        stub.cancel(hook, ID);
        assertEq(uint256(policy.getDisputeProtectionIntent(ID).status), uint256(P.DisputeProtectionIntentStatus.CANCELLED));
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
        stub.signal(hook, missing);
    }

    function test_RejectsInvalidERC165Responses() public {
        bytes memory callData = abi.encodeWithSignature("supportsInterface(bytes4)", type(IOrchestratorV4).interfaceId);
        for (uint256 i; i < 4; ++i) {
            if (i == 0) vm.mockCallRevert(address(stub), callData, "");
            else vm.mockCall(address(stub), callData, i == 1 ? bytes("") : i == 2 ? bytes(hex"12345678") : abi.encode(bytes4(0)));
            vm.expectRevert(abi.encodeWithSelector(IntentLifecycleHookV2.UnsupportedOrchestrator.selector, address(stub)));
            stub.signal(hook, ID);
            vm.clearMockedCalls();
        }
    }
}

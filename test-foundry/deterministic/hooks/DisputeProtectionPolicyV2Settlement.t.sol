// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {AddressGroupRegistry} from "contracts/registries/AddressGroupRegistry.sol";
import {OrchestratorV4Fixture} from "../helpers/OrchestratorV4Fixture.sol";
import {IIntentSettlementPolicy} from "contracts/interfaces/IIntentSettlementPolicy.sol";
import {IOrchestratorV4} from "contracts/interfaces/IOrchestratorV4.sol";
import {IDisputeProtectionPolicyV2 as P} from "contracts/interfaces/IDisputeProtectionPolicyV2.sol";
import {DisputeProtectionPolicyV2} from "contracts/hooks/DisputeProtectionPolicyV2.sol";
import {StakeVaultV2} from "contracts/StakeVaultV2.sol";
import {NullifierRegistry} from "contracts/registries/NullifierRegistry.sol";
import {NullifierRegistryV2} from "contracts/registries/NullifierRegistryV2.sol";
import {DisputeVerifier} from "contracts/unifiedVerifier/DisputeVerifier.sol";
import {AttestationVerifierMock} from "../../mocks/AttestationVerifierMock.sol";

contract DisputeProtectionPolicyV2SettlementTest is OrchestratorV4Fixture {
    bytes32 internal constant ID = keccak256("intent");
    uint256 internal constant NET = INTENT_AMOUNT - 1e6;
    StakeVaultV2 internal vault;
    DisputeProtectionPolicyV2 internal policy;
    AddressGroupRegistry internal groups;

    function setUp() public override {
        super.setUp();
        groups = AddressGroupRegistry(address(whitelist.groupRegistry()));
        vault = new StakeVaultV2(address(this), token, address(0));
        policy = new DisputeProtectionPolicyV2(
            address(this), vault,
            new DisputeVerifier(address(this), new NullifierRegistryV2(new NullifierRegistry()), new AttestationVerifierMock()),
            new NullifierRegistry(), whitelist
        );
        vault.setController(address(policy), true);
        policy.setOrchestratorAuthorization(address(this), true);
    }

    function _context(bytes32 id, uint256 window) internal view returns (IIntentSettlementPolicy.SettlementContext memory) {
        return IIntentSettlementPolicy.SettlementContext(id, address(token), taker, other, depositor, address(escrow), depositId, METHOD, INTENT_AMOUNT, NET, "", abi.encode(window), false);
    }

    function _whitelistTaker() internal returns (bytes32 group) {
        group = groups.createGroup("Takers");
        address[] memory members = new address[](1);
        members[0] = taker;
        groups.addMembers(group, members);
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = group;
        vm.prank(depositor);
        whitelist.configureDeposit(address(escrow), depositId, METHOD, true, ids, new address[](0));
    }

    event DisputeProtectionIntentSettled(bytes32 indexed intentHash, address indexed taker, address indexed depositor, address recipient, bytes32 paymentMethod, uint64 riskWindow, P.CollateralSource collateralSource, address stakeOwner, uint256 releaseAmount, uint256 lockedAmount, uint64 releaseEligibleAt);

    function _expectDeferredSettlement() internal {
        vm.expectEmit(true, true, true, true, address(policy));
        emit DisputeProtectionIntentSettled(
            ID, taker, depositor, other, METHOD, 14 days, P.CollateralSource.DEFERRED_PAYOUT,
            other, INTENT_AMOUNT, NET, uint64(block.timestamp + 14 days)
        );
    }

    function _assertDeferred() internal {
        _expectDeferredSettlement();
        assertEq(policy.settleIntent(_context(ID, 14 days)), address(vault));
        assertEq(uint256(policy.getDisputeProtectionIntent(ID).collateralSource), uint256(P.CollateralSource.DEFERRED_PAYOUT));
    }

    function test_WhitelistedTakerBypassesWithInsufficientStake() public {
        _whitelistTaker();
        token.transfer(taker, INTENT_AMOUNT - 1);
        vm.startPrank(taker);
        token.approve(address(vault), INTENT_AMOUNT - 1);
        vault.depositStake(INTENT_AMOUNT - 1);
        vm.stopPrank();

        assertEq(uint256(policy.getDisputeProtectionIntent(ID).status), uint256(P.DisputeProtectionIntentStatus.NONE));

        vm.recordLogs();
        vm.record();
        assertEq(policy.settleIntent(_context(ID, 14 days)), address(0));
        (, bytes32[] memory writes) = vm.accesses(address(policy));

        assertEq(writes.length, 0);
        assertEq(vm.getRecordedLogs().length, 0);
        vm.clearMockedCalls();
        P.DisputeProtectionIntent memory record = policy.getDisputeProtectionIntent(ID);
        assertEq(uint256(record.collateralSource), uint256(P.CollateralSource.NONE));
        assertEq(uint256(record.status), uint256(P.DisputeProtectionIntentStatus.NONE));
        assertEq(record.lockedAmount, 0);
        assertEq(vault.lockedStake(taker), 0);
        assertEq(vault.lockedStake(other), 0);
        assertEq(vault.freeStake(taker), INTENT_AMOUNT - 1);
    }

    function test_AllowedTakerWithWhitelistDisabledAtSettlementIsProtected() public {
        _whitelistTaker();

        vm.prank(depositor);
        whitelist.setEnabled(address(escrow), depositId, METHOD, false);
        assertTrue(whitelist.isTakerAllowed(address(escrow), depositId, METHOD, taker));
        _assertDeferred();
    }

    function test_TakerRemovedAfterSignalIsProtected() public {
        bytes32 group = _whitelistTaker();

        address[] memory members = new address[](1);
        members[0] = taker;
        groups.removeMembers(group, members);
        _assertDeferred();
    }

    function test_WhitelistedRecipientDoesNotBypass() public {
        bytes32 group = _whitelistTaker();

        address[] memory members = new address[](1);
        members[0] = taker;
        groups.removeMembers(group, members);
        members[0] = other;
        groups.addMembers(group, members);
        assertTrue(whitelist.isTakerAllowed(address(escrow), depositId, METHOD, other));
        assertFalse(whitelist.isTakerAllowed(address(escrow), depositId, METHOD, taker));
        _assertDeferred();
    }

    function test_WhitelistedTakerManualReleaseCreatesNoRecord() public {
        _whitelistTaker();
        IIntentSettlementPolicy.SettlementContext memory context = _context(ID, 14 days);
        context.isManualRelease = true;
        context.extensionData = "";

        assertEq(policy.settleIntent(context), address(0));
        vm.clearMockedCalls();
        assertEq(uint256(policy.getDisputeProtectionIntent(ID).status), uint256(P.DisputeProtectionIntentStatus.NONE));
        assertEq(vault.lockedStake(taker), 0);
    }

    function test_NonWhitelistedTakerGoesThroughCascadeWhenWhitelistDisabled() public {

        assertEq(uint256(policy.getDisputeProtectionIntent(ID).status), uint256(P.DisputeProtectionIntentStatus.NONE));
        assertEq(policy.settleIntent(_context(ID, 14 days)), address(vault));
        P.DisputeProtectionIntent memory record = policy.getDisputeProtectionIntent(ID);
        assertEq(record.recipient, other);
        assertEq(record.taker, taker);
    }

    function test_ZeroWindowPaysNowWithoutWhitelistCall() public {

        vm.mockCallRevert(address(whitelist), bytes(""), bytes("whitelist called"));

        vm.recordLogs();
        assertEq(policy.settleIntent(_context(ID, 0)), address(0));
        assertEq(vm.getRecordedLogs().length, 0);
        vm.clearMockedCalls();
        assertEq(uint256(policy.getDisputeProtectionIntent(ID).status), uint256(P.DisputeProtectionIntentStatus.NONE));
    }

    function test_NonStakeTokenWithWindowPaysNowWithoutRecordOrEvent() public {
        IIntentSettlementPolicy.SettlementContext memory context = _context(ID, 14 days);
        context.token = other;
        vm.recordLogs();
        assertEq(policy.settleIntent(context), address(0));
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(uint256(policy.getDisputeProtectionIntent(ID).status), uint256(P.DisputeProtectionIntentStatus.NONE));
    }

    function test_RelayerTakerWithWhitelistDisabledUsesStakeOwnerCollateral() public {
        relayerRegistry.addRelayer(taker);
        assertFalse(whitelist.enabled(address(escrow), depositId, METHOD));
        token.transfer(delegate, INTENT_AMOUNT);
        vm.startPrank(delegate);
        token.approve(address(vault), INTENT_AMOUNT);
        vault.depositStake(INTENT_AMOUNT);
        vault.setTakerAuthorization(taker, true);
        vm.stopPrank();
        vm.prank(taker);
        vault.selectStakeOwner(delegate);

        assertEq(uint256(policy.getDisputeProtectionIntent(ID).status), uint256(P.DisputeProtectionIntentStatus.NONE));
        assertEq(policy.settleIntent(_context(ID, 14 days)), address(0));
        P.DisputeProtectionIntent memory record = policy.getDisputeProtectionIntent(ID);
        assertEq(uint256(record.status), uint256(P.DisputeProtectionIntentStatus.SETTLED));
        assertEq(uint256(record.collateralSource), uint256(P.CollateralSource.STAKE));
        assertEq(record.stakeOwner, delegate);
        assertEq(record.lockedAmount, INTENT_AMOUNT);
        assertEq(record.releaseEligibleAt, block.timestamp + 14 days);
        assertEq(vault.lockedStake(delegate), INTENT_AMOUNT);
        assertEq(vault.lockedStake(taker), 0);
    }

    function test_RelayerTakerWithWhitelistDisabledDefersUncoveredPayout() public {
        relayerRegistry.addRelayer(taker);
        assertFalse(whitelist.enabled(address(escrow), depositId, METHOD));

        assertEq(uint256(policy.getDisputeProtectionIntent(ID).status), uint256(P.DisputeProtectionIntentStatus.NONE));
        _assertDeferred();
        P.DisputeProtectionIntent memory record = policy.getDisputeProtectionIntent(ID);
        assertEq(uint256(record.status), uint256(P.DisputeProtectionIntentStatus.SETTLED));
        assertEq(record.stakeOwner, other);
        assertEq(record.lockedAmount, NET);
    }

    function test_RelayerTakerAllowedByEnabledWhitelistBypasses() public {
        relayerRegistry.addRelayer(taker);
        _whitelistTaker();

        vm.recordLogs();
        vm.record();
        assertEq(policy.settleIntent(_context(ID, 14 days)), address(0));
        (, bytes32[] memory writes) = vm.accesses(address(policy));

        assertEq(writes.length, 0);
        assertEq(vm.getRecordedLogs().length, 0);
        vm.clearMockedCalls();
        P.DisputeProtectionIntent memory record = policy.getDisputeProtectionIntent(ID);
        assertEq(uint256(record.status), uint256(P.DisputeProtectionIntentStatus.NONE));
        assertEq(uint256(record.collateralSource), uint256(P.CollateralSource.NONE));
        assertEq(record.lockedAmount, 0);
    }

    function _conditionsData() internal pure returns (bytes memory) {
        return abi.encodePacked(keccak256("conditions"));
    }

    function _useGatedDeposit() internal {
        vm.startPrank(depositor);
        depositId = _createDeposit(gatingService, delegate);
        vm.stopPrank();

    }

    function test_ZeroHashDataIsUnconditioned() public {
        bytes memory data = abi.encodePacked(bytes32(0));

        IIntentSettlementPolicy.SettlementContext memory context = _context(ID, 14 days);
        context.data = data;
        context.extensionData = abi.encode(uint256(14 days));
        _expectDeferredSettlement();
        assertEq(policy.settleIntent(context), address(vault));
    }

    function test_PolicyDataUsesFirstWordWithRightPadding() public {
        _useGatedDeposit();
        bytes[2] memory data = [bytes(hex"01"), bytes.concat(_conditionsData(), hex"ff")];
        for (uint256 i; i < data.length; ++i) {
            bytes32 id = keccak256(abi.encode("raw data", i));


            IIntentSettlementPolicy.SettlementContext memory context = _context(id, 0);
            context.data = data[i];
            bytes32 expected = i == 0 ? bytes32(uint256(1) << 248) : keccak256("conditions");
            context.extensionData = abi.encode(uint256(0), expected);
            assertEq(policy.settleIntent(context), address(0));
        }
    }

    function test_ZeroWindowDoesNotWriteStorage() public {
        _useGatedDeposit();
        vm.record();

        IIntentSettlementPolicy.SettlementContext memory context = _context(ID, 0);
        context.data = _conditionsData();
        context.extensionData = abi.encode(uint256(0), keccak256("conditions"));
        policy.settleIntent(context);
        (, bytes32[] memory writes) = vm.accesses(address(policy));
        assertEq(writes.length, 0);
    }

    function test_UnauthorizedOrchestratorRejectedEvenForManualRelease() public {
        IIntentSettlementPolicy.SettlementContext memory context = _context(ID, 0);
        context.isManualRelease = true;
        vm.startPrank(other);
        vm.expectRevert(abi.encodeWithSelector(P.UnauthorizedOrchestrator.selector, other));
        policy.settleIntent(context);
        vm.expectRevert(abi.encodeWithSelector(P.UnauthorizedOrchestrator.selector, other));
        policy.onDeferredPayoutFunded(ID);
        vm.stopPrank();
    }

    function test_SettleReturnsVaultOnlyWhenDeferred() public {

        assertEq(policy.settleIntent(_context(ID, 0)), address(0));
        token.transfer(taker, INTENT_AMOUNT);
        vm.startPrank(taker);
        token.approve(address(vault), INTENT_AMOUNT);
        vault.depositStake(INTENT_AMOUNT);
        vm.stopPrank();
        bytes32 stakeId = keccak256("stake");


        assertEq(policy.settleIntent(_context(stakeId, 14 days)), address(0));
        assertEq(vault.lockedStake(taker), INTENT_AMOUNT);
        bytes32 deferredId = keccak256("deferred");


        assertEq(policy.settleIntent(_context(deferredId, 14 days)), address(vault));
        assertEq(policy.getDisputeProtectionIntent(deferredId).lockedAmount, NET);
    }

    function test_AttestedWindowRequiredBeforeWhitelistRead() public {
        _whitelistTaker();
        vm.mockCallRevert(address(whitelist), bytes(""), bytes("whitelist called"));
        bytes[3] memory extensions = [bytes(""), bytes(hex"ff"), new bytes(31)];
        for (uint256 i; i < extensions.length; ++i) {
            IIntentSettlementPolicy.SettlementContext memory context = _context(ID, 14 days);
            context.extensionData = extensions[i];
            vm.expectRevert(bytes4(keccak256("MissingDisputeWindow()")));
            policy.settleIntent(context);
        }
    }

    function test_WindowAboveMaximumRevertsBeforeConditionsAndWhitelistRead() public {
        _whitelistTaker();
        vm.mockCallRevert(address(whitelist), bytes(""), bytes("whitelist called"));
        uint256[3] memory windows = [uint256(180 days + 1), uint256(type(uint64).max) + 1, type(uint256).max];
        for (uint256 i; i < windows.length; ++i) {
            IIntentSettlementPolicy.SettlementContext memory context = _context(ID, windows[i]);
            context.data = _conditionsData();
            vm.expectRevert(abi.encodeWithSelector(P.InvalidDisputeWindow.selector, windows[i]));
            policy.settleIntent(context);
        }
        assertEq(uint256(policy.getDisputeProtectionIntent(ID).status), uint256(P.DisputeProtectionIntentStatus.NONE));
    }

    function test_AttestedWindowsSetDeferredMaturity() public {
        uint256[3] memory windows = [uint256(1), uint256(7 days), uint256(180 days)];
        assertEq(policy.MAX_RISK_WINDOW(), windows[2]);
        for (uint256 i; i < windows.length; ++i) {
            bytes32 id = bytes32(i + 1);
            assertEq(policy.settleIntent(_context(id, windows[i])), address(vault));
            P.DisputeProtectionIntent memory record = policy.getDisputeProtectionIntent(id);
            assertEq(record.releaseEligibleAt, block.timestamp + windows[i]);
        }
    }

    function test_MissingConditionsWordMeansZero() public {
        bytes[2] memory extensions = [abi.encode(uint256(0)), bytes.concat(abi.encode(uint256(0)), new bytes(31))];
        for (uint256 i; i < extensions.length; ++i) {
            IIntentSettlementPolicy.SettlementContext memory context = _context(ID, 0);
            context.extensionData = extensions[i];
            assertEq(policy.settleIntent(context), address(0));
        }
    }

    function test_ConditionsMatchAndReservedWordsAreIgnored() public {

        IIntentSettlementPolicy.SettlementContext memory context = _context(ID, 0);
        context.data = abi.encodePacked(keccak256("conditions"));
        context.extensionData = abi.encode(uint256(0), keccak256("conditions"), type(uint256).max, uint256(2));
        assertEq(policy.settleIntent(context), address(0));
        assertEq(uint256(policy.getDisputeProtectionIntent(ID).collateralSource), uint256(P.CollateralSource.NONE));
    }

    function test_ConditionsMismatchIncludingMissingWordsReverts() public {

        IIntentSettlementPolicy.SettlementContext memory context = _context(ID, 14 days);
        context.data = abi.encodePacked(keccak256("conditions"));
        bytes[3] memory extensions = [abi.encode(uint256(0)), bytes.concat(abi.encode(uint256(0)), new bytes(31)), abi.encode(uint256(0), keccak256("wrong"))];
        for (uint256 i; i < extensions.length; ++i) {
            context.extensionData = extensions[i];
            vm.expectRevert(abi.encodeWithSelector(P.ConditionsNotAttested.selector, ID));
            policy.settleIntent(context);
        }
        assertEq(uint256(policy.getDisputeProtectionIntent(ID).status), uint256(P.DisputeProtectionIntentStatus.NONE));
    }

    function test_UnconditionedIntentRejectsNonzeroAttestedConditions() public {

        IIntentSettlementPolicy.SettlementContext memory context = _context(ID, 14 days);
        context.extensionData = abi.encode(uint256(0), keccak256("unexpected conditions"));
        vm.expectRevert(abi.encodeWithSelector(P.ConditionsNotAttested.selector, ID));
        policy.settleIntent(context);
    }

    function test_WhitelistedTakerStillValidatesConditionsBeforeWhitelistRead() public {
        _whitelistTaker();
        vm.mockCallRevert(address(whitelist), bytes(""), bytes("whitelist called"));
        IIntentSettlementPolicy.SettlementContext memory context = _context(ID, 14 days);
        context.data = _conditionsData();
        bytes[3] memory extensions = [abi.encode(uint256(14 days)), bytes.concat(abi.encode(uint256(14 days)), new bytes(31)), abi.encode(uint256(14 days), keccak256("wrong"))];
        for (uint256 i; i < extensions.length; ++i) {
            context.extensionData = extensions[i];
            vm.expectRevert(abi.encodeWithSelector(P.ConditionsNotAttested.selector, ID));
            policy.settleIntent(context);
        }
        context.data = "";
        context.extensionData = abi.encode(uint256(14 days), keccak256("unexpected"));
        vm.expectRevert(abi.encodeWithSelector(P.ConditionsNotAttested.selector, ID));
        policy.settleIntent(context);
    }

    function test_WhitelistedTakerWithMatchingConditionsCreatesNoRecord() public {
        _useGatedDeposit();
        _whitelistTaker();

        IIntentSettlementPolicy.SettlementContext memory context = _context(ID, 180 days);
        context.data = _conditionsData();
        context.extensionData = abi.encode(uint256(180 days), keccak256("conditions"));

        vm.recordLogs();
        assertEq(policy.settleIntent(context), address(0));
        assertEq(vm.getRecordedLogs().length, 0);
        vm.clearMockedCalls();
        assertEq(uint256(policy.getDisputeProtectionIntent(ID).status), uint256(P.DisputeProtectionIntentStatus.NONE));
    }

    function test_ManualReleaseIgnoresInvalidExtensionAndConditions() public {

        IIntentSettlementPolicy.SettlementContext memory context = _context(ID, 14 days);
        context.isManualRelease = true;
        context.data = abi.encodePacked(keccak256("conditions"));
        context.extensionData = abi.encode(type(uint256).max, keccak256("wrong"));
        vm.mockCallRevert(address(whitelist), bytes(""), bytes("whitelist called"));
        relayerRegistry.addRelayer(taker);

        assertEq(policy.settleIntent(context), address(0));
    }

    function test_FundingCreatesVaultLock() public {

        assertEq(policy.settleIntent(_context(ID, 14 days)), address(vault));
        token.transfer(address(vault), NET);
        policy.onDeferredPayoutFunded(ID);
        assertEq(vault.lockedStake(other), NET);
        assertEq(uint256(policy.getDisputeProtectionIntent(ID).status), uint256(P.DisputeProtectionIntentStatus.SETTLED));
    }

    function test_SupportsOnlyMinimalSettlementAndERC165Interfaces() public view {
        bytes4 expected = IIntentSettlementPolicy.settleIntent.selector ^ IIntentSettlementPolicy.onDeferredPayoutFunded.selector;
        assertEq(expected, type(IIntentSettlementPolicy).interfaceId);
        assertTrue(policy.supportsInterface(expected));
        assertTrue(policy.supportsInterface(0x01ffc9a7));
        assertFalse(policy.supportsInterface(0xffffffff));
        assertFalse(policy.supportsInterface(type(IOrchestratorV4).interfaceId));
        assertEq(address(policy.whitelistPolicy()), address(whitelist));
    }

}

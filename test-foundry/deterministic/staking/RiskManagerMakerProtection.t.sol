// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IIntentRiskHook} from "../../../contracts/interfaces/IIntentRiskHook.sol";
import {IRiskManager} from "../../../contracts/interfaces/IRiskManager.sol";
import {RiskManagerFixture} from "../helpers/RiskManagerFixture.sol";

contract RiskManagerMakerProtectionTest is RiskManagerFixture {
    event MakerWhitelistProtectionUpdated(address indexed maker, bool enabled);
    event MakerChargebackProtectionUpdated(address indexed maker, bytes32 indexed paymentMethod, bool enabled);
    event MakerProtectionModeUpdated(address indexed maker, bool requireBothProtections);
    event TakerWhitelisted(address indexed maker, address indexed taker);
    event TakerRemovedFromWhitelist(address indexed maker, address indexed taker);
    event GroupAttached(address indexed maker, uint256 indexed groupId);
    event GroupDetached(address indexed maker, uint256 indexed groupId);
    event MakerConfigsInitialized(uint256 makerCount);

    uint256 internal constant PROTECTED_DEPOSIT_ID = 2;
    uint256 internal constant SECOND_PROTECTED_DEPOSIT_ID = 3;
    bytes32 internal constant NON_CHARGEBACK_METHOD = keccak256("non-chargeback-method");

    address internal protectedMaker = makeAddr("protectedMaker");
    address internal unstakedTaker = makeAddr("unstakedTaker");
    address internal groupOwner = makeAddr("groupOwner");
    address internal groupMember = makeAddr("groupMember");

    function setUp() public override {
        super.setUp();
        escrow.configureDepositAt(PROTECTED_DEPOSIT_ID, protectedMaker, token);
    }

    /* ============ Admission matrix and terminal paths ============ */

    function test_DefaultsAdmitUnbondedThroughCancellationAndSettlement() public {
        assertEq(
            uint256(manager.getEffectiveAdmission(protectedMaker, PAYMENT_METHOD, taker)),
            uint256(IRiskManager.AdmissionOutcome.ADMIT_UNBONDED)
        );
        _assertBothTerminalPaths(taker, IRiskManager.RiskMode.UNBONDED);
    }

    function test_WhitelistOnlyRejectsNonWhitelistedTakerAndAdmitsWhitelistedUnbonded() public {
        _setWhitelistProtection(true);

        _expectProtectedAdmissionRevert(
            unstakedTaker,
            PAYMENT_METHOD,
            abi.encodeWithSelector(IRiskManager.TakerNotWhitelisted.selector, unstakedTaker, protectedMaker)
        );

        _addToWhitelist(taker);
        _assertBothTerminalPaths(taker, IRiskManager.RiskMode.UNBONDED);
    }

    function test_ChargebackOnlyAdmitsStakeBackedThroughCancellationAndSettlement() public {
        _setChargebackProtection(PAYMENT_METHOD, true);
        _assertBothTerminalPaths(taker, IRiskManager.RiskMode.STAKE_BACKED);
    }

    function test_ChargebackOnlyAdmitsDeferredPayoutThroughCancellationAndSettlement() public {
        _setChargebackProtection(PAYMENT_METHOD, true);
        _assertBothTerminalPaths(unstakedTaker, IRiskManager.RiskMode.DEFERRED_PAYOUT);
    }

    function test_AndModeRejectsNonWhitelistedAndAdmitsWhitelistedStakeBacked() public {
        _setWhitelistProtection(true);
        _setChargebackProtection(PAYMENT_METHOD, true);
        _setProtectionMode(true);

        _expectProtectedAdmissionRevert(
            unstakedTaker,
            PAYMENT_METHOD,
            abi.encodeWithSelector(IRiskManager.TakerNotWhitelisted.selector, unstakedTaker, protectedMaker)
        );

        _addToWhitelist(taker);
        _assertBothTerminalPaths(taker, IRiskManager.RiskMode.STAKE_BACKED);
    }

    function test_OrModeAdmitsWhitelistedUnbondedWithoutVaultLock() public {
        _setWhitelistProtection(true);
        _setChargebackProtection(PAYMENT_METHOD, true);
        _addToWhitelist(taker);

        uint256 lockedStakeBefore = vault.lockedStake(safe);
        _assertBothTerminalPaths(taker, IRiskManager.RiskMode.UNBONDED);
        assertEq(vault.lockedStake(safe), lockedStakeBefore);
    }

    function test_OrModeAdmitsNonWhitelistedThroughStakingPath() public {
        _setWhitelistProtection(true);
        _setChargebackProtection(PAYMENT_METHOD, true);
        _assertBothTerminalPaths(taker, IRiskManager.RiskMode.STAKE_BACKED);
    }

    function test_NonChargebackableRailDoesNotLetOrModeWeakenWhitelist() public {
        _setPlatformConfig(NON_CHARGEBACK_METHOD, true, false, false, 0);
        _setWhitelistProtection(true);
        _setChargebackProtection(NON_CHARGEBACK_METHOD, true);

        assertEq(
            uint256(manager.getEffectiveAdmission(protectedMaker, NON_CHARGEBACK_METHOD, unstakedTaker)),
            uint256(IRiskManager.AdmissionOutcome.REJECT_NOT_WHITELISTED)
        );
        _expectProtectedAdmissionRevert(
            unstakedTaker,
            NON_CHARGEBACK_METHOD,
            abi.encodeWithSelector(IRiskManager.TakerNotWhitelisted.selector, unstakedTaker, protectedMaker)
        );
    }

    /* ============ Staking-only gates ============ */

    function test_RiskPauseOnlyGatesChargebackStakingPath() public {
        vm.prank(owner);
        manager.setRiskTakingPaused(true);

        bytes32 defaultsIntent = _admitProtected(taker, PAYMENT_METHOD);
        _assertPendingMode(defaultsIntent, IRiskManager.RiskMode.UNBONDED);

        _setWhitelistProtection(true);
        _addToWhitelist(taker);
        bytes32 whitelistIntent = _admitProtected(taker, PAYMENT_METHOD);
        _assertPendingMode(whitelistIntent, IRiskManager.RiskMode.UNBONDED);

        _setChargebackProtection(PAYMENT_METHOD, true);
        _setProtectionMode(true);
        _expectProtectedAdmissionRevert(
            taker, PAYMENT_METHOD, abi.encodeWithSelector(IRiskManager.RiskTakingPaused.selector)
        );
    }

    function test_PlatformDisabledOnlyGatesChargebackStakingPath() public {
        _setPlatformConfig(PAYMENT_METHOD, false, true, true, RISK_WINDOW);

        bytes32 defaultsIntent = _admitProtected(taker, PAYMENT_METHOD);
        _assertPendingMode(defaultsIntent, IRiskManager.RiskMode.UNBONDED);

        _setChargebackProtection(PAYMENT_METHOD, true);
        _expectProtectedAdmissionRevert(
            taker, PAYMENT_METHOD, abi.encodeWithSelector(IRiskManager.PlatformDisabled.selector, PAYMENT_METHOD)
        );
    }

    function test_TokenMismatchOnlyGatesChargebackStakingPath() public {
        escrow.configureDepositAt(PROTECTED_DEPOSIT_ID, protectedMaker, otherToken);

        bytes32 defaultsIntent = _admitProtected(taker, PAYMENT_METHOD);
        _assertPendingMode(defaultsIntent, IRiskManager.RiskMode.UNBONDED);

        _setChargebackProtection(PAYMENT_METHOD, true);
        _expectProtectedAdmissionRevert(
            taker,
            PAYMENT_METHOD,
            abi.encodeWithSelector(IRiskManager.IntentTokenMismatch.selector, address(token), address(otherToken))
        );
    }

    /* ============ Maker-level sharing and groups ============ */

    function test_MakerWhitelistIsSharedAcrossTwoDeposits() public {
        escrow.configureDepositAt(SECOND_PROTECTED_DEPOSIT_ID, protectedMaker, token);
        _setWhitelistProtection(true);
        _addToWhitelist(taker);

        bytes32 firstIntent = _admitForDeposit(PROTECTED_DEPOSIT_ID, taker, PAYMENT_METHOD);
        bytes32 secondIntent = _admitForDeposit(SECOND_PROTECTED_DEPOSIT_ID, taker, PAYMENT_METHOD);
        _assertPendingMode(firstIntent, IRiskManager.RiskMode.UNBONDED);
        _assertPendingMode(secondIntent, IRiskManager.RiskMode.UNBONDED);

        _expectAdmissionRevertForDeposit(
            PROTECTED_DEPOSIT_ID,
            unstakedTaker,
            PAYMENT_METHOD,
            abi.encodeWithSelector(IRiskManager.TakerNotWhitelisted.selector, unstakedTaker, protectedMaker)
        );
        _expectAdmissionRevertForDeposit(
            SECOND_PROTECTED_DEPOSIT_ID,
            unstakedTaker,
            PAYMENT_METHOD,
            abi.encodeWithSelector(IRiskManager.TakerNotWhitelisted.selector, unstakedTaker, protectedMaker)
        );
    }

    function test_AttachedGroupMemberAdmitsAndDetachRejects() public {
        uint256 groupId = _createGroupWithMember(groupMember);
        _setWhitelistProtection(true);
        _attachGroup(groupId);

        bytes32 intentHash = _admitProtected(groupMember, PAYMENT_METHOD);
        _assertPendingMode(intentHash, IRiskManager.RiskMode.UNBONDED);

        _detachGroup(groupId);
        _expectProtectedAdmissionRevert(
            groupMember,
            PAYMENT_METHOD,
            abi.encodeWithSelector(IRiskManager.TakerNotWhitelisted.selector, groupMember, protectedMaker)
        );
    }

    function test_AttachUnknownGroupReverts() public {
        uint256 unknownGroupId = 99;
        uint256[] memory groupIds = _groupIds(unknownGroupId);
        vm.expectRevert(abi.encodeWithSelector(IRiskManager.GroupDoesNotExist.selector, unknownGroupId));
        vm.prank(protectedMaker);
        manager.attachGroups(groupIds);
    }

    function test_AttachingEleventhGroupRevertsAtMaximum() public {
        uint256[] memory firstTen = new uint256[](10);
        for (uint256 index = 0; index < 11; index++) {
            vm.prank(groupOwner);
            uint256 groupId = groupRegistry.createGroup("group");
            if (index < 10) firstTen[index] = groupId;
        }

        vm.prank(protectedMaker);
        manager.attachGroups(firstTen);

        uint256[] memory eleventh = _groupIds(11);
        vm.expectRevert(abi.encodeWithSelector(IRiskManager.MaxGroupsExceeded.selector, 11, 10));
        vm.prank(protectedMaker);
        manager.attachGroups(eleventh);
    }

    function test_DuplicateAttachAndAbsentDetachAreSilentNoOps() public {
        uint256 groupId = _createGroupWithMember(groupMember);
        _attachGroup(groupId);

        vm.recordLogs();
        _attachGroup(groupId);
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(manager.getAttachedGroups(protectedMaker).length, 1);

        vm.prank(groupOwner);
        uint256 unattachedGroupId = groupRegistry.createGroup("unattached");
        vm.recordLogs();
        _detachGroup(unattachedGroupId);
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(manager.getAttachedGroups(protectedMaker).length, 1);
    }

    /* ============ Setters, events, idempotence, and defaults ============ */

    function test_ProtectionSettersEmitOnMutationAndNotOnNoOp() public {
        vm.expectEmit(true, false, false, true, address(manager));
        emit MakerWhitelistProtectionUpdated(protectedMaker, true);
        _setWhitelistProtection(true);
        _assertNoLogsForWhitelistProtection(true);

        vm.expectEmit(true, true, false, true, address(manager));
        emit MakerChargebackProtectionUpdated(protectedMaker, PAYMENT_METHOD, true);
        _setChargebackProtection(PAYMENT_METHOD, true);
        _assertNoLogsForChargebackProtection(PAYMENT_METHOD, true);

        vm.expectEmit(true, false, false, true, address(manager));
        emit MakerProtectionModeUpdated(protectedMaker, true);
        _setProtectionMode(true);
        _assertNoLogsForProtectionMode(true);
    }

    function test_WhitelistMutationsEmitPerNewAddressAndSkipExistingAddresses() public {
        address secondTaker = makeAddr("secondTaker");
        address[] memory takers = new address[](3);
        takers[0] = taker;
        takers[1] = taker;
        takers[2] = secondTaker;

        vm.expectEmit(true, true, false, true, address(manager));
        emit TakerWhitelisted(protectedMaker, taker);
        vm.expectEmit(true, true, false, true, address(manager));
        emit TakerWhitelisted(protectedMaker, secondTaker);
        vm.prank(protectedMaker);
        manager.addToWhitelist(takers);

        vm.recordLogs();
        vm.prank(protectedMaker);
        manager.addToWhitelist(takers);
        assertEq(vm.getRecordedLogs().length, 0);

        vm.expectEmit(true, true, false, true, address(manager));
        emit TakerRemovedFromWhitelist(protectedMaker, taker);
        vm.expectEmit(true, true, false, true, address(manager));
        emit TakerRemovedFromWhitelist(protectedMaker, secondTaker);
        vm.prank(protectedMaker);
        manager.removeFromWhitelist(takers);

        vm.recordLogs();
        vm.prank(protectedMaker);
        manager.removeFromWhitelist(takers);
        assertEq(vm.getRecordedLogs().length, 0);
    }

    function test_WhitelistMutationsRejectEmptyArrayAndZeroAddress() public {
        address[] memory empty = new address[](0);
        vm.expectRevert(IRiskManager.EmptyArray.selector);
        vm.prank(protectedMaker);
        manager.addToWhitelist(empty);
        vm.expectRevert(IRiskManager.EmptyArray.selector);
        vm.prank(protectedMaker);
        manager.removeFromWhitelist(empty);

        address[] memory zeroAddress = new address[](1);
        zeroAddress[0] = address(0);
        vm.expectRevert(IRiskManager.ZeroAddress.selector);
        vm.prank(protectedMaker);
        manager.addToWhitelist(zeroAddress);
        vm.expectRevert(IRiskManager.ZeroAddress.selector);
        vm.prank(protectedMaker);
        manager.removeFromWhitelist(zeroAddress);
    }

    function test_GroupMutationsRejectEmptyArray() public {
        uint256[] memory empty = new uint256[](0);
        vm.expectRevert(IRiskManager.EmptyArray.selector);
        vm.prank(protectedMaker);
        manager.attachGroups(empty);
        vm.expectRevert(IRiskManager.EmptyArray.selector);
        vm.prank(protectedMaker);
        manager.detachGroups(empty);
    }

    function test_GroupMutationsEmitPerRealChange() public {
        uint256 firstGroup = _createGroupWithMember(taker);
        vm.prank(groupOwner);
        uint256 secondGroup = groupRegistry.createGroup("second");
        uint256[] memory groupIds = new uint256[](2);
        groupIds[0] = firstGroup;
        groupIds[1] = secondGroup;

        vm.expectEmit(true, true, false, true, address(manager));
        emit GroupAttached(protectedMaker, firstGroup);
        vm.expectEmit(true, true, false, true, address(manager));
        emit GroupAttached(protectedMaker, secondGroup);
        vm.prank(protectedMaker);
        manager.attachGroups(groupIds);

        vm.expectEmit(true, true, false, true, address(manager));
        emit GroupDetached(protectedMaker, firstGroup);
        vm.expectEmit(true, true, false, true, address(manager));
        emit GroupDetached(protectedMaker, secondGroup);
        vm.prank(protectedMaker);
        manager.detachGroups(groupIds);
    }

    function test_FreshMakerHasEmptyProtectionDefaults() public view {
        IRiskManager.MakerProtectionConfig memory config = manager.getMakerProtectionConfig(protectedMaker);
        assertFalse(config.whitelistEnabled);
        assertFalse(config.requireBothProtections);
        assertFalse(manager.chargebackProtectionEnabled(protectedMaker, PAYMENT_METHOD));
        assertFalse(manager.whitelist(protectedMaker, taker));
        assertEq(manager.getAttachedGroups(protectedMaker).length, 0);
    }

    /* ============ One-time initialization ============ */

    function test_InitializeMakerConfigsSeedsMakersAndEmitsMutationEvents() public {
        address firstMaker = makeAddr("firstMaker");
        address secondMaker = makeAddr("secondMaker");
        bytes32 secondPaymentMethod = keccak256("second-payment-method");
        IRiskManager.MakerInit[] memory makers = new IRiskManager.MakerInit[](2);
        bytes32[] memory firstPlatforms = new bytes32[](2);
        firstPlatforms[0] = PAYMENT_METHOD;
        firstPlatforms[1] = secondPaymentMethod;
        makers[0] = IRiskManager.MakerInit({
            maker: firstMaker, whitelistEnabled: true, requireBothProtections: true, chargebackPlatforms: firstPlatforms
        });
        makers[1] = IRiskManager.MakerInit({
            maker: secondMaker,
            whitelistEnabled: false,
            requireBothProtections: false,
            chargebackPlatforms: new bytes32[](0)
        });

        vm.expectEmit(true, false, false, true, address(manager));
        emit MakerWhitelistProtectionUpdated(firstMaker, true);
        vm.expectEmit(true, false, false, true, address(manager));
        emit MakerProtectionModeUpdated(firstMaker, true);
        vm.expectEmit(true, true, false, true, address(manager));
        emit MakerChargebackProtectionUpdated(firstMaker, PAYMENT_METHOD, true);
        vm.expectEmit(true, true, false, true, address(manager));
        emit MakerChargebackProtectionUpdated(firstMaker, secondPaymentMethod, true);
        vm.expectEmit(false, false, false, true, address(manager));
        emit MakerConfigsInitialized(2);
        vm.prank(owner);
        manager.initializeMakerConfigs(makers);

        IRiskManager.MakerProtectionConfig memory firstConfig = manager.getMakerProtectionConfig(firstMaker);
        IRiskManager.MakerProtectionConfig memory secondConfig = manager.getMakerProtectionConfig(secondMaker);
        assertTrue(firstConfig.whitelistEnabled);
        assertTrue(firstConfig.requireBothProtections);
        assertFalse(secondConfig.whitelistEnabled);
        assertFalse(secondConfig.requireBothProtections);
        assertTrue(manager.chargebackProtectionEnabled(firstMaker, PAYMENT_METHOD));
        assertTrue(manager.chargebackProtectionEnabled(firstMaker, secondPaymentMethod));
        assertTrue(manager.makerConfigsInitialized());
    }

    function test_InitializeMakerConfigsCanOnlyRunOnceEvenWhenSecondCallIsEmpty() public {
        IRiskManager.MakerInit[] memory empty = new IRiskManager.MakerInit[](0);
        vm.prank(owner);
        manager.initializeMakerConfigs(empty);

        vm.expectRevert(IRiskManager.MakerConfigsAlreadyInitialized.selector);
        vm.prank(owner);
        manager.initializeMakerConfigs(empty);
    }

    function test_InitializeMakerConfigsRejectsNonOwner() public {
        IRiskManager.MakerInit[] memory empty = new IRiskManager.MakerInit[](0);
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        vm.prank(protectedMaker);
        manager.initializeMakerConfigs(empty);
    }

    /* ============ Effective-admission view parity ============ */

    function test_GetEffectiveAdmissionMatchesEveryMatrixCell() public {
        assertEq(
            uint256(manager.getEffectiveAdmission(protectedMaker, PAYMENT_METHOD, taker)),
            uint256(IRiskManager.AdmissionOutcome.ADMIT_UNBONDED)
        );

        _setWhitelistProtection(true);
        assertEq(
            uint256(manager.getEffectiveAdmission(protectedMaker, PAYMENT_METHOD, taker)),
            uint256(IRiskManager.AdmissionOutcome.REJECT_NOT_WHITELISTED)
        );
        _addToWhitelist(taker);
        assertEq(
            uint256(manager.getEffectiveAdmission(protectedMaker, PAYMENT_METHOD, taker)),
            uint256(IRiskManager.AdmissionOutcome.ADMIT_UNBONDED)
        );

        _setWhitelistProtection(false);
        _setChargebackProtection(PAYMENT_METHOD, true);
        assertEq(
            uint256(manager.getEffectiveAdmission(protectedMaker, PAYMENT_METHOD, taker)),
            uint256(IRiskManager.AdmissionOutcome.STAKING_PATH)
        );

        _setWhitelistProtection(true);
        _setProtectionMode(true);
        assertEq(
            uint256(manager.getEffectiveAdmission(protectedMaker, PAYMENT_METHOD, unstakedTaker)),
            uint256(IRiskManager.AdmissionOutcome.REJECT_NOT_WHITELISTED)
        );
        assertEq(
            uint256(manager.getEffectiveAdmission(protectedMaker, PAYMENT_METHOD, taker)),
            uint256(IRiskManager.AdmissionOutcome.STAKING_PATH)
        );

        _setProtectionMode(false);
        assertEq(
            uint256(manager.getEffectiveAdmission(protectedMaker, PAYMENT_METHOD, taker)),
            uint256(IRiskManager.AdmissionOutcome.ADMIT_UNBONDED)
        );
        assertEq(
            uint256(manager.getEffectiveAdmission(protectedMaker, PAYMENT_METHOD, unstakedTaker)),
            uint256(IRiskManager.AdmissionOutcome.STAKING_PATH)
        );
    }

    /* ============ Helpers ============ */

    function _assertBothTerminalPaths(address intentTaker, IRiskManager.RiskMode expectedMode) internal {
        bytes32 cancelledIntent = _admitProtected(intentTaker, PAYMENT_METHOD);
        _assertPendingMode(cancelledIntent, expectedMode);
        orchestrator.cancel(manager, cancelledIntent);
        assertEq(
            uint256(manager.getRiskPosition(cancelledIntent).status), uint256(IRiskManager.PositionStatus.CANCELLED)
        );

        bytes32 settledIntent = _admitProtected(intentTaker, PAYMENT_METHOD);
        _assertPendingMode(settledIntent, expectedMode);
        IIntentRiskHook.RiskSettlementContext memory context =
            _settlementContext(settledIntent, 900e6, 10e6, 5e6, false);
        orchestrator.settle(manager, context);
        IRiskManager.PositionStatus expectedStatus = expectedMode == IRiskManager.RiskMode.UNBONDED
            ? IRiskManager.PositionStatus.RELEASED
            : IRiskManager.PositionStatus.SETTLED;
        assertEq(uint256(manager.getRiskPosition(settledIntent).status), uint256(expectedStatus));
    }

    function _assertPendingMode(bytes32 intentHash, IRiskManager.RiskMode expectedMode) internal view {
        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        assertEq(uint256(position.mode), uint256(expectedMode));
        assertTrue(position.mode != IRiskManager.RiskMode.NONE);
        assertEq(uint256(position.status), uint256(IRiskManager.PositionStatus.PENDING));
    }

    function _admitProtected(address intentTaker, bytes32 paymentMethod) internal returns (bytes32 intentHash) {
        return _admitForDeposit(PROTECTED_DEPOSIT_ID, intentTaker, paymentMethod);
    }

    function _admitForDeposit(uint256 depositId, address intentTaker, bytes32 paymentMethod)
        internal
        returns (bytes32 intentHash)
    {
        (intentHash,) = _newIntentForDeposit(depositId, intentTaker, payoutRecipient, INTENT_AMOUNT);
        if (paymentMethod != PAYMENT_METHOD) {
            orchestrator.setIntentForDeposit(
                intentHash,
                intentTaker,
                payoutRecipient,
                address(escrow),
                depositId,
                INTENT_AMOUNT,
                paymentMethod,
                uint64(block.timestamp)
            );
        }
        orchestrator.admit(manager, intentHash);
    }

    function _expectProtectedAdmissionRevert(address intentTaker, bytes32 paymentMethod, bytes memory revertData)
        internal
    {
        _expectAdmissionRevertForDeposit(PROTECTED_DEPOSIT_ID, intentTaker, paymentMethod, revertData);
    }

    function _expectAdmissionRevertForDeposit(
        uint256 depositId,
        address intentTaker,
        bytes32 paymentMethod,
        bytes memory revertData
    ) internal {
        (bytes32 intentHash,) = _newIntentForDeposit(depositId, intentTaker, payoutRecipient, INTENT_AMOUNT);
        if (paymentMethod != PAYMENT_METHOD) {
            orchestrator.setIntentForDeposit(
                intentHash,
                intentTaker,
                payoutRecipient,
                address(escrow),
                depositId,
                INTENT_AMOUNT,
                paymentMethod,
                uint64(block.timestamp)
            );
        }
        vm.expectRevert(revertData);
        orchestrator.admit(manager, intentHash);
    }

    function _setWhitelistProtection(bool enabled) internal {
        vm.prank(protectedMaker);
        manager.setWhitelistProtection(enabled);
    }

    function _setChargebackProtection(bytes32 paymentMethod, bool enabled) internal {
        vm.prank(protectedMaker);
        manager.setChargebackProtection(paymentMethod, enabled);
    }

    function _setProtectionMode(bool requireBoth) internal {
        vm.prank(protectedMaker);
        manager.setProtectionMode(requireBoth);
    }

    function _addToWhitelist(address account) internal {
        address[] memory accounts = new address[](1);
        accounts[0] = account;
        vm.prank(protectedMaker);
        manager.addToWhitelist(accounts);
    }

    function _setPlatformConfig(
        bytes32 paymentMethod,
        bool enabled,
        bool chargebackable,
        bool deferredPayoutEnabled,
        uint64 riskWindow
    ) internal {
        IRiskManager.PlatformRiskConfig memory config = IRiskManager.PlatformRiskConfig({
            enabled: enabled,
            chargeback: IRiskManager.ChargebackConfig({
                chargebackable: chargebackable, deferredPayoutEnabled: deferredPayoutEnabled, riskWindow: riskWindow
            })
        });
        vm.prank(owner);
        manager.setPlatformRiskConfig(paymentMethod, config);
    }

    function _createGroupWithMember(address member) internal returns (uint256 groupId) {
        vm.prank(groupOwner);
        groupId = groupRegistry.createGroup("protected");
        address[] memory members = new address[](1);
        members[0] = member;
        vm.prank(groupOwner);
        groupRegistry.addMembers(groupId, members);
    }

    function _attachGroup(uint256 groupId) internal {
        vm.prank(protectedMaker);
        manager.attachGroups(_groupIds(groupId));
    }

    function _detachGroup(uint256 groupId) internal {
        vm.prank(protectedMaker);
        manager.detachGroups(_groupIds(groupId));
    }

    function _groupIds(uint256 groupId) internal pure returns (uint256[] memory groupIds) {
        groupIds = new uint256[](1);
        groupIds[0] = groupId;
    }

    function _assertNoLogsForWhitelistProtection(bool enabled) internal {
        vm.recordLogs();
        _setWhitelistProtection(enabled);
        assertEq(vm.getRecordedLogs().length, 0);
    }

    function _assertNoLogsForChargebackProtection(bytes32 paymentMethod, bool enabled) internal {
        vm.recordLogs();
        _setChargebackProtection(paymentMethod, enabled);
        assertEq(vm.getRecordedLogs().length, 0);
    }

    function _assertNoLogsForProtectionMode(bool requireBoth) internal {
        vm.recordLogs();
        _setProtectionMode(requireBoth);
        assertEq(vm.getRecordedLogs().length, 0);
    }
}

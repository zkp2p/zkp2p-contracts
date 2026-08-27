// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";

import {EscrowDepositorMock} from "contracts/mocks/EscrowDepositorMock.sol";
import {WhitelistPolicy} from "contracts/hooks/WhitelistPolicy.sol";
import {IPreIntentHook} from "contracts/interfaces/IPreIntentHook.sol";
import {IReferralFee} from "contracts/interfaces/IReferralFee.sol";
import {AddressGroupRegistry} from "contracts/registries/AddressGroupRegistry.sol";
import {EscrowRegistry} from "contracts/registries/EscrowRegistry.sol";
import {OrchestratorRegistry} from "contracts/registries/OrchestratorRegistry.sol";

contract WhitelistPolicyTest is Test {
    uint256 internal constant DEPOSIT_ONE = 1;
    uint256 internal constant DEPOSIT_TWO = 2;
    uint256 internal constant UNKNOWN_DEPOSIT = 99;
    bytes32 internal constant PAYMENT_METHOD = keccak256("venmo");
    bytes32 internal constant OTHER_PAYMENT_METHOD = keccak256("zelle");

    bytes32 internal PEERS;
    bytes32 internal PEER_PLUSES;
    bytes32 internal PEER_MERCHANTS;

    address internal maker;
    address internal otherMaker;
    address internal taker;
    address internal otherTaker;

    AddressGroupRegistry internal registry;
    EscrowRegistry internal escrowRegistry;
    OrchestratorRegistry internal orchestratorRegistry;
    EscrowDepositorMock internal escrow;
    EscrowDepositorMock internal otherEscrow;
    EscrowDepositorMock internal unregisteredEscrow;
    WhitelistPolicy internal policy;

    event EnabledUpdated(
        address indexed escrow, uint256 indexed depositId, bytes32 indexed paymentMethod, bool enabled
    );
    event AddressWhitelisted(address indexed escrow, uint256 indexed depositId, address indexed taker);
    event AddressRemovedFromWhitelist(address indexed escrow, uint256 indexed depositId, address indexed taker);
    event AllowedGroupAdded(
        address indexed escrow, uint256 indexed depositId, bytes32 indexed paymentMethod, bytes32 groupId
    );
    event AllowedGroupRemoved(
        address indexed escrow, uint256 indexed depositId, bytes32 indexed paymentMethod, bytes32 groupId
    );
    event EscrowRegistryUpdated(address indexed escrowRegistry);

    function setUp() public {
        maker = makeAddr("maker");
        otherMaker = makeAddr("otherMaker");
        taker = makeAddr("taker");
        otherTaker = makeAddr("otherTaker");

        registry = new AddressGroupRegistry();
        PEERS = registry.createGroup("Peers");
        PEER_PLUSES = registry.createGroup("Peer Pluses");
        PEER_MERCHANTS = registry.createGroup("Peer Merchants");

        escrowRegistry = new EscrowRegistry();
        orchestratorRegistry = new OrchestratorRegistry();
        escrow = new EscrowDepositorMock();
        otherEscrow = new EscrowDepositorMock();
        unregisteredEscrow = new EscrowDepositorMock();
        escrowRegistry.addEscrow(address(escrow));
        escrowRegistry.addEscrow(address(otherEscrow));

        escrow.setDepositor(DEPOSIT_ONE, maker);
        escrow.setDepositor(DEPOSIT_TWO, maker);
        otherEscrow.setDepositor(DEPOSIT_ONE, otherMaker);
        unregisteredEscrow.setDepositor(DEPOSIT_ONE, maker);

        policy = new WhitelistPolicy(registry, escrowRegistry, orchestratorRegistry);
    }

    /* ============ Constructor ============ */

    function test_ConstructorRejectsZeroAndCodelessDependencies() public {
        vm.expectRevert(WhitelistPolicy.ZeroAddress.selector);
        new WhitelistPolicy(AddressGroupRegistry(address(0)), escrowRegistry, orchestratorRegistry);

        vm.expectRevert(WhitelistPolicy.ZeroAddress.selector);
        new WhitelistPolicy(registry, EscrowRegistry(address(0)), orchestratorRegistry);

        vm.expectRevert(WhitelistPolicy.ZeroAddress.selector);
        new WhitelistPolicy(registry, escrowRegistry, OrchestratorRegistry(address(0)));

        vm.expectRevert(abi.encodeWithSelector(WhitelistPolicy.InvalidDependency.selector, maker));
        new WhitelistPolicy(AddressGroupRegistry(maker), escrowRegistry, orchestratorRegistry);

        vm.expectRevert(abi.encodeWithSelector(WhitelistPolicy.InvalidDependency.selector, maker));
        new WhitelistPolicy(registry, EscrowRegistry(maker), orchestratorRegistry);

        vm.expectRevert(abi.encodeWithSelector(WhitelistPolicy.InvalidDependency.selector, maker));
        new WhitelistPolicy(registry, escrowRegistry, OrchestratorRegistry(maker));
    }

    /* ============ Governance ============ */

    function test_ConstructorSetsDeployerAsOwner() public {
        assertEq(policy.owner(), address(this));
    }

    function test_ConstructorStoresOrchestratorRegistry() public view {
        assertEq(address(policy.orchestratorRegistry()), address(orchestratorRegistry));
    }

    function test_SetEscrowRegistryUpdatesRegistryAndEmits() public {
        EscrowRegistry newEscrowRegistry = new EscrowRegistry();

        vm.expectEmit(true, false, false, true, address(policy));
        emit EscrowRegistryUpdated(address(newEscrowRegistry));
        policy.setEscrowRegistry(newEscrowRegistry);

        assertEq(address(policy.escrowRegistry()), address(newEscrowRegistry));
    }

    function test_SetEscrowRegistryRejectsNonOwner() public {
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        vm.prank(maker);
        policy.setEscrowRegistry(EscrowRegistry(address(otherEscrow)));

        assertEq(address(policy.escrowRegistry()), address(escrowRegistry));
    }

    function test_SetEscrowRegistryRejectsZeroAndCodelessRegistry() public {
        vm.expectRevert(WhitelistPolicy.ZeroAddress.selector);
        policy.setEscrowRegistry(EscrowRegistry(address(0)));

        vm.expectRevert(abi.encodeWithSelector(WhitelistPolicy.InvalidDependency.selector, maker));
        policy.setEscrowRegistry(EscrowRegistry(maker));

        assertEq(address(policy.escrowRegistry()), address(escrowRegistry));
    }

    function test_EscrowRegistryRotationRestoresRevocationAfterDivergence() public {
        EscrowRegistry newEscrowRegistry = new EscrowRegistry();
        newEscrowRegistry.addEscrow(address(escrow));

        vm.prank(maker);
        policy.configureDeposit(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, true, new bytes32[](0), _addresses(taker));

        assertTrue(policy.isTakerAllowed(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, taker));

        escrowRegistry.removeEscrow(address(escrow));

        vm.expectRevert(abi.encodeWithSelector(WhitelistPolicy.EscrowNotWhitelisted.selector, address(escrow)));
        vm.prank(maker);
        policy.removeWhitelistedAddresses(address(escrow), DEPOSIT_ONE, _addresses(taker));

        assertTrue(policy.isTakerAllowed(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, taker));

        policy.setEscrowRegistry(newEscrowRegistry);

        vm.prank(maker);
        policy.removeWhitelistedAddresses(address(escrow), DEPOSIT_ONE, _addresses(taker));

        assertFalse(policy.isWhitelisted(address(escrow), DEPOSIT_ONE, taker));
        assertFalse(policy.isTakerAllowed(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, taker));
    }

    /* ============ bootstrapDeposits ============ */

    function test_BootstrapDepositsEnablesBatchAndAddsGroups() public {
        policy.bootstrapDeposits(
            address(escrow), _depositIds(DEPOSIT_ONE, DEPOSIT_TWO), PAYMENT_METHOD, _groupIds(PEERS, PEER_PLUSES)
        );

        assertTrue(policy.bootstrapped(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD));
        assertTrue(policy.bootstrapped(address(escrow), DEPOSIT_TWO, PAYMENT_METHOD));
        assertTrue(policy.enabled(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD));
        assertTrue(policy.enabled(address(escrow), DEPOSIT_TWO, PAYMENT_METHOD));
        assertEq(policy.getAllowedGroups(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD), _groupIds(PEERS, PEER_PLUSES));
        assertEq(policy.getAllowedGroups(address(escrow), DEPOSIT_TWO, PAYMENT_METHOD), _groupIds(PEERS, PEER_PLUSES));
        assertFalse(policy.bootstrapped(address(escrow), DEPOSIT_ONE, OTHER_PAYMENT_METHOD));
        assertFalse(policy.enabled(address(escrow), DEPOSIT_ONE, OTHER_PAYMENT_METHOD));
        assertEq(policy.getAllowedGroups(address(escrow), DEPOSIT_ONE, OTHER_PAYMENT_METHOD).length, 0);
    }

    function test_BootstrapDepositsIsOwnerOnly() public {
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        vm.prank(maker);
        policy.bootstrapDeposits(address(escrow), _depositIds(DEPOSIT_ONE), PAYMENT_METHOD, _groupIds(PEERS));

        assertFalse(policy.bootstrapped(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD));
        assertFalse(policy.enabled(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD));
    }

    function test_BootstrapDepositsRejectsAlreadyBootstrappedDeposit() public {
        policy.bootstrapDeposits(address(escrow), _depositIds(DEPOSIT_ONE), PAYMENT_METHOD, _groupIds(PEERS));

        vm.expectRevert(
            abi.encodeWithSelector(
                WhitelistPolicy.DepositPaymentMethodAlreadyBootstrapped.selector,
                address(escrow),
                DEPOSIT_ONE,
                PAYMENT_METHOD
            )
        );
        policy.bootstrapDeposits(address(escrow), _depositIds(DEPOSIT_ONE), PAYMENT_METHOD, _groupIds(PEER_PLUSES));

        assertEq(policy.getAllowedGroups(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD), _groupIds(PEERS));
    }

    function test_BootstrapDepositsRejectsAlreadyEnabledDeposit() public {
        vm.prank(maker);
        policy.setEnabled(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, true);

        vm.expectRevert(
            abi.encodeWithSelector(
                WhitelistPolicy.DepositPaymentMethodAlreadyEnabled.selector,
                address(escrow),
                DEPOSIT_ONE,
                PAYMENT_METHOD
            )
        );
        policy.bootstrapDeposits(address(escrow), _depositIds(DEPOSIT_ONE), PAYMENT_METHOD, _groupIds(PEERS));

        assertFalse(policy.bootstrapped(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD));
        assertEq(policy.getAllowedGroups(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD).length, 0);
    }

    function test_BootstrapDepositsRollsBackEntireBatchWhenLaterDepositFails() public {
        vm.expectRevert(
            abi.encodeWithSelector(WhitelistPolicy.DepositNotFound.selector, address(escrow), UNKNOWN_DEPOSIT)
        );
        policy.bootstrapDeposits(
            address(escrow), _depositIds(DEPOSIT_ONE, UNKNOWN_DEPOSIT), PAYMENT_METHOD, _groupIds(PEERS, PEER_PLUSES)
        );

        assertFalse(policy.bootstrapped(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD));
        assertFalse(policy.enabled(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD));
        assertEq(policy.getAllowedGroups(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD).length, 0);
    }

    function test_BootstrapDepositsRejectsEmptyArrays() public {
        vm.expectRevert(WhitelistPolicy.EmptyArray.selector);
        policy.bootstrapDeposits(address(escrow), new uint256[](0), PAYMENT_METHOD, _groupIds(PEERS));

        vm.expectRevert(WhitelistPolicy.EmptyArray.selector);
        policy.bootstrapDeposits(address(escrow), _depositIds(DEPOSIT_ONE), PAYMENT_METHOD, new bytes32[](0));
    }

    function test_BootstrapDepositsRejectsUnregisteredEscrow() public {
        vm.expectRevert(
            abi.encodeWithSelector(WhitelistPolicy.EscrowNotWhitelisted.selector, address(unregisteredEscrow))
        );
        policy.bootstrapDeposits(
            address(unregisteredEscrow), _depositIds(DEPOSIT_ONE), PAYMENT_METHOD, _groupIds(PEERS)
        );
    }

    function test_BootstrapDepositsRejectsUnknownGroupAndRollsBack() public {
        bytes32 unknownGroup = bytes32(uint256(999));
        vm.expectRevert(abi.encodeWithSelector(WhitelistPolicy.GroupDoesNotExist.selector, unknownGroup));
        policy.bootstrapDeposits(
            address(escrow), _depositIds(DEPOSIT_ONE), PAYMENT_METHOD, _groupIds(PEERS, unknownGroup)
        );

        assertFalse(policy.bootstrapped(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD));
        assertFalse(policy.enabled(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD));
        assertEq(policy.getAllowedGroups(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD).length, 0);
    }

    function test_BootstrapDepositsEmitsCanonicalEvents() public {
        vm.expectEmit(true, true, false, true, address(policy));
        emit EnabledUpdated(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, true);
        vm.expectEmit(true, true, true, true, address(policy));
        emit AllowedGroupAdded(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, PEERS);
        vm.expectEmit(true, true, true, true, address(policy));
        emit AllowedGroupAdded(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, PEER_PLUSES);

        policy.bootstrapDeposits(
            address(escrow), _depositIds(DEPOSIT_ONE), PAYMENT_METHOD, _groupIds(PEERS, PEER_PLUSES)
        );
    }

    function test_DepositorCanDisableAndRemoveAllGroupsAfterBootstrap() public {
        policy.bootstrapDeposits(
            address(escrow), _depositIds(DEPOSIT_ONE), PAYMENT_METHOD, _groupIds(PEERS, PEER_PLUSES)
        );

        vm.startPrank(maker);
        policy.setEnabled(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, false);
        policy.removeAllowedGroups(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, _groupIds(PEERS, PEER_PLUSES));
        vm.stopPrank();

        assertFalse(policy.enabled(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD));
        assertEq(policy.getAllowedGroups(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD).length, 0);
        assertTrue(policy.bootstrapped(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD));

        vm.expectRevert(
            abi.encodeWithSelector(
                WhitelistPolicy.DepositPaymentMethodAlreadyBootstrapped.selector,
                address(escrow),
                DEPOSIT_ONE,
                PAYMENT_METHOD
            )
        );
        policy.bootstrapDeposits(address(escrow), _depositIds(DEPOSIT_ONE), PAYMENT_METHOD, _groupIds(PEER_MERCHANTS));
    }

    /* ============ Authorization ============ */

    function test_OnlyDepositorMayConfigureDeposit() public {
        vm.expectRevert(
            abi.encodeWithSelector(WhitelistPolicy.NotDepositor.selector, address(escrow), DEPOSIT_ONE, otherMaker)
        );
        vm.prank(otherMaker);
        policy.setEnabled(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, true);

        assertFalse(policy.enabled(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD));
    }

    function test_AllSixGatedEntryPointsRevertForNonDepositor() public {
        bytes memory expectedRevert =
            abi.encodeWithSelector(WhitelistPolicy.NotDepositor.selector, address(escrow), DEPOSIT_ONE, otherMaker);

        vm.expectRevert(expectedRevert);
        vm.prank(otherMaker);
        policy.setEnabled(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, true);

        vm.expectRevert(expectedRevert);
        vm.prank(otherMaker);
        policy.configureDeposit(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, true, new bytes32[](0), new address[](0));

        vm.expectRevert(expectedRevert);
        vm.prank(otherMaker);
        policy.addWhitelistedAddresses(address(escrow), DEPOSIT_ONE, _addresses(taker));

        vm.expectRevert(expectedRevert);
        vm.prank(otherMaker);
        policy.removeWhitelistedAddresses(address(escrow), DEPOSIT_ONE, _addresses(taker));

        vm.expectRevert(expectedRevert);
        vm.prank(otherMaker);
        policy.addAllowedGroups(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, _groupIds(PEERS));

        vm.expectRevert(expectedRevert);
        vm.prank(otherMaker);
        policy.removeAllowedGroups(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, _groupIds(PEERS));
    }

    function test_SetEnabledRevertsForUnknownDeposit() public {
        vm.expectRevert(
            abi.encodeWithSelector(WhitelistPolicy.DepositNotFound.selector, address(escrow), UNKNOWN_DEPOSIT)
        );
        vm.prank(maker);
        policy.setEnabled(address(escrow), UNKNOWN_DEPOSIT, PAYMENT_METHOD, true);
    }

    function test_SetEnabledRevertsForUnregisteredEscrow() public {
        vm.expectRevert(
            abi.encodeWithSelector(WhitelistPolicy.EscrowNotWhitelisted.selector, address(unregisteredEscrow))
        );
        vm.prank(maker);
        policy.setEnabled(address(unregisteredEscrow), DEPOSIT_ONE, PAYMENT_METHOD, true);
    }

    function test_AcceptAllEscrowsModePermitsUnregisteredEscrow() public {
        escrowRegistry.setAcceptAllEscrows(true);

        vm.prank(maker);
        policy.setEnabled(address(unregisteredEscrow), DEPOSIT_ONE, PAYMENT_METHOD, true);

        assertTrue(policy.enabled(address(unregisteredEscrow), DEPOSIT_ONE, PAYMENT_METHOD));
    }

    /* ============ setEnabled ============ */

    function test_SetEnabledIsScopedToDepositAndPaymentMethod() public {
        vm.expectEmit(true, true, false, true, address(policy));
        emit EnabledUpdated(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, true);
        vm.prank(maker);
        policy.setEnabled(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, true);

        assertTrue(policy.enabled(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD));
        assertFalse(policy.enabled(address(escrow), DEPOSIT_ONE, OTHER_PAYMENT_METHOD));
        assertFalse(policy.enabled(address(escrow), DEPOSIT_TWO, PAYMENT_METHOD));
        assertFalse(policy.enabled(address(otherEscrow), DEPOSIT_ONE, PAYMENT_METHOD));

        vm.prank(maker);
        policy.setEnabled(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, false);
        assertFalse(policy.enabled(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD));
    }

    /* ============ Direct whitelist ============ */

    function test_AddWhitelistedAddressesIsScopedToDepositAndIdempotent() public {
        address[] memory takers = _addresses(taker, otherTaker);

        vm.expectEmit(true, true, true, true, address(policy));
        emit AddressWhitelisted(address(escrow), DEPOSIT_ONE, taker);
        vm.expectEmit(true, true, true, true, address(policy));
        emit AddressWhitelisted(address(escrow), DEPOSIT_ONE, otherTaker);
        vm.prank(maker);
        policy.addWhitelistedAddresses(address(escrow), DEPOSIT_ONE, takers);

        assertTrue(policy.isWhitelisted(address(escrow), DEPOSIT_ONE, taker));
        assertTrue(policy.isWhitelisted(address(escrow), DEPOSIT_ONE, otherTaker));
        assertFalse(policy.isWhitelisted(address(escrow), DEPOSIT_TWO, taker));
        assertFalse(policy.isWhitelisted(address(otherEscrow), DEPOSIT_ONE, taker));

        vm.recordLogs();
        vm.prank(maker);
        policy.addWhitelistedAddresses(address(escrow), DEPOSIT_ONE, takers);
        assertEq(vm.getRecordedLogs().length, 0);
    }

    function test_AddWhitelistedAddressesRejectsEmptyArrayAndZeroAddress() public {
        vm.expectRevert(WhitelistPolicy.EmptyArray.selector);
        vm.prank(maker);
        policy.addWhitelistedAddresses(address(escrow), DEPOSIT_ONE, new address[](0));

        vm.expectRevert(WhitelistPolicy.ZeroAddress.selector);
        vm.prank(maker);
        policy.addWhitelistedAddresses(address(escrow), DEPOSIT_ONE, _addresses(taker, address(0)));

        assertFalse(policy.isWhitelisted(address(escrow), DEPOSIT_ONE, taker));
    }

    function test_RemoveWhitelistedAddressesIsIdempotent() public {
        vm.prank(maker);
        policy.addWhitelistedAddresses(address(escrow), DEPOSIT_ONE, _addresses(taker, otherTaker));

        vm.expectEmit(true, true, true, true, address(policy));
        emit AddressRemovedFromWhitelist(address(escrow), DEPOSIT_ONE, taker);
        vm.prank(maker);
        policy.removeWhitelistedAddresses(address(escrow), DEPOSIT_ONE, _addresses(taker));

        assertFalse(policy.isWhitelisted(address(escrow), DEPOSIT_ONE, taker));
        assertTrue(policy.isWhitelisted(address(escrow), DEPOSIT_ONE, otherTaker));

        vm.recordLogs();
        vm.prank(maker);
        policy.removeWhitelistedAddresses(address(escrow), DEPOSIT_ONE, _addresses(taker));
        assertEq(vm.getRecordedLogs().length, 0);
    }

    function test_RemoveWhitelistedAddressesRejectsEmptyArray() public {
        vm.expectRevert(WhitelistPolicy.EmptyArray.selector);
        vm.prank(maker);
        policy.removeWhitelistedAddresses(address(escrow), DEPOSIT_ONE, new address[](0));
    }

    /* ============ Allowed groups ============ */

    function test_AddAllowedGroupsSupportsViewsAndDeduplicates() public {
        bytes32[] memory groups = _groupIds(PEERS, PEER_PLUSES);

        vm.expectEmit(true, true, true, true, address(policy));
        emit AllowedGroupAdded(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, PEERS);
        vm.expectEmit(true, true, true, true, address(policy));
        emit AllowedGroupAdded(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, PEER_PLUSES);
        vm.prank(maker);
        policy.addAllowedGroups(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, groups);

        assertEq(policy.getAllowedGroups(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD), groups);
        assertEq(policy.getAllowedGroups(address(escrow), DEPOSIT_TWO, PAYMENT_METHOD).length, 0);
        assertTrue(policy.isGroupAllowed(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, PEERS));
        assertTrue(policy.isGroupAllowed(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, PEER_PLUSES));
        assertFalse(policy.isGroupAllowed(address(escrow), DEPOSIT_TWO, PAYMENT_METHOD, PEERS));
        assertFalse(policy.isGroupAllowed(address(otherEscrow), DEPOSIT_ONE, PAYMENT_METHOD, PEERS));

        vm.recordLogs();
        vm.prank(maker);
        policy.addAllowedGroups(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, groups);
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(policy.getAllowedGroups(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD).length, 2);
    }

    function test_AddAllowedGroupsRejectsEmptyAndUnknownGroups() public {
        vm.expectRevert(WhitelistPolicy.EmptyArray.selector);
        vm.prank(maker);
        policy.addAllowedGroups(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, new bytes32[](0));

        bytes32 unknownGroup = bytes32(uint256(999));
        vm.expectRevert(abi.encodeWithSelector(WhitelistPolicy.GroupDoesNotExist.selector, unknownGroup));
        vm.prank(maker);
        policy.addAllowedGroups(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, _groupIds(unknownGroup));

        assertEq(policy.getAllowedGroups(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD).length, 0);
    }

    function test_GroupCapIsPerDepositPaymentMethod() public {
        bytes32[] memory firstTen = new bytes32[](10);
        for (uint256 i = 0; i < firstTen.length; ++i) {
            firstTen[i] = registry.createGroup("Curated Group");
        }

        vm.prank(maker);
        policy.addAllowedGroups(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, firstTen);
        assertEq(
            policy.getAllowedGroups(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD).length,
            policy.MAX_GROUPS_PER_DEPOSIT_PAYMENT_METHOD()
        );

        bytes32 eleventh = registry.createGroup("Eleventh Group");
        vm.expectRevert(
            abi.encodeWithSelector(
                WhitelistPolicy.TooManyGroups.selector,
                policy.MAX_GROUPS_PER_DEPOSIT_PAYMENT_METHOD() + 1,
                policy.MAX_GROUPS_PER_DEPOSIT_PAYMENT_METHOD()
            )
        );
        vm.prank(maker);
        policy.addAllowedGroups(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, _groupIds(eleventh));

        vm.prank(maker);
        policy.addAllowedGroups(address(escrow), DEPOSIT_ONE, OTHER_PAYMENT_METHOD, _groupIds(eleventh));
        assertTrue(policy.isGroupAllowed(address(escrow), DEPOSIT_ONE, OTHER_PAYMENT_METHOD, eleventh));
    }

    function test_RemoveAllowedGroupsUsesSwapAndPopAndIsIdempotent() public {
        vm.prank(maker);
        policy.addAllowedGroups(
            address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, _groupIds(PEERS, PEER_PLUSES, PEER_MERCHANTS)
        );

        vm.expectEmit(true, true, true, true, address(policy));
        emit AllowedGroupRemoved(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, PEERS);
        vm.prank(maker);
        policy.removeAllowedGroups(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, _groupIds(PEERS));

        bytes32[] memory remaining = policy.getAllowedGroups(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD);
        assertEq(remaining.length, 2);
        assertEq(remaining[0], PEER_MERCHANTS);
        assertEq(remaining[1], PEER_PLUSES);
        assertFalse(policy.isGroupAllowed(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, PEERS));

        vm.recordLogs();
        vm.prank(maker);
        policy.removeAllowedGroups(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, _groupIds(PEERS));
        assertEq(vm.getRecordedLogs().length, 0);
    }

    function test_RemoveAllowedGroupsRejectsEmptyArray() public {
        vm.expectRevert(WhitelistPolicy.EmptyArray.selector);
        vm.prank(maker);
        policy.removeAllowedGroups(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, new bytes32[](0));
    }

    /* ============ configureDeposit ============ */

    function test_ConfigureDepositSetsEnabledGroupsAndTakersInOneCall() public {
        vm.prank(maker);
        policy.configureDeposit(
            address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, true, _groupIds(PEERS, PEER_PLUSES), _addresses(taker)
        );

        assertTrue(policy.enabled(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD));
        assertEq(policy.getAllowedGroups(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD).length, 2);
        assertTrue(policy.isWhitelisted(address(escrow), DEPOSIT_ONE, taker));
        assertTrue(policy.isTakerAllowed(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, taker));
    }

    function test_ConfigureDepositAcceptsEmptyArrays() public {
        vm.prank(maker);
        policy.configureDeposit(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, true, new bytes32[](0), new address[](0));

        assertTrue(policy.enabled(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD));
        assertEq(policy.getAllowedGroups(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD).length, 0);
        assertFalse(policy.isTakerAllowed(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, taker));
    }

    function test_ConfigureDepositIsAdditive() public {
        vm.startPrank(maker);
        policy.configureDeposit(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, true, _groupIds(PEERS), _addresses(taker));
        policy.configureDeposit(
            address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, true, _groupIds(PEER_PLUSES), _addresses(otherTaker)
        );
        vm.stopPrank();

        assertEq(policy.getAllowedGroups(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD).length, 2);
        assertTrue(policy.isGroupAllowed(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, PEERS));
        assertTrue(policy.isGroupAllowed(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, PEER_PLUSES));
        assertTrue(policy.isWhitelisted(address(escrow), DEPOSIT_ONE, taker));
        assertTrue(policy.isWhitelisted(address(escrow), DEPOSIT_ONE, otherTaker));
    }

    function test_ConfigureDepositEmitsGranularEvents() public {
        vm.expectEmit(true, true, false, true, address(policy));
        emit EnabledUpdated(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, true);
        vm.expectEmit(true, true, true, true, address(policy));
        emit AllowedGroupAdded(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, PEERS);
        vm.expectEmit(true, true, true, true, address(policy));
        emit AddressWhitelisted(address(escrow), DEPOSIT_ONE, taker);

        vm.prank(maker);
        policy.configureDeposit(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, true, _groupIds(PEERS), _addresses(taker));
    }

    function test_ConfigureDepositRollsBackPartialWritesOnValidationFailure() public {
        bytes32 unknownGroup = bytes32(uint256(999));
        vm.expectRevert(abi.encodeWithSelector(WhitelistPolicy.GroupDoesNotExist.selector, unknownGroup));
        vm.prank(maker);
        policy.configureDeposit(
            address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, true, _groupIds(PEERS, unknownGroup), _addresses(taker)
        );

        assertFalse(policy.enabled(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD));
        assertEq(policy.getAllowedGroups(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD).length, 0);
        assertFalse(policy.isWhitelisted(address(escrow), DEPOSIT_ONE, taker));

        vm.expectRevert(WhitelistPolicy.ZeroAddress.selector);
        vm.prank(maker);
        policy.configureDeposit(
            address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, true, _groupIds(PEERS), _addresses(taker, address(0))
        );

        assertFalse(policy.enabled(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD));
        assertEq(policy.getAllowedGroups(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD).length, 0);
        assertFalse(policy.isWhitelisted(address(escrow), DEPOSIT_ONE, taker));
    }

    function test_ConfigureDepositEnforcesGroupCapAndRollsBack() public {
        bytes32[] memory firstTen = new bytes32[](10);
        for (uint256 i = 0; i < firstTen.length; ++i) {
            firstTen[i] = registry.createGroup("Curated Group");
        }
        bytes32 eleventh = registry.createGroup("Eleventh Group");

        vm.prank(maker);
        policy.configureDeposit(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, true, firstTen, new address[](0));

        vm.expectRevert(
            abi.encodeWithSelector(
                WhitelistPolicy.TooManyGroups.selector,
                policy.MAX_GROUPS_PER_DEPOSIT_PAYMENT_METHOD() + 1,
                policy.MAX_GROUPS_PER_DEPOSIT_PAYMENT_METHOD()
            )
        );
        vm.prank(maker);
        policy.configureDeposit(
            address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, false, _groupIds(eleventh), _addresses(taker)
        );

        assertTrue(policy.enabled(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD));
        assertEq(
            policy.getAllowedGroups(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD).length,
            policy.MAX_GROUPS_PER_DEPOSIT_PAYMENT_METHOD()
        );
        assertFalse(policy.isWhitelisted(address(escrow), DEPOSIT_ONE, taker));
    }

    function test_ConfigureDepositRejectsNonDepositor() public {
        vm.expectRevert(
            abi.encodeWithSelector(WhitelistPolicy.NotDepositor.selector, address(escrow), DEPOSIT_ONE, otherMaker)
        );
        vm.prank(otherMaker);
        policy.configureDeposit(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, true, new bytes32[](0), new address[](0));
    }

    function test_ConfigureDepositWithEnabledFalseDisablesGateEvenWhenAppendingTakers() public {
        vm.prank(maker);
        policy.configureDeposit(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, true, _groupIds(PEERS), new address[](0));
        assertTrue(policy.enabled(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD));

        vm.prank(maker);
        policy.configureDeposit(
            address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, false, new bytes32[](0), _addresses(taker)
        );

        assertFalse(policy.enabled(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD));
        assertTrue(policy.isWhitelisted(address(escrow), DEPOSIT_ONE, taker));

        bytes32[] memory groups = policy.getAllowedGroups(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD);
        assertEq(groups.length, 1);
        assertEq(groups[0], PEERS);

        assertTrue(policy.isTakerAllowed(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, otherTaker));
    }

    /* ============ isTakerAllowed ============ */

    function test_IsTakerAllowedReturnsTrueWhenPolicyDisabled() public view {
        assertTrue(policy.isTakerAllowed(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, taker));
    }

    function test_IsTakerAllowedReturnsFalseForEnabledEmptyPolicy() public {
        vm.prank(maker);
        policy.setEnabled(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, true);

        assertFalse(policy.isTakerAllowed(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, taker));
        assertTrue(policy.isTakerAllowed(address(escrow), DEPOSIT_TWO, PAYMENT_METHOD, taker));
    }

    function test_IsTakerAllowedReturnsFalseForNonMember() public {
        vm.startPrank(maker);
        policy.setEnabled(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, true);
        policy.addAllowedGroups(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, _groupIds(PEERS));
        vm.stopPrank();

        assertFalse(policy.isTakerAllowed(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, taker));
    }

    function test_DirectWhitelistIsDepositWideAcrossPaymentMethods() public {
        vm.startPrank(maker);
        policy.setEnabled(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, true);
        policy.setEnabled(address(escrow), DEPOSIT_ONE, OTHER_PAYMENT_METHOD, true);
        policy.setEnabled(address(escrow), DEPOSIT_TWO, PAYMENT_METHOD, true);
        policy.addWhitelistedAddresses(address(escrow), DEPOSIT_ONE, _addresses(taker));
        vm.stopPrank();

        assertTrue(policy.isTakerAllowed(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, taker));
        assertTrue(policy.isTakerAllowed(address(escrow), DEPOSIT_ONE, OTHER_PAYMENT_METHOD, taker));
        assertFalse(policy.isTakerAllowed(address(escrow), DEPOSIT_TWO, PAYMENT_METHOD, taker));
    }

    function test_GroupAdmissionIsScopedToDepositAndPaymentMethod() public {
        vm.startPrank(maker);
        policy.setEnabled(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, true);
        policy.setEnabled(address(escrow), DEPOSIT_ONE, OTHER_PAYMENT_METHOD, true);
        policy.setEnabled(address(escrow), DEPOSIT_TWO, PAYMENT_METHOD, true);
        policy.addAllowedGroups(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, _groupIds(PEERS));
        vm.stopPrank();
        registry.addMembers(PEERS, _addresses(taker));

        assertTrue(policy.isTakerAllowed(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, taker));
        assertFalse(policy.isTakerAllowed(address(escrow), DEPOSIT_ONE, OTHER_PAYMENT_METHOD, taker));
        assertFalse(policy.isTakerAllowed(address(escrow), DEPOSIT_TWO, PAYMENT_METHOD, taker));
    }

    function test_PolicyIsIsolatedAcrossEscrowsWithSameDepositId() public {
        vm.prank(maker);
        policy.configureDeposit(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, true, new bytes32[](0), _addresses(taker));

        vm.prank(otherMaker);
        policy.setEnabled(address(otherEscrow), DEPOSIT_ONE, PAYMENT_METHOD, true);

        assertTrue(policy.isTakerAllowed(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, taker));
        assertFalse(policy.isTakerAllowed(address(otherEscrow), DEPOSIT_ONE, PAYMENT_METHOD, taker));
    }

    /* ============ Pre-intent hook ============ */

    function test_ValidateSignalIntentAllowsDisabledPolicy() public {
        orchestratorRegistry.addOrchestrator(address(this));
        policy.validateSignalIntent(_preIntentContext(taker));
    }

    function test_ValidateSignalIntentAllowsDirectlyWhitelistedTaker() public {
        vm.prank(maker);
        policy.configureDeposit(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, true, new bytes32[](0), _addresses(taker));
        orchestratorRegistry.addOrchestrator(address(this));

        policy.validateSignalIntent(_preIntentContext(taker));
    }

    function test_ValidateSignalIntentAllowsGroupMember() public {
        vm.prank(maker);
        policy.configureDeposit(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, true, _groupIds(PEERS), new address[](0));
        registry.addMembers(PEERS, _addresses(taker));
        orchestratorRegistry.addOrchestrator(address(this));

        policy.validateSignalIntent(_preIntentContext(taker));
    }

    function test_ValidateSignalIntentRejectsNonWhitelistedTaker() public {
        vm.prank(maker);
        policy.setEnabled(address(escrow), DEPOSIT_ONE, PAYMENT_METHOD, true);
        orchestratorRegistry.addOrchestrator(address(this));

        vm.expectRevert(
            abi.encodeWithSelector(
                WhitelistPolicy.TakerNotWhitelisted.selector, taker, address(escrow), DEPOSIT_ONE, PAYMENT_METHOD
            )
        );
        policy.validateSignalIntent(_preIntentContext(taker));
    }

    function test_ValidateSignalIntentRejectsUnregisteredCaller() public {
        vm.expectRevert(abi.encodeWithSelector(WhitelistPolicy.UnauthorizedOrchestratorCaller.selector, address(this)));
        policy.validateSignalIntent(_preIntentContext(taker));
    }

    /* ============ Helpers ============ */

    function _groupIds(bytes32 _first) internal pure returns (bytes32[] memory groupIds) {
        groupIds = new bytes32[](1);
        groupIds[0] = _first;
    }

    function _groupIds(bytes32 _first, bytes32 _second) internal pure returns (bytes32[] memory groupIds) {
        groupIds = new bytes32[](2);
        groupIds[0] = _first;
        groupIds[1] = _second;
    }

    function _groupIds(bytes32 _first, bytes32 _second, bytes32 _third)
        internal
        pure
        returns (bytes32[] memory groupIds)
    {
        groupIds = new bytes32[](3);
        groupIds[0] = _first;
        groupIds[1] = _second;
        groupIds[2] = _third;
    }

    function _depositIds(uint256 _first) internal pure returns (uint256[] memory depositIds) {
        depositIds = new uint256[](1);
        depositIds[0] = _first;
    }

    function _depositIds(uint256 _first, uint256 _second) internal pure returns (uint256[] memory depositIds) {
        depositIds = new uint256[](2);
        depositIds[0] = _first;
        depositIds[1] = _second;
    }

    function _addresses(address _first) internal pure returns (address[] memory addresses) {
        addresses = new address[](1);
        addresses[0] = _first;
    }

    function _addresses(address _first, address _second) internal pure returns (address[] memory addresses) {
        addresses = new address[](2);
        addresses[0] = _first;
        addresses[1] = _second;
    }

    function _preIntentContext(address _taker) internal view returns (IPreIntentHook.PreIntentContext memory context) {
        context = IPreIntentHook.PreIntentContext({
            taker: _taker,
            escrow: address(escrow),
            depositId: DEPOSIT_ONE,
            amount: 1,
            to: _taker,
            paymentMethod: PAYMENT_METHOD,
            fiatCurrency: bytes32(0),
            conversionRate: 0,
            referralFees: new IReferralFee.ReferralFee[](0),
            preIntentHookData: ""
        });
    }
}

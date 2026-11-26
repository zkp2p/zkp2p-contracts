// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {TakerRegistrationSigner} from "../helpers/TakerRegistrationSigner.sol";
import {ITakerRegistry} from "contracts/interfaces/ITakerRegistry.sol";
import {TakerRegistry} from "contracts/registries/TakerRegistry.sol";

contract TakerRegistryTest is TakerRegistrationSigner {
    bytes32 internal constant METHOD = keccak256("venmo");
    bytes32 internal constant OTHER_METHOD = keccak256("revolut");
    bytes32 internal constant IDENTITY = keccak256("identity");
    bytes32 internal constant OTHER_IDENTITY = keccak256("other identity");
    uint64 internal constant ISSUED_AT = 1_000_000;
    uint64 internal constant VALID_UNTIL = ISSUED_AT + 30 days;

    uint256 internal attestorKey;
    address internal attestor;
    address internal revoker;
    address internal wallet;
    address internal submitter;
    TakerRegistry internal registry;

    event TakerRegistered(address indexed wallet, bytes32 indexed method, bytes32 indexed identityId, uint64 validUntil);
    event TakerUnregistered(address indexed wallet, bytes32 indexed method);
    event IdentityRevoked(bytes32 indexed identityId);
    event IdentityReinstated(bytes32 indexed identityId);
    event AttestorUpdated(address indexed attestor, bool accepted);
    event RevokerUpdated(address indexed revoker);

    function setUp() public {
        (attestor, attestorKey) = makeAddrAndKey("attestor");
        revoker = makeAddr("revoker");
        wallet = makeAddr("wallet");
        submitter = makeAddr("submitter");

        vm.warp(ISSUED_AT);
        registry = new TakerRegistry(address(this), revoker);
        registry.setAttestor(attestor, true);
    }

    /* ============ register ============ */

    function test_RegistersFromAttestorStatement() public {
        ITakerRegistry.TakerRegistration memory statement = _statement(wallet, IDENTITY, ISSUED_AT);

        vm.expectEmit(address(registry));
        emit TakerRegistered(wallet, METHOD, IDENTITY, VALID_UNTIL);
        _register(statement);

        ITakerRegistry.Registration memory registration = registry.getRegistration(wallet, METHOD);
        assertEq(registration.identityId, IDENTITY);
        assertEq(registration.issuedAt, ISSUED_AT);
        assertEq(registration.validUntil, VALID_UNTIL);
        assertEq(registry.getRegistration(wallet, OTHER_METHOD).validUntil, 0);
        assertEq(registry.getRegistration(submitter, METHOD).validUntil, 0);
    }

    function test_SeveralWalletsRegisterOneIdentity() public {
        _register(_statement(wallet, IDENTITY, ISSUED_AT));
        _register(_statement(submitter, IDENTITY, ISSUED_AT));

        assertEq(registry.getRegistration(wallet, METHOD).identityId, IDENTITY);
        assertEq(registry.getRegistration(submitter, METHOD).identityId, IDENTITY);
    }

    function test_RejectsStatementFromUnacceptedSigner() public {
        (address stranger, uint256 strangerKey) = makeAddrAndKey("stranger");
        ITakerRegistry.TakerRegistration memory statement = _statement(wallet, IDENTITY, ISSUED_AT);

        vm.expectRevert(abi.encodeWithSelector(ITakerRegistry.InvalidAttestor.selector, stranger));
        registry.register(statement, _signRegistration(strangerKey, registry, statement));
    }

    function test_RejectsStatementSignedForAnotherWallet() public {
        ITakerRegistry.TakerRegistration memory statement = _statement(wallet, IDENTITY, ISSUED_AT);
        bytes memory signature = _signRegistration(attestorKey, registry, statement);
        statement.wallet = submitter;

        vm.expectRevert();
        registry.register(statement, signature);
        assertEq(registry.getRegistration(submitter, METHOD).validUntil, 0);
    }

    function test_RejectsStatementSignedForAnotherRegistry() public {
        TakerRegistry otherRegistry = new TakerRegistry(address(this), revoker);
        otherRegistry.setAttestor(attestor, true);
        ITakerRegistry.TakerRegistration memory statement = _statement(wallet, IDENTITY, ISSUED_AT);

        vm.expectRevert();
        otherRegistry.register(statement, _signRegistration(attestorKey, registry, statement));
        assertEq(otherRegistry.getRegistration(wallet, METHOD).validUntil, 0);
    }

    function test_RejectsStatementSignedForAnotherChain() public {
        ITakerRegistry.TakerRegistration memory statement = _statement(wallet, IDENTITY, ISSUED_AT);
        bytes memory signature = _signRegistration(attestorKey, registry, statement);
        vm.chainId(block.chainid + 1);

        vm.expectRevert();
        registry.register(statement, signature);
    }

    function test_RejectsLapsedStatement() public {
        ITakerRegistry.TakerRegistration memory statement = _statement(wallet, IDENTITY, ISSUED_AT);
        vm.warp(VALID_UNTIL);

        vm.expectRevert(abi.encodeWithSelector(ITakerRegistry.RegistrationExpired.selector, VALID_UNTIL, VALID_UNTIL));
        _register(statement);
    }

    function test_NewerStatementMovesWalletToAnotherIdentity() public {
        _register(_statement(wallet, IDENTITY, ISSUED_AT));
        _register(_statement(wallet, OTHER_IDENTITY, ISSUED_AT + 1));

        assertEq(registry.getRegistration(wallet, METHOD).identityId, OTHER_IDENTITY);
    }

    function test_RejectsOlderOrRepeatedStatement() public {
        ITakerRegistry.TakerRegistration memory older = _statement(wallet, IDENTITY, ISSUED_AT);
        ITakerRegistry.TakerRegistration memory newer = _statement(wallet, OTHER_IDENTITY, ISSUED_AT + 1);
        _register(newer);

        vm.expectRevert(abi.encodeWithSelector(ITakerRegistry.StaleRegistration.selector, ISSUED_AT, ISSUED_AT + 1));
        _register(older);
        vm.expectRevert(
            abi.encodeWithSelector(ITakerRegistry.StaleRegistration.selector, ISSUED_AT + 1, ISSUED_AT + 1)
        );
        _register(newer);
        assertEq(registry.getRegistration(wallet, METHOD).identityId, OTHER_IDENTITY);
    }

    /* ============ unregister ============ */

    function test_WalletUnregisters() public {
        _register(_statement(wallet, IDENTITY, ISSUED_AT));

        vm.expectEmit(address(registry));
        emit TakerUnregistered(wallet, METHOD);
        vm.prank(wallet);
        registry.unregister(METHOD);

        assertEq(registry.getRegistration(wallet, METHOD).validUntil, 0);
    }

    function test_UnregisteredStatementCannotBeReplayed() public {
        ITakerRegistry.TakerRegistration memory statement = _statement(wallet, IDENTITY, ISSUED_AT);
        _register(statement);
        vm.prank(wallet);
        registry.unregister(METHOD);

        vm.expectRevert(abi.encodeWithSelector(ITakerRegistry.StaleRegistration.selector, ISSUED_AT, ISSUED_AT));
        _register(statement);

        _register(_statement(wallet, IDENTITY, ISSUED_AT + 1));
        assertEq(registry.getRegistration(wallet, METHOD).validUntil, VALID_UNTIL);
    }

    function test_RejectsUnregisterWithoutRegistration() public {
        vm.expectRevert(abi.encodeWithSelector(ITakerRegistry.NotRegistered.selector, wallet, METHOD));
        vm.prank(wallet);
        registry.unregister(METHOD);
    }

    /* ============ revoke / reinstate ============ */

    function test_RevokerRevokesIdentities() public {
        bytes32[] memory identities = new bytes32[](2);
        identities[0] = IDENTITY;
        identities[1] = OTHER_IDENTITY;

        vm.expectEmit(address(registry));
        emit IdentityRevoked(IDENTITY);
        vm.expectEmit(address(registry));
        emit IdentityRevoked(OTHER_IDENTITY);
        vm.prank(revoker);
        registry.revoke(identities);

        assertTrue(registry.isRevoked(IDENTITY));
        assertTrue(registry.isRevoked(OTHER_IDENTITY));
    }

    function test_RevokedIdentityCannotRegisterUntilReinstated() public {
        _revoke(IDENTITY);
        ITakerRegistry.TakerRegistration memory statement = _statement(wallet, IDENTITY, ISSUED_AT);

        vm.expectRevert(abi.encodeWithSelector(ITakerRegistry.IdentityIsRevoked.selector, IDENTITY));
        _register(statement);

        vm.expectEmit(address(registry));
        emit IdentityReinstated(IDENTITY);
        registry.reinstate(IDENTITY);
        _register(statement);
        assertEq(registry.getRegistration(wallet, METHOD).identityId, IDENTITY);
    }

    function test_RevocationKeepsTheRegistrationRecord() public {
        _register(_statement(wallet, IDENTITY, ISSUED_AT));
        _revoke(IDENTITY);

        assertEq(registry.getRegistration(wallet, METHOD).identityId, IDENTITY);
        assertTrue(registry.isRevoked(IDENTITY));
    }

    function test_OnlyRevokerRevokes() public {
        bytes32[] memory identities = new bytes32[](1);
        identities[0] = IDENTITY;

        vm.expectRevert(abi.encodeWithSelector(ITakerRegistry.UnauthorizedCaller.selector, address(this), revoker));
        registry.revoke(identities);
        assertFalse(registry.isRevoked(IDENTITY));
    }

    function test_OnlyOwnerReinstates() public {
        _revoke(IDENTITY);

        vm.expectRevert("Ownable: caller is not the owner");
        vm.prank(revoker);
        registry.reinstate(IDENTITY);
        assertTrue(registry.isRevoked(IDENTITY));
    }

    /* ============ Governance ============ */

    function test_RemovedAttestorStopsRegisteringButKeepsRecords() public {
        _register(_statement(wallet, IDENTITY, ISSUED_AT));

        vm.expectEmit(address(registry));
        emit AttestorUpdated(attestor, false);
        registry.setAttestor(attestor, false);

        ITakerRegistry.TakerRegistration memory statement = _statement(submitter, IDENTITY, ISSUED_AT);
        vm.expectRevert(abi.encodeWithSelector(ITakerRegistry.InvalidAttestor.selector, attestor));
        _register(statement);
        assertEq(registry.getRegistration(wallet, METHOD).validUntil, VALID_UNTIL);
    }

    function test_OnlyOwnerSetsAttestorAndRevoker() public {
        vm.startPrank(revoker);
        vm.expectRevert("Ownable: caller is not the owner");
        registry.setAttestor(revoker, true);
        vm.expectRevert("Ownable: caller is not the owner");
        registry.setRevoker(revoker);
        vm.stopPrank();

        vm.expectRevert(ITakerRegistry.ZeroAddress.selector);
        registry.setAttestor(address(0), true);

        vm.expectEmit(address(registry));
        emit RevokerUpdated(submitter);
        registry.setRevoker(submitter);
        assertEq(registry.revoker(), submitter);
    }

    function test_RejectsZeroOwnerAndRenunciation() public {
        vm.expectRevert(ITakerRegistry.ZeroAddress.selector);
        new TakerRegistry(address(0), revoker);

        vm.expectRevert(ITakerRegistry.OwnershipRenunciationDisabled.selector);
        registry.renounceOwnership();
    }

    /* ============ Helpers ============ */

    function _statement(address registrant, bytes32 identityId, uint64 issuedAt)
        internal
        pure
        returns (ITakerRegistry.TakerRegistration memory)
    {
        return ITakerRegistry.TakerRegistration({
            wallet: registrant, method: METHOD, identityId: identityId, issuedAt: issuedAt, validUntil: VALID_UNTIL
        });
    }

    /// @dev Submits as a third party: a statement binds the wallet it names, not its submitter.
    function _register(ITakerRegistry.TakerRegistration memory statement) internal {
        bytes memory signature = _signRegistration(attestorKey, registry, statement);
        vm.prank(submitter);
        registry.register(statement, signature);
    }

    function _revoke(bytes32 identityId) internal {
        bytes32[] memory identities = new bytes32[](1);
        identities[0] = identityId;
        vm.prank(revoker);
        registry.revoke(identities);
    }
}

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
    event AttestorStatusUpdated(address indexed attestor, ITakerRegistry.AttestorStatus status);
    event RevokerUpdated(address indexed revoker);

    function setUp() public {
        (attestor, attestorKey) = makeAddrAndKey("attestor");
        revoker = makeAddr("revoker");
        wallet = makeAddr("wallet");
        submitter = makeAddr("submitter");

        vm.warp(ISSUED_AT);
        registry = new TakerRegistry(address(this), revoker);
        registry.setAttestorStatus(attestor, ITakerRegistry.AttestorStatus.Accepted);
    }

    /* ============ register ============ */

    function test_RegistersFromAttestorStatement() public {
        ITakerRegistry.TakerRegistration memory statement = _statement(wallet, IDENTITY, ISSUED_AT);

        vm.expectEmit(address(registry));
        emit TakerRegistered(wallet, METHOD, IDENTITY, VALID_UNTIL);
        _register(statement);

        ITakerRegistry.Registration memory registration = registry.getRegistration(wallet, METHOD);
        assertEq(registration.identityId, IDENTITY);
        assertEq(registration.attestor, attestor);
        assertEq(registration.validUntil, VALID_UNTIL);
        assertEq(registry.requireRegistered(wallet, METHOD), IDENTITY);
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

        bytes memory signature = _signRegistration(strangerKey, registry, statement);
        vm.expectRevert(abi.encodeWithSelector(ITakerRegistry.InvalidAttestor.selector, stranger));
        vm.prank(wallet);
        registry.register(statement, signature);
    }

    function test_OnlyTheNamedWalletSubmitsItsStatement() public {
        ITakerRegistry.TakerRegistration memory statement = _statement(wallet, IDENTITY, ISSUED_AT);
        bytes memory signature = _signRegistration(attestorKey, registry, statement);

        vm.expectRevert(abi.encodeWithSelector(ITakerRegistry.UnauthorizedCaller.selector, submitter, wallet));
        vm.prank(submitter);
        registry.register(statement, signature);
        assertEq(registry.getRegistration(wallet, METHOD).validUntil, 0);
    }

    function test_RejectsStatementSignedForAnotherWallet() public {
        ITakerRegistry.TakerRegistration memory statement = _statement(wallet, IDENTITY, ISSUED_AT);
        bytes memory signature = _signRegistration(attestorKey, registry, statement);
        statement.wallet = submitter;

        vm.expectRevert();
        vm.prank(submitter);
        registry.register(statement, signature);
        assertEq(registry.getRegistration(submitter, METHOD).validUntil, 0);
    }

    function test_RejectsStatementSignedForAnotherRegistry() public {
        TakerRegistry otherRegistry = new TakerRegistry(address(this), revoker);
        otherRegistry.setAttestorStatus(attestor, ITakerRegistry.AttestorStatus.Accepted);
        ITakerRegistry.TakerRegistration memory statement = _statement(wallet, IDENTITY, ISSUED_AT);
        bytes memory signature = _signRegistration(attestorKey, registry, statement);

        vm.expectRevert();
        vm.prank(wallet);
        otherRegistry.register(statement, signature);
        assertEq(otherRegistry.getRegistration(wallet, METHOD).validUntil, 0);
    }

    function test_RejectsStatementSignedForAnotherChain() public {
        ITakerRegistry.TakerRegistration memory statement = _statement(wallet, IDENTITY, ISSUED_AT);
        bytes memory signature = _signRegistration(attestorKey, registry, statement);
        vm.chainId(block.chainid + 1);

        vm.expectRevert();
        vm.prank(wallet);
        registry.register(statement, signature);
    }

    function test_RejectsLapsedStatement() public {
        ITakerRegistry.TakerRegistration memory statement = _statement(wallet, IDENTITY, ISSUED_AT);
        vm.warp(VALID_UNTIL);

        vm.expectRevert(abi.encodeWithSelector(ITakerRegistry.RegistrationExpired.selector, VALID_UNTIL, VALID_UNTIL));
        _register(statement);
    }

    function test_AnotherStatementMovesWalletToAnotherIdentity() public {
        _register(_statement(wallet, IDENTITY, ISSUED_AT));
        _register(_statement(wallet, OTHER_IDENTITY, ISSUED_AT + 1));

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

    function test_UnregisteredWalletNoLongerCountsAndMayRegisterAgain() public {
        ITakerRegistry.TakerRegistration memory statement = _statement(wallet, IDENTITY, ISSUED_AT);
        _register(statement);
        vm.prank(wallet);
        registry.unregister(METHOD);

        vm.expectRevert(abi.encodeWithSelector(ITakerRegistry.NotRegistered.selector, wallet, METHOD));
        registry.requireRegistered(wallet, METHOD);

        _register(statement);
        assertEq(registry.requireRegistered(wallet, METHOD), IDENTITY);
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

    function test_RevokedIdentityStopsCountingOnEveryWallet() public {
        _register(_statement(wallet, IDENTITY, ISSUED_AT));
        _register(_statement(submitter, IDENTITY, ISSUED_AT));
        _revoke(IDENTITY);

        vm.expectRevert(abi.encodeWithSelector(ITakerRegistry.IdentityIsRevoked.selector, IDENTITY));
        registry.requireRegistered(wallet, METHOD);
        vm.expectRevert(abi.encodeWithSelector(ITakerRegistry.IdentityIsRevoked.selector, IDENTITY));
        registry.requireRegistered(submitter, METHOD);
        assertEq(registry.getRegistration(wallet, METHOD).identityId, IDENTITY);
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

    function test_RetiredAttestorStopsRegisteringButItsRegistrationsCount() public {
        _register(_statement(wallet, IDENTITY, ISSUED_AT));

        vm.expectEmit(address(registry));
        emit AttestorStatusUpdated(attestor, ITakerRegistry.AttestorStatus.Retired);
        registry.setAttestorStatus(attestor, ITakerRegistry.AttestorStatus.Retired);

        ITakerRegistry.TakerRegistration memory statement = _statement(submitter, IDENTITY, ISSUED_AT);
        bytes memory signature = _signRegistration(attestorKey, registry, statement);
        vm.expectRevert(abi.encodeWithSelector(ITakerRegistry.InvalidAttestor.selector, attestor));
        vm.prank(submitter);
        registry.register(statement, signature);
        assertEq(registry.requireRegistered(wallet, METHOD), IDENTITY);
    }

    function test_RevokedAttestorsRegistrationsStopCounting() public {
        _register(_statement(wallet, IDENTITY, ISSUED_AT));
        registry.setAttestorStatus(attestor, ITakerRegistry.AttestorStatus.Revoked);

        vm.expectRevert(abi.encodeWithSelector(ITakerRegistry.AttestorIsRevoked.selector, attestor));
        registry.requireRegistered(wallet, METHOD);

        (address successor, uint256 successorKey) = makeAddrAndKey("successor");
        registry.setAttestorStatus(successor, ITakerRegistry.AttestorStatus.Accepted);
        ITakerRegistry.TakerRegistration memory statement = _statement(wallet, IDENTITY, ISSUED_AT);
        bytes memory signature = _signRegistration(successorKey, registry, statement);
        vm.prank(wallet);
        registry.register(statement, signature);
        assertEq(registry.requireRegistered(wallet, METHOD), IDENTITY);
    }

    function test_RegistrationStopsCountingWhenItLapses() public {
        _register(_statement(wallet, IDENTITY, ISSUED_AT));

        vm.warp(VALID_UNTIL - 1);
        assertEq(registry.requireRegistered(wallet, METHOD), IDENTITY);

        vm.warp(VALID_UNTIL);
        vm.expectRevert(abi.encodeWithSelector(ITakerRegistry.RegistrationExpired.selector, VALID_UNTIL, VALID_UNTIL));
        registry.requireRegistered(wallet, METHOD);
    }

    function test_OnlyOwnerSetsAttestorStatusAndRevoker() public {
        vm.startPrank(revoker);
        vm.expectRevert("Ownable: caller is not the owner");
        registry.setAttestorStatus(revoker, ITakerRegistry.AttestorStatus.Accepted);
        vm.expectRevert("Ownable: caller is not the owner");
        registry.setRevoker(revoker);
        vm.stopPrank();

        vm.expectRevert(ITakerRegistry.ZeroAddress.selector);
        registry.setAttestorStatus(address(0), ITakerRegistry.AttestorStatus.Accepted);

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

    function _register(ITakerRegistry.TakerRegistration memory statement) internal {
        bytes memory signature = _signRegistration(attestorKey, registry, statement);
        vm.prank(statement.wallet);
        registry.register(statement, signature);
    }

    function _revoke(bytes32 identityId) internal {
        bytes32[] memory identities = new bytes32[](1);
        identities[0] = identityId;
        vm.prank(revoker);
        registry.revoke(identities);
    }
}

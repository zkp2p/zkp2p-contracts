// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";

import {DisputeProtectionPolicyV3} from "contracts/hooks/DisputeProtectionPolicyV3.sol";
import {IDisputeProtectionPolicyV3 as P} from "contracts/interfaces/IDisputeProtectionPolicyV3.sol";
import {IDisputeVerifier} from "contracts/interfaces/IDisputeVerifier.sol";
import {IIntentSettlementPolicy as S} from "contracts/interfaces/IIntentSettlementPolicy.sol";
import {IReceiptVerifier} from "contracts/interfaces/IReceiptVerifier.sol";
import {StakeVaultV2} from "contracts/StakeVaultV2.sol";
import {USDCMock} from "contracts/mocks/USDCMock.sol";
import {NullifierRegistry} from "contracts/registries/NullifierRegistry.sol";
import {NullifierRegistryV2} from "contracts/registries/NullifierRegistryV2.sol";
import {NullifierRegistryV3} from "contracts/registries/NullifierRegistryV3.sol";
import {OrchestratorRegistry} from "contracts/registries/OrchestratorRegistry.sol";
import {DisputeVerifierV2} from "contracts/unifiedVerifier/DisputeVerifierV2.sol";
import {ReceiptVerifier} from "contracts/unifiedVerifier/ReceiptVerifier.sol";
import {AttestationVerifierMock} from "../mocks/AttestationVerifierMock.sol";

/// @notice Drives DisputeProtectionPolicyV3 through random settlements, share and full disputes, receipts, releases
/// and time, and keeps ghost accounting of what each protection has paid out.
contract DisputeProtectionPolicyV3Handler is Test {
    error UnexpectedRevert(bytes reason);
    error PaidBeforeMaturity(bytes32 intentHash, uint64 maturesAt, uint256 paidAt);

    uint256 internal constant MAX_AMOUNT = 1_000_000e6;
    bytes32 internal constant METHOD = keccak256("venmo");
    bytes32 internal constant SHARE = keccak256("PEER_RELEASE_SHARE");
    bytes32 internal constant USD = keccak256("USD");
    address internal constant DEPOSITOR = address(0xD0);

    USDCMock public token;
    StakeVaultV2 public vault;
    DisputeProtectionPolicyV3 public policy;
    NullifierRegistryV3 internal payments;
    uint256 internal nonce;

    address[] public owners;
    /// @dev Position of each lock owner in `owners`, plus one; zero for unknown addresses.
    mapping(address => uint256) internal ownerSlot;
    bytes32[] public intents;
    /// @dev Amount locked when the protection opened.
    mapping(bytes32 => uint256) public originalLock;
    /// @dev Amount the protection has handed out: depositor claims plus releases to the lock owner.
    mapping(bytes32 => uint256) public delivered;
    /// @dev Set once a share dispute relocked a remainder; that remainder may leave only at maturity or in a dispute.
    mapping(bytes32 => bool) public relocked;

    constructor() {
        vm.warp(1_000_000);
        token = new USDCMock(type(uint128).max, "USDC", "USDC");
        vault = new StakeVaultV2(address(this), token);
        payments = new NullifierRegistryV3(new NullifierRegistryV2(new NullifierRegistry()));
        payments.addWritePermission(address(this));
        NullifierRegistry disputes = new NullifierRegistry();
        OrchestratorRegistry orchestrators = new OrchestratorRegistry();
        orchestrators.addOrchestrator(address(this));
        policy = new DisputeProtectionPolicyV3(
            address(this),
            vault,
            new DisputeVerifierV2(address(this), payments, new AttestationVerifierMock()),
            new ReceiptVerifier(address(this), payments, new AttestationVerifierMock()),
            disputes,
            orchestrators
        );
        disputes.addWritePermission(address(policy));
        vault.setController(address(policy), true);
        for (uint256 index; index < 3; ++index) _addOwner(address(uint160(0x1000 + index)));
    }

    /* ============ Actions ============ */

    /// @dev Opens a protection on a taker's stake, or as a deferred payout to a fresh recipient.
    function settle(uint256 takerSeed, uint256 rawRelease, uint256 rawNet, uint256 rawWindow, bool addStake) external {
        address taker = owners[takerSeed % 3];
        uint256 releaseAmount = bound(rawRelease, 1, MAX_AMOUNT);
        if (addStake) _deposit(taker, releaseAmount);

        bytes32 intentHash = keccak256(abi.encode("intent", ++nonce));
        address recipient = address(uint160(0x100000 + nonce));
        S.SettlementContext memory context = S.SettlementContext(
            intentHash,
            address(token),
            taker,
            recipient,
            DEPOSITOR,
            METHOD,
            releaseAmount,
            bound(rawNet, 1, releaseAmount),
            abi.encode(bound(rawWindow, 1, 30 days))
        );
        if (policy.settleIntent(context) == address(0)) {
            originalLock[intentHash] = releaseAmount;
        } else {
            token.transfer(address(vault), context.netAmount);
            policy.onDeferredPayoutFunded(context);
            originalLock[intentHash] = context.netAmount;
            _addOwner(recipient);
        }
        payments.addNullifier(_nullifier(intentHash), intentHash);
        intents.push(intentHash);
    }

    function shareDispute(uint256 index, uint256 rawClaim) external {
        if (intents.length == 0) return;
        bytes32 intentHash = intents[index % intents.length];
        IDisputeVerifier.DisputeAttestation memory attestation =
            _dispute(intentHash, bound(rawClaim, 1, 2 * MAX_AMOUNT), SHARE);
        uint256 depositorBefore = vault.claimable(DEPOSITOR);
        try policy.submitDispute(attestation) {
            delivered[intentHash] += vault.claimable(DEPOSITOR) - depositorBefore;
            if (policy.getProtection(intentHash).partiallyDisputed) relocked[intentHash] = true;
        } catch (bytes memory reason) {
            _expect(reason, P.ProtectionNotFound.selector, P.AlreadyPartiallyDisputed.selector, P.ProtectionMatured.selector);
        }
    }

    function fullDispute(uint256 index) external {
        if (intents.length == 0) return;
        bytes32 intentHash = intents[index % intents.length];
        IDisputeVerifier.DisputeAttestation memory attestation = _dispute(intentHash, 1, USD);
        uint256 depositorBefore = vault.claimable(DEPOSITOR);
        try policy.submitDispute(attestation) {
            delivered[intentHash] += vault.claimable(DEPOSITOR) - depositorBefore;
        } catch (bytes memory reason) {
            _expect(reason, P.ProtectionNotFound.selector, P.ProtectionNotFound.selector, P.ProtectionNotFound.selector);
        }
    }

    /// @dev Never reverts: stale, partially disputed and confirmed entries are skipped, and a due payout is made now.
    function confirmReceipt(uint256 index, uint256 rawOffset, bool alreadyDue) external {
        if (intents.length == 0) return;
        bytes32 intentHash = intents[index % intents.length];
        uint64 releaseAt = alreadyDue
            ? uint64(bound(rawOffset, 1, block.timestamp))
            : uint64(block.timestamp + bound(rawOffset, 1, 60 days));
        bytes32[] memory candidates = new bytes32[](1);
        candidates[0] = _nullifier(intentHash);
        bytes memory data = abi.encode(METHOD, candidates);
        IReceiptVerifier.ReceiptAttestation[] memory receipts = new IReceiptVerifier.ReceiptAttestation[](1);
        receipts[0] = IReceiptVerifier.ReceiptAttestation(intentHash, releaseAt, keccak256(data), new bytes[](0), data);

        (address owner,, uint64 maturesAt) = vault.locks(intentHash);
        uint256 ownerBefore = _ownerValue(owner);
        policy.confirmReceipts(receipts);
        _recordPayout(intentHash, owner, ownerBefore, maturesAt);
    }

    function release(uint256 index, bool warpToDue) external {
        if (intents.length == 0) return;
        bytes32 intentHash = intents[index % intents.length];
        (address owner,, uint64 maturesAt) = vault.locks(intentHash);
        if (warpToDue && owner != address(0)) {
            uint64 releaseAt = policy.getProtection(intentHash).releaseAt;
            uint64 dueAt = releaseAt != 0 && releaseAt < maturesAt ? releaseAt : maturesAt;
            if (block.timestamp < dueAt) vm.warp(dueAt);
        }
        uint256 ownerBefore = _ownerValue(owner);
        try policy.release(_ids(intentHash)) {
            _recordPayout(intentHash, owner, ownerBefore, maturesAt);
        } catch (bytes memory reason) {
            _expect(reason, P.ProtectionNotFound.selector, P.NotMatured.selector, P.NotMatured.selector);
        }
    }

    function warp(uint256 rawSeconds) external {
        vm.warp(block.timestamp + bound(rawSeconds, 1, 20 days));
    }

    function claimDepositorAward() external {
        if (vault.claimable(DEPOSITOR) == 0) return;
        vm.prank(DEPOSITOR);
        vault.claim();
    }

    /* ============ Invariants ============ */

    function assertInvariants() external view {
        uint256[] memory lockedByOwner = new uint256[](owners.length);
        for (uint256 index; index < intents.length; ++index) {
            bytes32 intentHash = intents[index];
            (address owner, uint256 amount,) = vault.locks(intentHash);
            P.Protection memory protection = policy.getProtection(intentHash);

            // Never paid twice: what left the lock plus what is still locked is exactly what was locked.
            assertEq(delivered[intentHash] + amount, originalLock[intentHash], "protection over- or under-paid");
            // A protection is open exactly while its lock exists.
            assertEq(protection.depositor != address(0), owner != address(0), "protection and lock disagree");
            // A relocked remainder carries no early-release time.
            if (protection.partiallyDisputed) assertEq(protection.releaseAt, 0, "partial dispute kept a releaseAt");
            if (owner != address(0)) lockedByOwner[_ownerIndex(owner)] += amount;
        }

        uint256 totalStake;
        for (uint256 index; index < owners.length; ++index) {
            assertEq(lockedByOwner[index], vault.lockedStake(owners[index]), "owner locks disagree with lockedStake");
            totalStake += vault.stakeBalance(owners[index]);
        }
        assertEq(totalStake, vault.totalStaked(), "stake balances disagree with totalStaked");
        assertEq(token.balanceOf(address(vault)), vault.totalStaked() + vault.totalClaimable(), "vault balance");
        assertEq(vault.unaccountedBalance(), 0, "unexpected unaccounted tokens");
        assertEq(token.balanceOf(address(policy)), 0, "policy holds tokens");
        assertEq(vault.claimable(address(policy)), 0, "policy holds a claim");
    }

    function intentCount() external view returns (uint256) {
        return intents.length;
    }

    /* ============ Helpers ============ */

    function _deposit(address owner, uint256 amount) internal {
        token.transfer(owner, amount);
        vm.startPrank(owner);
        token.approve(address(vault), amount);
        vault.depositStake(amount);
        vm.stopPrank();
    }

    /// @dev Value a release hands a lock owner: tokens for a deferred payout, free stake for a stake lock.
    function _ownerValue(address owner) internal view returns (uint256) {
        if (owner == address(0)) return 0;
        return token.balanceOf(owner) + vault.freeStake(owner);
    }

    function _recordPayout(bytes32 intentHash, address owner, uint256 ownerBefore, uint64 maturesAt) internal {
        if (owner == address(0)) return;
        uint256 paid = _ownerValue(owner) - ownerBefore;
        if (paid == 0) return;
        if (relocked[intentHash] && block.timestamp < maturesAt) {
            revert PaidBeforeMaturity(intentHash, maturesAt, block.timestamp);
        }
        delivered[intentHash] += paid;
    }

    function _dispute(bytes32 intentHash, uint256 amount, bytes32 currency)
        internal
        returns (IDisputeVerifier.DisputeAttestation memory)
    {
        bytes32[] memory candidates = new bytes32[](1);
        candidates[0] = _nullifier(intentHash);
        bytes memory data = abi.encode(
            IDisputeVerifier.DisputeDetails(
                METHOD, keccak256("payment-id"), keccak256(abi.encode("dispute", ++nonce)), amount, currency
            ),
            candidates
        );
        return IDisputeVerifier.DisputeAttestation(intentHash, keccak256(data), new bytes[](0), data);
    }

    function _expect(bytes memory reason, bytes4 first, bytes4 second, bytes4 third) internal pure {
        bytes4 selector = bytes4(reason);
        if (selector != first && selector != second && selector != third) revert UnexpectedRevert(reason);
    }

    function _addOwner(address owner) internal {
        owners.push(owner);
        ownerSlot[owner] = owners.length;
    }

    function _ownerIndex(address owner) internal view returns (uint256) {
        uint256 slot = ownerSlot[owner];
        if (slot == 0) revert UnexpectedRevert(abi.encode(owner));
        return slot - 1;
    }

    function _nullifier(bytes32 intentHash) internal pure returns (bytes32) {
        return keccak256(abi.encode("payment", intentHash));
    }

    function _ids(bytes32 intentHash) internal pure returns (bytes32[] memory ids) {
        ids = new bytes32[](1);
        ids[0] = intentHash;
    }
}

contract DisputeProtectionPolicyV3InvariantTest is StdInvariant, Test {
    DisputeProtectionPolicyV3Handler internal handler;

    function setUp() public {
        handler = new DisputeProtectionPolicyV3Handler();
        bytes4[] memory selectors = new bytes4[](7);
        selectors[0] = handler.settle.selector;
        selectors[1] = handler.shareDispute.selector;
        selectors[2] = handler.fullDispute.selector;
        selectors[3] = handler.confirmReceipt.selector;
        selectors[4] = handler.release.selector;
        selectors[5] = handler.warp.selector;
        selectors[6] = handler.claimDepositorAward.selector;
        targetSelector(FuzzSelector(address(handler), selectors));
        targetContract(address(handler));
    }

    /// @dev Per-owner locks match lockedStake, stake balances sum to totalStaked, the vault holds exactly its
    /// liabilities, the policy holds nothing, and no protection ever pays out more than it locked.
    function invariant_ProtectionsConserveTheirLocksAndVaultBalances() public view {
        handler.assertInvariants();
    }
}

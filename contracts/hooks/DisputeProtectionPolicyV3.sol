// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IDisputeProtectionPolicyV3} from "../interfaces/IDisputeProtectionPolicyV3.sol";
import {IDisputeVerifier} from "../interfaces/IDisputeVerifier.sol";
import {IIntentSettlementPolicy} from "../interfaces/IIntentSettlementPolicy.sol";
import {INullifierRegistry} from "../interfaces/INullifierRegistry.sol";
import {IOrchestratorRegistry} from "../interfaces/IOrchestratorRegistry.sol";
import {IReceiptVerifier} from "../interfaces/IReceiptVerifier.sol";
import {IStakeVaultV2} from "../interfaces/IStakeVaultV2.sol";

/**
 * @title DisputeProtectionPolicyV3
 * @notice Settles OrchestratorV4 payouts against the taker's stake, or defers them, for the signed dispute window.
 * A proven dispute pays the maker only the unpaid share of the release, and an enclave-signed receipt confirmation
 * releases the hold early.
 * @dev DisputeProtectionPolicyV2 plus the settled release amount, which makes share disputes possible, and a confirmed
 * releaseAt per protection, which makes it due at min(lock maturity, releaseAt). A share dispute pays the maker's
 * share and relocks the paid remainder until maturity, so the paid part stays disputable; a full dispute stays
 * possible until the protection is paid out. The StakeVaultV2 lock under the intent hash holds owner, amount and
 * maturity. Canonical USDC only.
 */
contract DisputeProtectionPolicyV3 is IDisputeProtectionPolicyV3, Ownable2Step, ReentrancyGuard {
    /* ============ Structs ============ */

    /// @dev Storage layout of a protection; the first four fields share one slot, so confirming a receipt rewrites a
    /// warm slot instead of initializing a new one. `getProtection` returns it in V2's leading order.
    struct ProtectionRecord {
        address depositor;
        bool deferredPayout;
        bool partiallyDisputed;
        uint64 releaseAt;
        bytes32 paymentMethod;
        uint256 releaseAmount;
    }

    /* ============ Constants ============ */

    uint64 public constant MAX_DISPUTE_WINDOW = 180 days;

    /// @notice Dispute currency whose `paymentAmount` is the maker's claim in release-amount (USDC base) units.
    bytes32 public constant RELEASE_SHARE_CURRENCY = keccak256("PEER_RELEASE_SHARE");

    /* ============ State Variables ============ */

    /// @notice Stake custody and lock accounting controlled by this policy.
    IStakeVaultV2 public immutable override stakeVault;

    /// @notice Dedicated replay registry for payment-method-scoped dispute nullifiers.
    INullifierRegistry public immutable disputeNullifierRegistry;

    /// @notice Orchestrators allowed to call the settlement callbacks.
    IOrchestratorRegistry public immutable orchestratorRegistry;

    /// @notice Verifier used to validate signed dispute evidence. Must be an instance no other policy uses, because a
    /// share claim verified for this policy would pay a whole lock on a policy that ignores the claimed amount.
    IDisputeVerifier public disputeVerifier;

    /// @notice Verifier used to validate signed receipt confirmations.
    IReceiptVerifier public receiptVerifier;

    /// @dev Open protections keyed by globally unique intent hash; deleted on release or a whole-lock dispute.
    mapping(bytes32 => ProtectionRecord) internal protections;

    /* ============ Constructor ============ */

    /**
     * @notice Creates the policy; authorize it as a vault controller and a dispute-nullifier writer before use.
     * @param _owner Governance owner for policy and dependency configuration.
     * @param _stakeVault Vault holding and locking taker collateral.
     * @param _disputeVerifier Deployed verifier for signed dispute evidence, used by no other policy.
     * @param _receiptVerifier Deployed verifier for signed receipt confirmations.
     * @param _disputeNullifierRegistry Dedicated registry that rejects reused dispute nullifiers.
     * @param _orchestratorRegistry Registry of orchestrators allowed to call the settlement callbacks.
     */
    constructor(
        address _owner,
        IStakeVaultV2 _stakeVault,
        IDisputeVerifier _disputeVerifier,
        IReceiptVerifier _receiptVerifier,
        INullifierRegistry _disputeNullifierRegistry,
        IOrchestratorRegistry _orchestratorRegistry
    ) {
        if (_owner == address(0)) revert ZeroAddress();
        _validateDependency(address(_disputeVerifier));
        _validateDependency(address(_receiptVerifier));
        stakeVault = _stakeVault;
        disputeVerifier = _disputeVerifier;
        receiptVerifier = _receiptVerifier;
        disputeNullifierRegistry = _disputeNullifierRegistry;
        orchestratorRegistry = _orchestratorRegistry;
        _transferOwnership(_owner);
    }

    /* ============ Modifiers ============ */

    modifier onlyOrchestrator() {
        if (!orchestratorRegistry.isOrchestrator(msg.sender)) revert UnauthorizedOrchestrator(msg.sender);
        _;
    }

    /* ============ Lifecycle Functions ============ */

    /// @inheritdoc IIntentSettlementPolicy
    /// @dev settlementData is abi.encode(uint256 disputeWindow). Zero windows and non-stake tokens pay now.
    function settleIntent(SettlementContext calldata _context)
        external override onlyOrchestrator returns (address deferralVault)
    {
        uint256 window = abi.decode(_context.settlementData, (uint256));
        if (window > MAX_DISPUTE_WINDOW) revert InvalidDisputeWindow(window);
        if (window == 0) return address(0);
        if (_context.token != address(stakeVault.stakeToken())) return address(0);

        address stakeOwner = stakeVault.stakeOwnerOf(_context.taker);
        bool staked = stakeVault.freeStake(stakeOwner) >= _context.releaseAmount;
        protections[_context.intentHash] = ProtectionRecord({
            depositor: _context.depositor,
            deferredPayout: !staked,
            partiallyDisputed: false,
            releaseAt: 0,
            paymentMethod: _context.paymentMethod,
            releaseAmount: _context.releaseAmount
        });
        if (staked) {
            stakeVault.lockStake(stakeOwner, _context.intentHash, _context.releaseAmount, _maturity(uint64(window)));
        } else {
            deferralVault = address(stakeVault);
        }
        emit ProtectionOpened(_context.intentHash, _context.depositor);
    }

    /// @inheritdoc IIntentSettlementPolicy
    function onDeferredPayoutFunded(SettlementContext calldata _context) external override onlyOrchestrator nonReentrant {
        uint64 window = uint64(abi.decode(_context.settlementData, (uint256)));
        stakeVault.fundLock(_context.recipient, _context.intentHash, _context.netAmount, _maturity(window));
    }

    /* ============ Permissionless Functions ============ */

    /// @inheritdoc IDisputeProtectionPolicyV3
    function release(bytes32[] calldata _intentHashes) external override nonReentrant {
        for (uint256 i = 0; i < _intentHashes.length; i++) {
            _release(_intentHashes[i]);
        }
    }

    /// @inheritdoc IDisputeProtectionPolicyV3
    function confirmReceipts(IReceiptVerifier.ReceiptAttestation[] calldata _receipts) external override nonReentrant {
        for (uint256 i = 0; i < _receipts.length; i++) {
            _confirmReceipt(_receipts[i]);
        }
    }

    /// @inheritdoc IDisputeProtectionPolicyV3
    /// @dev Reads the claim from the `DisputeDetails` head of the evidence data. The verifier has already checked
    /// that data against the signed hash, and `DisputeDetails` is static, so it is the head of every layout a
    /// DisputeVerifier accepts. Right after `resolveLock` the remainder is the lock owner's free stake (the taker's
    /// stake owner, or the payout recipient that `fundLock` credited), so relocking it cannot fail for lack of stake.
    function submitDispute(IDisputeVerifier.DisputeAttestation calldata _attestation) external override nonReentrant {
        bytes32 intentHash = _attestation.intentHash;
        ProtectionRecord memory protection = protections[intentHash];
        if (protection.depositor == address(0)) revert ProtectionNotFound(intentHash);

        (bytes32 disputeId, bytes32 disputeNullifier) =
            disputeVerifier.verifyDispute(_attestation, protection.paymentMethod);
        IDisputeVerifier.DisputeDetails memory details =
            abi.decode(_attestation.data, (IDisputeVerifier.DisputeDetails));

        (address lockOwner, uint256 lockAmount, uint64 maturesAt) = stakeVault.locks(intentHash);
        uint256 compensatedAmount = lockAmount;
        if (details.paymentCurrency == RELEASE_SHARE_CURRENCY) {
            if (protection.partiallyDisputed) revert AlreadyPartiallyDisputed(intentHash);
            compensatedAmount = _shareOf(lockAmount, protection.releaseAmount, details.paymentAmount);
            if (compensatedAmount == 0) revert ZeroClaim();
        }
        uint256 remainder = lockAmount - compensatedAmount;
        if (remainder != 0 && block.timestamp >= maturesAt) revert ProtectionMatured(intentHash, maturesAt);

        disputeNullifierRegistry.addNullifier(disputeNullifier);
        if (remainder == 0) {
            delete protections[intentHash];
        } else {
            ProtectionRecord storage record = protections[intentHash];
            record.partiallyDisputed = true;
            record.releaseAt = 0;
        }

        IStakeVaultV2.Claim[] memory claims = new IStakeVaultV2.Claim[](1);
        claims[0] = IStakeVaultV2.Claim({beneficiary: protection.depositor, amount: compensatedAmount});
        stakeVault.resolveLock(intentHash, claims);
        if (remainder != 0) stakeVault.lockStake(lockOwner, intentHash, remainder, maturesAt);

        emit DisputeResolved(intentHash, lockOwner, protection.depositor, compensatedAmount, disputeId);
        if (remainder != 0) emit RemainderRelocked(intentHash, lockOwner, remainder, maturesAt);
    }

    /* ============ Governance Functions ============ */

    /**
     * @notice GOVERNANCE ONLY: Replaces the verifier used for future dispute submissions. Never share it with
     * another policy (see `disputeVerifier`).
     * @param _verifier New non-zero deployed dispute verifier.
     */
    function setDisputeVerifier(address _verifier) external onlyOwner {
        _validateDependency(_verifier);
        address previousVerifier = address(disputeVerifier);
        disputeVerifier = IDisputeVerifier(_verifier);
        emit DisputeVerifierUpdated(previousVerifier, _verifier);
    }

    /**
     * @notice GOVERNANCE ONLY: Replaces the verifier used for future receipt confirmations. Rotating it invalidates
     * confirmations signed for the previous verifier but not yet submitted.
     * @param _verifier New non-zero deployed receipt verifier.
     */
    function setReceiptVerifier(address _verifier) external onlyOwner {
        _validateDependency(_verifier);
        address previousVerifier = address(receiptVerifier);
        receiptVerifier = IReceiptVerifier(_verifier);
        emit ReceiptVerifierUpdated(previousVerifier, _verifier);
    }

    /**
     * @notice Disables ownership renunciation so governed safety controls cannot become unreachable.
     */
    function renounceOwnership() public view override onlyOwner {
        revert OwnershipRenunciationDisabled();
    }

    /* ============ View Functions ============ */

    /// @inheritdoc IDisputeProtectionPolicyV3
    function getProtection(bytes32 _intentHash) external view override returns (Protection memory) {
        ProtectionRecord storage protection = protections[_intentHash];
        return Protection({
            depositor: protection.depositor,
            deferredPayout: protection.deferredPayout,
            paymentMethod: protection.paymentMethod,
            releaseAt: protection.releaseAt,
            releaseAmount: protection.releaseAmount,
            partiallyDisputed: protection.partiallyDisputed
        });
    }

    /* ============ Internal Functions ============ */

    function _release(bytes32 _intentHash) internal {
        ProtectionRecord storage protection = protections[_intentHash];
        if (protection.depositor == address(0)) revert ProtectionNotFound(_intentHash);

        (,, uint64 maturesAt) = stakeVault.locks(_intentHash);
        uint64 releaseAt = protection.releaseAt;
        uint64 dueAt = releaseAt != 0 && releaseAt < maturesAt ? releaseAt : maturesAt;
        if (block.timestamp < dueAt) revert NotMatured(dueAt, uint64(block.timestamp));

        bool deferredPayout = protection.deferredPayout;
        delete protections[_intentHash];
        if (deferredPayout) {
            stakeVault.payOutLock(_intentHash);
        } else {
            stakeVault.unlockStake(_intentHash);
        }
        emit ProtectionReleased(_intentHash);
    }

    /// @dev Skips stale, partially disputed and repeated entries so one never sinks a keeper's batch; a payout already
    /// due is made now instead of stored, unless the vault cannot make it.
    function _confirmReceipt(IReceiptVerifier.ReceiptAttestation calldata _receipt) internal {
        bytes32 intentHash = _receipt.intentHash;
        ProtectionRecord storage protection = protections[intentHash];
        if (protection.depositor == address(0)) {
            emit ReceiptSkipped(intentHash, SkipReason.STALE);
            return;
        }
        if (protection.partiallyDisputed) {
            emit ReceiptSkipped(intentHash, SkipReason.PARTIALLY_DISPUTED);
            return;
        }
        if (protection.releaseAt != 0) {
            emit ReceiptSkipped(intentHash, SkipReason.ALREADY_CONFIRMED);
            return;
        }

        uint64 releaseAt = receiptVerifier.verifyReceipt(_receipt, protection.paymentMethod);
        emit ReceiptConfirmed(intentHash, releaseAt);
        if (block.timestamp >= releaseAt) {
            if (_tryPayOut(intentHash)) return;
            emit ReceiptPayoutFailed(intentHash);
        }
        protection.releaseAt = releaseAt;
    }

    /**
     * @dev Closes the protection and hands the whole lock to its owner. If the vault call fails, for example because
     * the payout recipient cannot receive the token, the protection is restored and false returned.
     */
    function _tryPayOut(bytes32 _intentHash) internal returns (bool paid) {
        ProtectionRecord memory protection = protections[_intentHash];
        delete protections[_intentHash];
        if (protection.deferredPayout) {
            try stakeVault.payOutLock(_intentHash) {
                paid = true;
            } catch {}
        } else {
            try stakeVault.unlockStake(_intentHash) {
                paid = true;
            } catch {}
        }

        if (paid) {
            emit ProtectionReleased(_intentHash);
        } else {
            protections[_intentHash] = protection;
        }
    }

    /**
     * @dev The maker's share of a lock for a share dispute. The claim is capped at the release amount, so the
     * rounded-up result never exceeds the lock. An open protection always has a nonzero release amount, because the
     * vault rejects zero-amount locks.
     */
    function _shareOf(uint256 _lockAmount, uint256 _releaseAmount, uint256 _claim) internal pure returns (uint256) {
        return Math.mulDiv(_lockAmount, Math.min(_claim, _releaseAmount), _releaseAmount, Math.Rounding.Up);
    }

    function _maturity(uint64 _window) internal view returns (uint64) {
        return uint64(block.timestamp) + _window;
    }

    function _validateDependency(address _dependency) internal view {
        if (_dependency == address(0)) revert ZeroAddress();
        if (_dependency.code.length == 0) revert InvalidContract(_dependency);
    }
}

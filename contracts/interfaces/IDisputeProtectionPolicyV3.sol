// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {IDisputeVerifier} from "./IDisputeVerifier.sol";
import {IIntentSettlementPolicy} from "./IIntentSettlementPolicy.sol";
import {IReceiptVerifier} from "./IReceiptVerifier.sol";
import {IStakeVaultV2} from "./IStakeVaultV2.sol";

/// @notice Selects dispute collateral, settles share disputes and releases holds early on confirmed receipts.
/// Zero windows and non-stake tokens pay now without a record or event.
interface IDisputeProtectionPolicyV3 is IIntentSettlementPolicy {
    /// @dev View of a protection. The first three fields keep DisputeProtectionPolicyV2's positions, so positional
    /// readers of V2's tuple stay correct. The StakeVaultV2 lock with id intentHash holds the owner, amount and
    /// maturity; after a share dispute it holds only the relocked remainder.
    struct Protection {
        address depositor;        // paid on a proven dispute
        bool deferredPayout;      // the lock holds the recipient's net payout rather than the taker's stake
        bytes32 paymentMethod;    // selects the dispute and receipt verification rules
        uint64 releaseAt;         // confirmed early-release time; zero until a receipt is confirmed
        uint256 releaseAmount;    // settled release amount; the unit of a share dispute's claim
        bool partiallyDisputed;   // a share dispute paid the maker and relocked the remainder until maturity
    }

    /// @notice Why `confirmReceipts` skipped an entry instead of confirming it. Skipped entries are not verified.
    enum SkipReason {
        STALE,                    // no open protection: never opened, already released or disputed in full
        ALREADY_CONFIRMED         // the protection already holds a confirmed releaseAt
    }

    event ProtectionOpened(bytes32 indexed intentHash, address indexed depositor);
    event ProtectionReleased(bytes32 indexed intentHash);
    event DisputeResolved(bytes32 indexed intentHash, address indexed stakeOwner, address indexed depositor, uint256 compensatedAmount, bytes32 disputeId);
    event RemainderRelocked(bytes32 indexed intentHash, address indexed owner, uint256 amount, uint64 maturesAt);
    event DisputeVerifierUpdated(address indexed previousVerifier, address indexed newVerifier);
    event ReceiptConfirmed(bytes32 indexed intentHash, uint64 releaseAt);
    event ReceiptSkipped(bytes32 indexed intentHash, SkipReason reason);
    event ReceiptPayoutFailed(bytes32 indexed intentHash);
    event ReceiptVerifierUpdated(address indexed previousVerifier, address indexed newVerifier);

    error ZeroAddress();
    error UnauthorizedOrchestrator(address caller);
    error ProtectionNotFound(bytes32 intentHash);
    /// @dev `maturesAt` is the protection's due time, min(lock maturity, confirmed releaseAt).
    error NotMatured(uint64 maturesAt, uint64 currentTime);
    error InvalidDisputeWindow(uint256 window);
    error ZeroClaim();
    error ProtectionMatured(bytes32 intentHash, uint64 maturesAt);
    error AlreadyPartiallyDisputed(bytes32 intentHash);
    error OwnershipRenunciationDisabled();

    /// @notice Returns the collateral vault.
    function stakeVault() external view returns (IStakeVaultV2);

    /**
     * @notice Returns the open protection for an intent; zero after release or a dispute that took the whole lock.
     * @param _intentHash Protected intent.
     */
    function getProtection(bytes32 _intentHash) external view returns (Protection memory);

    /**
     * @notice Releases every listed protection that is due, at min(lock maturity, confirmed releaseAt). A taker's
     * stake returns to its owner's free stake; a deferred payout is transferred to its recipient, so recipients that
     * cannot call the vault still get paid.
     * @param _intentHashes Protected intents to release; the call reverts if any is missing or not yet due.
     */
    function release(bytes32[] calldata _intentHashes) external;

    /**
     * @notice Records enclave-signed receipt confirmations so their protections release early, and pays out at once
     * each one whose signed releaseAt has passed.
     * @dev Per entry: no open protection emits `ReceiptSkipped(STALE)`; one already holding a releaseAt emits
     * `ReceiptSkipped(ALREADY_CONFIRMED)`; neither is verified, so a skip is not evidence of anything. Otherwise the
     * receipt is verified against the protection's payment method, and an invalid signature, a wrong method or an
     * unbound payment reverts the whole call. A due payout the vault cannot make keeps the releaseAt and emits
     * `ReceiptPayoutFailed` instead of reverting. A confirmed receipt never blocks a dispute; the batch size is the
     * caller's to keep under the block gas limit.
     * @param _receipts Signed receipt confirmations, one per protected intent.
     */
    function confirmReceipts(IReceiptVerifier.ReceiptAttestation[] calldata _receipts) external;

    /**
     * @notice Resolves valid dispute evidence into an immediately claimable depositor award.
     * @dev A share dispute (`paymentCurrency == RELEASE_SHARE_CURRENCY`) signs the maker's claim in release-amount
     * units in `paymentAmount` and pays ⌈lock × min(claim, releaseAmount) ÷ releaseAmount⌉. The paid remainder is
     * relocked for the lock owner until the original maturity, so a later reversal of the paid part can still be
     * disputed; the protection stays open, marked partially disputed, with any confirmed releaseAt cleared. A share
     * dispute that leaves a remainder must land before maturity, and a protection takes one share dispute only. Any
     * other currency pays the whole remaining lock and closes the protection, until it is released.
     * @param _attestation Signed dispute evidence for a settled intent.
     */
    function submitDispute(IDisputeVerifier.DisputeAttestation calldata _attestation) external;
}

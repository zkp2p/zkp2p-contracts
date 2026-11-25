// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {IDisputeVerifier} from "./IDisputeVerifier.sol";
import {IIntentSettlementPolicy} from "./IIntentSettlementPolicy.sol";
import {IStakeVaultV2} from "./IStakeVaultV2.sol";

/// @notice Selects dispute collateral, settles share disputes and releases holds early on confirmed receipts.
/// Zero windows and non-stake tokens pay now without a record or event.
interface IDisputeProtectionPolicyV3 is IIntentSettlementPolicy {
    /// @dev The StakeVaultV2 lock with id intentHash holds the owner, amount and maturity. The first three fields
    /// share one storage slot, so confirming a receipt rewrites a warm slot instead of initializing a new one.
    struct Protection {
        address depositor;        // paid on a proven dispute
        bool deferredPayout;      // the lock holds the recipient's net payout rather than the taker's stake
        uint64 releaseAt;         // confirmed early-release time; zero until a receipt is confirmed
        bytes32 paymentMethod;    // selects the dispute and receipt verification rules
        uint256 releaseAmount;    // settled release amount; the unit of a share dispute's claim
    }

    event ProtectionOpened(bytes32 indexed intentHash, address indexed depositor);
    event ProtectionReleased(bytes32 indexed intentHash);
    event DisputeResolved(bytes32 indexed intentHash, address indexed stakeOwner, address indexed depositor, uint256 compensatedAmount, bytes32 disputeId);
    event RemainderPaid(bytes32 indexed intentHash, address indexed recipient, uint256 amount);
    event DisputeVerifierUpdated(address indexed previousVerifier, address indexed newVerifier);

    error ZeroAddress();
    error UnauthorizedOrchestrator(address caller);
    error ProtectionNotFound(bytes32 intentHash);
    error NotMatured(uint64 maturesAt, uint64 currentTime);
    error InvalidDisputeWindow(uint256 window);
    error ZeroClaim();
    error RemainderTransferFailed(uint256 expected, uint256 received);
    error OwnershipRenunciationDisabled();

    /// @notice Returns the collateral vault.
    function stakeVault() external view returns (IStakeVaultV2);

    /**
     * @notice Returns the open protection for an intent; zero after release or dispute.
     * @param _intentHash Protected intent.
     */
    function getProtection(bytes32 _intentHash) external view returns (Protection memory);

    /**
     * @notice Releases every listed protection that is due. A taker's stake returns to its owner's free stake; a
     * deferred payout is transferred to its recipient, so recipients that cannot call the vault still get paid.
     * @param _intentHashes Protected intents to release; the call reverts if any is missing or not yet due.
     */
    function release(bytes32[] calldata _intentHashes) external;

    /**
     * @notice Resolves valid dispute evidence into an immediately claimable depositor award.
     * @dev A share dispute (`paymentCurrency == RELEASE_SHARE_CURRENCY`) signs the maker's claim in release-amount
     * units in `paymentAmount` and pays ⌈lock × min(claim, releaseAmount) ÷ releaseAmount⌉; any other currency pays
     * the whole lock. On a deferred payout the rest of the lock is transferred to the payout recipient in the same
     * call; on a stake lock it stays the stake owner's free stake.
     * @param _attestation Signed dispute evidence for a settled intent.
     */
    function submitDispute(IDisputeVerifier.DisputeAttestation calldata _attestation) external;
}

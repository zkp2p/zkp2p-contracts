// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {INonPaymentVerifier} from "./INonPaymentVerifier.sol";

/**
 * @title IBondedArbitrator
 * @notice OrchestratorV4 arbitrator that releases an intent only against locked stake and lets the depositor recover
 * the unpaid share from that stake with an attestor-signed scan of the seller account.
 */
interface IBondedArbitrator {
    /// @notice The payment the operator relied on, committed at release.
    struct PaymentClaim {
        uint64 paidAfter;      // The payment was sent at or after this time; no earlier than MAX_LOOKBACK before signal
        uint256 amount;        // Fiat amount the evidence shows, in the deposit token's decimals
        bytes32 payerHash;     // keccak256 of the normalized payer display name; zero when unknown
        bytes32 txIdHash;      // Platform payment id, hashed as payment attestations hash it; zero when unknown
        bytes32 evidenceHash;  // Hash of the off-chain evidence, for audit; zero when none
    }

    /// @notice An open release: who backs it, who is owed on a dispute, and what a scan must match.
    /// @dev The locked amount and maturity live in the StakeVaultV2 lock.
    struct Release {
        address operator;
        address bondOwner;
        address depositor;     // Captured before release; paid on a proven dispute
        uint64 releasedAt;
        bytes32 paymentMethod;
        bytes32 payeeId;
        bytes32 fiatCurrency;
        PaymentClaim claim;
    }

    event ArbitratedRelease(
        bytes32 indexed intentHash,
        address indexed operator,
        address indexed bondOwner,
        uint256 amount,
        uint64 maturesAt,
        Release release
    );
    event ReleaseOverturned(
        bytes32 indexed intentHash,
        address indexed bondOwner,
        address indexed depositor,
        uint256 amount,
        bytes32 historyHash
    );
    event ReleaseSettled(bytes32 indexed intentHash, address indexed bondOwner, bool acknowledgedByDepositor);
    event OperatorSet(address indexed bondOwner, address indexed operator, uint256 cap);
    event BondOwnerSet(address indexed bondOwner, bool approved);
    event DisputeWindowSet(bytes32 indexed paymentMethod, uint64 window);
    event NonPaymentVerifierSet(address indexed previousVerifier, address indexed newVerifier);

    error ZeroAddress();
    error UnauthorizedOperator(address caller);
    error UnauthorizedBondOwner(address caller);
    error OperatorTaken(address operator, address bondOwner);
    error NotArbitrator(bytes32 intentHash);
    error ArbitrationDisabled(bytes32 paymentMethod);
    error UnsupportedToken(address token);
    error InvalidClaimWindow(uint64 paidAfter, uint256 intentTimestamp);
    error UnidentifiedPayment();
    error ClaimBelowRelease(uint256 amount, uint256 releaseFiatValue);
    error OperatorCapExceeded(address operator, uint256 locked, uint256 cap);
    error ReleaseNotFound(bytes32 intentHash);
    error DisputeWindowClosed(uint64 maturesAt);
    error ScanMismatch(bytes32 intentHash);
    error StaleEvidence(uint64 windowEnd);
    error UnboundExclusion(bytes32 paymentId);
    error PaymentCovered(uint256 receivedAmount, uint256 claimedAmount);
    error NotMatured(uint64 maturesAt);
    error UnauthorizedDepositor(address caller);
    error InvalidDisputeWindow(uint64 window);
    error OwnershipRenunciationDisabled();

    /**
     * @notice OPERATOR ONLY: Pays the intent recipient now and locks the same amount of the bond owner's stake until
     * the payment method's dispute window ends.
     * @param _intentHash Intent naming this contract as arbitrator.
     * @param _releaseAmount Deposit tokens to release; any rest returns to the deposit.
     * @param _claim Payment the operator relied on.
     */
    function release(bytes32 _intentHash, uint256 _releaseAmount, PaymentClaim calldata _claim) external;

    /**
     * @notice Pays the depositor the unpaid share of the bond shown by a fresh attestor scan of the seller account.
     * @param _attestation Signed scan for the released intent.
     */
    function disputeNonPayment(INonPaymentVerifier.NonPaymentAttestation calldata _attestation) external;

    /**
     * @notice DEPOSITOR ONLY: Confirms the payment arrived and unlocks the bond before maturity.
     * @param _intentHash Released intent.
     */
    function acknowledge(bytes32 _intentHash) external;

    /**
     * @notice Unlocks the bond of every listed release whose dispute window has ended.
     * @param _intentHashes Released intents.
     */
    function settle(bytes32[] calldata _intentHashes) external;

    /**
     * @notice BOND OWNER ONLY: Authorizes an operator to lock the caller's stake up to `_cap`; zero revokes it.
     * @param _operator Operator address.
     * @param _cap Most stake the operator's open releases may hold locked.
     */
    function setOperator(address _operator, uint256 _cap) external;

    /// @notice Returns an open release; all zero after dispute or settlement.
    function getRelease(bytes32 _intentHash) external view returns (Release memory);

    /// @notice Returns the StakeVaultV2 lock id that holds a release's bond.
    function lockId(bytes32 _intentHash) external view returns (bytes32);
}

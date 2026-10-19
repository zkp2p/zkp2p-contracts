// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {IIntentSettlementPolicy} from "../interfaces/IIntentSettlementPolicy.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";

import {IDisputeProtectionPolicyV2} from "../interfaces/IDisputeProtectionPolicyV2.sol";
import {IDisputeVerifier} from "../interfaces/IDisputeVerifier.sol";
import {INullifierRegistry} from "../interfaces/INullifierRegistry.sol";
import {IStakeVaultV2} from "../interfaces/IStakeVaultV2.sol";

/**
 * @title DisputeProtectionPolicyV2
 * @notice Selects existing stake or deferred payout collateral at settlement.
 * @dev Deferred payouts are stake locks funded by the payout. The token must have no transfer callbacks
 * (canonical USDC only). StakeVaultV2 owns collateral accounting; the dedicated dispute registry owns replay state.
 * TRUST: Authorized orchestrators must invoke callbacks only for their own validated intents and escrows.
 * Settlement uses the depositor and token captured before escrow unlock and never reads escrow.
 * Intent hashes must embed the originating orchestrator so identities cannot collide. Authorize a successor
 * policy alongside its predecessor in StakeVaultV2 and select it on O4; every later settlement uses it. The
 * predecessor keeps serving its own locks; de-authorize it only after its locks drain. Any authorized vault
 * controller can lock any owner's free stake.
 * Protection applies only to stake-token deposits with a nonzero window in the signed settlement data.
 * There are no per-method windows or paused admissions. O4 never calls the policy for manual releases or for
 * takers whitelisted at signal. Zero windows and non-stake tokens return without a record or event. Protected
 * settlements lock gross stake or defer the net payout until now plus the attested window. The vault lock holds
 * the owner, amount and maturity; this policy keeps only the depositor and payment method a dispute needs.
 */
contract DisputeProtectionPolicyV2 is IDisputeProtectionPolicyV2, Ownable2Step, ReentrancyGuard {
    /* ============ Constants ============ */

    uint64 public constant MAX_DISPUTE_WINDOW = 180 days;

    /* ============ State Variables ============ */

    /// @notice Stake custody and lock accounting controlled by this policy.
    IStakeVaultV2 public immutable override stakeVault;

    /// @notice Dedicated replay registry for payment-method-scoped dispute nullifiers.
    INullifierRegistry public immutable disputeNullifierRegistry;

    /// @notice Verifier used to validate signed dispute evidence.
    IDisputeVerifier public disputeVerifier;

    /// @notice Orchestrators allowed to call the settlement callbacks.
    mapping(address => bool) public override isOrchestratorAuthorized;

    /// @dev Open protections keyed by globally unique intent hash; deleted on release or dispute.
    mapping(bytes32 => Protection) internal protections;

    /* ============ Constructor ============ */

    /**
     * @notice Creates a dispute protection policy over one StakeVaultV2 and one dedicated dispute-nullifier registry.
     * @dev After deployment, authorize this policy as a StakeVaultV2 controller and as a writer on the dedicated
     * dispute nullifier registry before enabling deposits.
     * @param _owner Governance owner for policy and dependency configuration.
     * @param _stakeVault Vault holding and locking taker collateral.
     * @param _disputeVerifier Verifier for signed dispute evidence.
     * @param _disputeNullifierRegistry Dedicated registry that rejects reused dispute nullifiers.
     */
    constructor(
        address _owner,
        IStakeVaultV2 _stakeVault,
        IDisputeVerifier _disputeVerifier,
        INullifierRegistry _disputeNullifierRegistry
    ) {
        if (_owner == address(0)) revert ZeroAddress();
        stakeVault = _stakeVault;
        disputeVerifier = _disputeVerifier;
        disputeNullifierRegistry = _disputeNullifierRegistry;
        _transferOwnership(_owner);
    }

    /* ============ Modifiers ============ */

    modifier onlyAuthorizedOrchestrator() {
        if (!isOrchestratorAuthorized[msg.sender]) {
            revert UnauthorizedOrchestrator(msg.sender);
        }
        _;
    }

    /* ============ Lifecycle Functions ============ */

    /// @inheritdoc IIntentSettlementPolicy
    function settleIntent(SettlementContext calldata _context)
        external override onlyAuthorizedOrchestrator returns (address deferralVault)
    {
        uint256 window = abi.decode(_context.settlementData, (uint256));
        if (window > MAX_DISPUTE_WINDOW) revert InvalidDisputeWindow(window);
        if (window == 0) return address(0);
        if (_context.token != address(stakeVault.stakeToken())) return address(0);
        return _protect(_context, uint64(window));
    }

    /// @dev Apply the reentrancy guard only to protected settlements that change state.
    function _protect(SettlementContext calldata _context, uint64 _window) internal nonReentrant returns (address deferralVault) {
        protections[_context.intentHash] = Protection({depositor: _context.depositor, paymentMethod: _context.paymentMethod});
        address stakeOwner = stakeVault.stakeOwnerOf(_context.taker);
        if (stakeVault.freeStake(stakeOwner) >= _context.releaseAmount) {
            stakeVault.lockStake(stakeOwner, _context.intentHash, _context.releaseAmount, _maturity(_window));
        } else {
            deferralVault = address(stakeVault);
        }
        emit ProtectionOpened(_context.intentHash, _context.depositor);
    }

    /// @inheritdoc IIntentSettlementPolicy
    function onDeferredPayoutFunded(SettlementContext calldata _context) external override onlyAuthorizedOrchestrator nonReentrant {
        uint64 window = uint64(abi.decode(_context.settlementData, (uint256)));
        stakeVault.fundLock(_context.recipient, _context.intentHash, _context.netAmount, _maturity(window));
    }

    /* ============ Permissionless Functions ============ */

    /**
     * @notice Releases the collateral of every listed protection whose lock has matured.
     * @dev Disputes remain valid after a lock matures until its release executes. One ineligible intent reverts the batch.
     * @param _intentHashes Protected intents whose collateral should be unlocked.
     */
    function release(bytes32[] calldata _intentHashes) external nonReentrant {
        for (uint256 i = 0; i < _intentHashes.length; i++) {
            _release(_intentHashes[i]);
        }
    }

    /**
     * @notice Resolves valid dispute evidence into an immediately claimable depositor award.
     * @dev A settled intent remains disputable until its collateral release executes, even after the lock
     * matures. The dedicated dispute nullifier registry atomically rejects replayed disputes.
     * @param _attestation Signed dispute evidence for a settled intent.
     */
    function submitDispute(IDisputeVerifier.DisputeAttestation calldata _attestation) external nonReentrant {
        bytes32 intentHash = _attestation.intentHash;
        Protection memory protection = protections[intentHash];
        if (protection.depositor == address(0)) revert ProtectionNotFound(intentHash);

        (bytes32 disputeId, bytes32 disputeNullifier) =
            disputeVerifier.verifyDispute(_attestation, protection.paymentMethod);
        disputeNullifierRegistry.addNullifier(disputeNullifier);
        delete protections[intentHash];

        (address stakeOwner, uint256 compensatedAmount,) = stakeVault.locks(intentHash);
        IStakeVaultV2.Claim[] memory claims = new IStakeVaultV2.Claim[](1);
        claims[0] = IStakeVaultV2.Claim({beneficiary: protection.depositor, amount: compensatedAmount});
        stakeVault.resolveLock(intentHash, claims);

        emit DisputeResolved(intentHash, stakeOwner, protection.depositor, compensatedAmount, disputeId);
    }

    /* ============ Governance Functions ============ */

    /**
     * @notice GOVERNANCE ONLY: Replaces the verifier used for future dispute submissions.
     * @param _verifier New dispute verifier.
     */
    function setDisputeVerifier(address _verifier) external onlyOwner {
        address previousVerifier = address(disputeVerifier);
        disputeVerifier = IDisputeVerifier(_verifier);
        emit DisputeVerifierUpdated(previousVerifier, _verifier);
    }

    /**
     * @notice GOVERNANCE ONLY: Authorizes or revokes one orchestrator.
     * @dev Authorize an orchestrator before configuring this policy on it.
     * @param _orchestrator Orchestrator whose callback authority is updated.
     * @param _isAuthorized Whether the orchestrator may mutate dispute protection intent state.
     */
    function setOrchestratorAuthorization(address _orchestrator, bool _isAuthorized) external override onlyOwner {
        isOrchestratorAuthorized[_orchestrator] = _isAuthorized;
        emit OrchestratorAuthorizationUpdated(_orchestrator, _isAuthorized);
    }

    /**
     * @notice Disables ownership renunciation so governed safety controls cannot become unreachable.
     */
    function renounceOwnership() public view override onlyOwner {
        revert OwnershipRenunciationDisabled();
    }

    /* ============ View Functions ============ */

    /**
     * @notice Returns the open protection for an intent; zero after release or dispute.
     * @param _intentHash Protected intent.
     */
    function getProtection(bytes32 _intentHash) external view returns (Protection memory) {
        return protections[_intentHash];
    }

    /* ============ Internal Functions ============ */

    function _release(bytes32 _intentHash) internal {
        if (protections[_intentHash].depositor == address(0)) revert ProtectionNotFound(_intentHash);

        (,, uint64 maturesAt) = stakeVault.locks(_intentHash);
        if (block.timestamp < maturesAt) revert NotMatured(maturesAt, uint64(block.timestamp));

        delete protections[_intentHash];
        stakeVault.unlockStake(_intentHash);
        emit ProtectionReleased(_intentHash);
    }

    function _maturity(uint64 _window) internal view returns (uint64) {
        return uint64(block.timestamp) + _window;
    }
}

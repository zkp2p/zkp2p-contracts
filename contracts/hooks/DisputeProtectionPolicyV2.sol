// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {IIntentSettlementPolicy} from "../interfaces/IIntentSettlementPolicy.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";

import {IDisputeProtectionPolicyV2} from "../interfaces/IDisputeProtectionPolicyV2.sol";
import {IDisputeVerifier} from "../interfaces/IDisputeVerifier.sol";
import {INullifierRegistry} from "../interfaces/INullifierRegistry.sol";
import {IOrchestratorRegistry} from "../interfaces/IOrchestratorRegistry.sol";
import {IStakeVaultV2} from "../interfaces/IStakeVaultV2.sol";

/**
 * @title DisputeProtectionPolicyV2
 * @notice Settles OrchestratorV4 payouts against the taker's stake, or defers them, for the signed dispute window.
 * @dev The StakeVaultV2 lock under the intent hash holds owner, amount and maturity; this policy stores only the
 * depositor and payment method a dispute needs, and whether the lock is a deferred payout. Canonical USDC only.
 */
contract DisputeProtectionPolicyV2 is IDisputeProtectionPolicyV2, Ownable2Step, ReentrancyGuard {
    /* ============ Constants ============ */

    uint64 public constant MAX_DISPUTE_WINDOW = 180 days;

    /* ============ State Variables ============ */

    /// @notice Stake custody and lock accounting controlled by this policy.
    IStakeVaultV2 public immutable override stakeVault;

    /// @notice Dedicated replay registry for payment-method-scoped dispute nullifiers.
    INullifierRegistry public immutable disputeNullifierRegistry;

    /// @notice Orchestrators allowed to call the settlement callbacks.
    IOrchestratorRegistry public immutable orchestratorRegistry;

    /// @notice Verifier used to validate signed dispute evidence.
    IDisputeVerifier public disputeVerifier;

    /// @dev Open protections keyed by globally unique intent hash; deleted on release or dispute.
    mapping(bytes32 => Protection) internal protections;

    /* ============ Constructor ============ */

    /**
     * @notice Creates the policy; authorize it as a vault controller and a dispute-nullifier writer before use.
     * @param _owner Governance owner for policy and dependency configuration.
     * @param _stakeVault Vault holding and locking taker collateral.
     * @param _disputeVerifier Verifier for signed dispute evidence.
     * @param _disputeNullifierRegistry Dedicated registry that rejects reused dispute nullifiers.
     * @param _orchestratorRegistry Registry of orchestrators allowed to call the settlement callbacks.
     */
    constructor(
        address _owner,
        IStakeVaultV2 _stakeVault,
        IDisputeVerifier _disputeVerifier,
        INullifierRegistry _disputeNullifierRegistry,
        IOrchestratorRegistry _orchestratorRegistry
    ) {
        if (_owner == address(0)) revert ZeroAddress();
        stakeVault = _stakeVault;
        disputeVerifier = _disputeVerifier;
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
        protections[_context.intentHash] = Protection({
            depositor: _context.depositor, deferredPayout: !staked, paymentMethod: _context.paymentMethod
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

    /**
     * @notice Releases every listed protection whose lock has matured. A taker's stake returns to its owner's free
     * stake; a deferred payout is transferred to its recipient, so recipients that cannot call the vault still get paid.
     * @param _intentHashes Protected intents to release.
     */
    function release(bytes32[] calldata _intentHashes) external nonReentrant {
        for (uint256 i = 0; i < _intentHashes.length; i++) {
            _release(_intentHashes[i]);
        }
    }

    /**
     * @notice Resolves valid dispute evidence into an immediately claimable depositor award.
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
        Protection memory protection = protections[_intentHash];
        if (protection.depositor == address(0)) revert ProtectionNotFound(_intentHash);

        (,, uint64 maturesAt) = stakeVault.locks(_intentHash);
        if (block.timestamp < maturesAt) revert NotMatured(maturesAt, uint64(block.timestamp));

        delete protections[_intentHash];
        if (protection.deferredPayout) {
            stakeVault.payOutLock(_intentHash);
        } else {
            stakeVault.unlockStake(_intentHash);
        }
        emit ProtectionReleased(_intentHash);
    }

    function _maturity(uint64 _window) internal view returns (uint64) {
        return uint64(block.timestamp) + _window;
    }
}

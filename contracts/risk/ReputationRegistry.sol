// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import { IIdentityRegistry } from "../interfaces/IIdentityRegistry.sol";
import { IReputationRegistry } from "../interfaces/IReputationRegistry.sol";

/**
 * @title ReputationRegistry
 * @notice A bounded, sybil-resistant interaction graph for protocol reputation.
 * @dev Reputation is intentionally O(1) to update. Each pair of verified identities forms an edge.
 *      Only increases in sqrt(cumulative pair volume) earn graph points, which gives diminishing
 *      returns to repeated self-dealing between the same two nodes. Reputable counterparties add
 *      more weight, without requiring an unbounded graph traversal.
 */
contract ReputationRegistry is Ownable, IReputationRegistry {
    using SafeCast for uint256;

    uint256 private constant MAX_BASE_PENALTY = 1_000_000;
    uint256 private constant MAX_SCORE_MULTIPLIER_BPS_PER_POINT = 10_000;
    struct Edge {
        uint256 cumulativeVolume;
        uint256 weight;
        uint64 successfulInteractions;
        uint64 lastInteractionAt;
    }

    IIdentityRegistry public immutable identityRegistry;
    mapping(address => bool) public authorizedUpdaters;
    mapping(address => Profile) private profiles;
    mapping(bytes32 => Edge) public edges;

    uint256 public pointUnit = 1e6; // One USDC when collateral uses six decimals.
    uint256 public maxEdgeWeight = 100;
    uint256 public baseAbandonmentPenalty = 10;
    uint256 public baseChargebackPenalty = 100;
    uint256 public scoreMultiplierBpsPerPoint = 10;
    uint256 public maxCounterpartyMultiplierBps = 20_000;

    event AuthorizedUpdaterUpdated(address indexed updater, bool authorized);
    event ReputationConfigUpdated(
        uint256 pointUnit,
        uint256 maxEdgeWeight,
        uint256 baseAbandonmentPenalty,
        uint256 baseChargebackPenalty,
        uint256 scoreMultiplierBpsPerPoint,
        uint256 maxCounterpartyMultiplierBps
    );
    event ReputationChanged(address indexed account, int256 delta, int256 newScore, bytes32 indexed reason);
    event EdgeUpdated(
        bytes32 indexed edgeKey,
        bytes32 indexed firstNode,
        bytes32 indexed secondNode,
        uint256 cumulativeVolume,
        uint256 weight,
        uint256 weightDelta
    );

    error ZeroAddress();
    error UnauthorizedUpdater(address caller);
    error InvalidConfig();
    error InvalidInteraction(address taker, address maker);

    modifier onlyUpdater() {
        if (!authorizedUpdaters[msg.sender]) revert UnauthorizedUpdater(msg.sender);
        _;
    }

    constructor(address owner_, address identityRegistry_) {
        if (owner_ == address(0) || identityRegistry_ == address(0)) revert ZeroAddress();
        identityRegistry = IIdentityRegistry(identityRegistry_);
        transferOwnership(owner_);
    }

    function setAuthorizedUpdater(address updater, bool authorized) external onlyOwner {
        if (updater == address(0)) revert ZeroAddress();
        authorizedUpdaters[updater] = authorized;
        emit AuthorizedUpdaterUpdated(updater, authorized);
    }

    /** @notice Updates transparent scoring constants. Existing scores and edges are never rewritten. */
    function setReputationConfig(
        uint256 pointUnit_,
        uint256 maxEdgeWeight_,
        uint256 baseAbandonmentPenalty_,
        uint256 baseChargebackPenalty_,
        uint256 scoreMultiplierBpsPerPoint_,
        uint256 maxCounterpartyMultiplierBps_
    ) external onlyOwner {
        if (
            pointUnit_ == 0
                || maxEdgeWeight_ == 0
                || maxEdgeWeight_ > 1_000_000
                || baseAbandonmentPenalty_ == 0
                || baseAbandonmentPenalty_ > MAX_BASE_PENALTY
                || baseChargebackPenalty_ == 0
                || baseChargebackPenalty_ > MAX_BASE_PENALTY
                || scoreMultiplierBpsPerPoint_ == 0
                || scoreMultiplierBpsPerPoint_ > MAX_SCORE_MULTIPLIER_BPS_PER_POINT
                || maxCounterpartyMultiplierBps_ < 10_000
                || maxCounterpartyMultiplierBps_ > 50_000
        ) revert InvalidConfig();

        pointUnit = pointUnit_;
        maxEdgeWeight = maxEdgeWeight_;
        baseAbandonmentPenalty = baseAbandonmentPenalty_;
        baseChargebackPenalty = baseChargebackPenalty_;
        scoreMultiplierBpsPerPoint = scoreMultiplierBpsPerPoint_;
        maxCounterpartyMultiplierBps = maxCounterpartyMultiplierBps_;

        emit ReputationConfigUpdated(
            pointUnit_,
            maxEdgeWeight_,
            baseAbandonmentPenalty_,
            baseChargebackPenalty_,
            scoreMultiplierBpsPerPoint_,
            maxCounterpartyMultiplierBps_
        );
    }

    function getProfile(address account) external view override returns (Profile memory) {
        return profiles[account];
    }

    function getScore(address account) external view override returns (int256) {
        return profiles[account].score;
    }

    /**
     * @notice Records a successful interaction and updates the bounded identity graph.
     * @dev Only a verified, distinct identity pair can earn the bounded graph-weight increment.
     *      There is no flat per-fill reward, so repeating a saturated edge earns zero points.
     */
    function recordSuccess(address taker, address maker, uint256 amount) external override onlyUpdater {
        if (taker == maker) revert InvalidInteraction(taker, maker);
        uint256 takerReward;
        uint256 makerReward;
        bytes32 takerNode = identityRegistry.getAccountNode(taker);
        bytes32 makerNode = identityRegistry.getAccountNode(maker);

        if (takerNode != bytes32(0) && makerNode != bytes32(0) && takerNode != makerNode) {
            (bytes32 firstNode, bytes32 secondNode) = takerNode < makerNode
                ? (takerNode, makerNode)
                : (makerNode, takerNode);
            bytes32 edgeKey = keccak256(abi.encode(firstNode, secondNode));
            Edge storage edge = edges[edgeKey];
            edge.cumulativeVolume += amount;

            uint256 newWeight = Math.min(Math.sqrt(edge.cumulativeVolume / pointUnit), maxEdgeWeight);
            uint256 weightDelta = newWeight > edge.weight ? newWeight - edge.weight : 0;
            edge.weight = newWeight;
            edge.successfulInteractions += 1;
            edge.lastInteractionAt = uint64(block.timestamp);

            takerReward += (weightDelta * _counterpartyMultiplierBps(maker)) / 10_000;
            makerReward += (weightDelta * _counterpartyMultiplierBps(taker)) / 10_000;

            emit EdgeUpdated(
                edgeKey,
                firstNode,
                secondNode,
                edge.cumulativeVolume,
                edge.weight,
                weightDelta
            );
        }

        Profile storage takerProfile = profiles[taker];
        takerProfile.successfulVolume += amount;
        takerProfile.successfulInteractions += 1;
        if (takerReward > 0) _applyDelta(taker, takerReward.toInt256(), keccak256("SUCCESS"));

        Profile storage makerProfile = profiles[maker];
        makerProfile.successfulVolume += amount;
        makerProfile.successfulInteractions += 1;
        if (makerReward > 0) _applyDelta(maker, makerReward.toInt256(), keccak256("SUCCESS"));
    }

    /** @notice Records a cancelled or expired lock as negative behavior. */
    function recordAbandonment(address taker, uint256 amount, bool expired) external override onlyUpdater {
        uint256 volumePenalty = Math.min(Math.sqrt(amount / pointUnit), maxEdgeWeight);
        uint256 penalty = baseAbandonmentPenalty + volumePenalty;
        if (expired) penalty += baseAbandonmentPenalty;

        profiles[taker].abandonedIntents += 1;
        _applyDelta(taker, -penalty.toInt256(), expired ? keccak256("EXPIRED") : keccak256("CANCELLED"));
    }

    /** @notice Records a proven chargeback as a high-severity negative event. */
    function recordChargeback(address taker, uint256 previousAmount, uint256 newCumulativeAmount)
        external
        override
        onlyUpdater
    {
        if (newCumulativeAmount <= previousAmount) revert InvalidConfig();
        uint256 previousWeight = Math.min(Math.sqrt(previousAmount / pointUnit), maxEdgeWeight);
        uint256 newWeight = Math.min(Math.sqrt(newCumulativeAmount / pointUnit), maxEdgeWeight);
        uint256 penalty = newWeight - previousWeight;
        if (previousAmount == 0) {
            penalty += baseChargebackPenalty;
            profiles[taker].chargebacks += 1;
        }
        _applyDelta(taker, -penalty.toInt256(), keccak256("CHARGEBACK"));
    }

    function _counterpartyMultiplierBps(address account) internal view returns (uint256) {
        int256 score = profiles[account].score;
        if (score <= 0) return 10_000;

        uint256 positiveScore = uint256(score);
        uint256 maximumExtraBps = maxCounterpartyMultiplierBps - 10_000;
        if (positiveScore >= maximumExtraBps / scoreMultiplierBpsPerPoint) {
            return maxCounterpartyMultiplierBps;
        }
        return 10_000 + (positiveScore * scoreMultiplierBpsPerPoint);
    }

    function _applyDelta(address account, int256 delta, bytes32 reason) internal {
        profiles[account].score += delta;
        emit ReputationChanged(account, delta, profiles[account].score, reason);
    }
}

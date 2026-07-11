// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title IStakeVault
 * @notice USDC collateral vault used for intent bonds and chargeback exposure.
 * @dev Maker compensation is credited internally and withdrawn with `withdraw`, never pushed.
 */
interface IStakeVault {
    struct MaturitySchedule {
        uint32 cliffSeconds;
        uint32 stepTwoSeconds;
        uint32 finalMaturitySeconds;
        uint16 retentionBpsAfterCliff;
        uint16 retentionBpsAfterStepTwo;
    }

    function stakeToken() external view returns (IERC20);
    function openChargebackClaims(address account) external view returns (uint256);
    function reputationHolds(address account) external view returns (uint256);
    function hasReputationHold(bytes32 intentHash) external view returns (bool);
    function hasOpenChargebackClaim(bytes32 intentHash) external view returns (bool);

    function reserve(
        bytes32 intentHash,
        address taker,
        address maker,
        bytes32 paymentMethod,
        uint256 bondAmount,
        uint256 riskAmount
    ) external;

    function activate(
        bytes32 intentHash,
        uint256 activatedRiskAmount,
        MaturitySchedule calldata schedule
    ) external;

    function abandon(bytes32 intentHash, uint16 bondSlashBps) external returns (uint256 slashedBond);
    function resolveChargeback(bytes32 intentHash, uint256 amount, bool finalClaim)
        external
        returns (uint256 paidToMaker);
    function clearReputationHold(bytes32 intentHash) external;
    function closeChargebackClaim(bytes32 intentHash) external;
}

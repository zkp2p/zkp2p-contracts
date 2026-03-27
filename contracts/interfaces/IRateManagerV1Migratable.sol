// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

/**
 * @title IRateManagerV1Migratable
 * @notice Minimal read surface required to copy existing RateManagerV1 configs into RateManagerV2.
 */
interface IRateManagerV1Migratable {
    struct RateManagerConfig {
        address manager;
        address feeRecipient;
        uint256 maxFee;
        uint256 fee;
        uint256 minLiquidity;
        string name;
        string uri;
    }

    function isRateManager(bytes32 _rateManagerId) external view returns (bool exists);

    function getRateManager(bytes32 _rateManagerId) external view returns (RateManagerConfig memory config);

    function getManagerRate(
        bytes32 _rateManagerId,
        bytes32 _paymentMethod,
        bytes32 _currencyCode
    ) external view returns (uint256 rate);
}

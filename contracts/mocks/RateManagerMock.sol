// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IRateManager } from "../interfaces/IRateManager.sol";

/**
 * @title RateManagerMock
 * @notice Test helper contract implementing `IRateManager` for EscrowV2 delegation tests.
 */
contract RateManagerMock is IRateManager {
    error OptInRejected();
    error GetRateRejected();
    error GetFeeRejected();
    error RateManagerNotFound(bytes32 rateManagerId);
    struct FeeConfig {
        address recipient;
        uint256 fee;
    }

    mapping(bytes32 => bool) internal managers;
    mapping(bytes32 => FeeConfig) internal feeConfigs;
    mapping(bytes32 => uint256) internal tupleRates;

    bool public shouldRevertOnOptIn;
    bool public shouldRevertOnGetRate;
    bool public shouldRevertOnGetFee;

    event OptedIn(address indexed escrow, uint256 indexed depositId, bytes32 rateManagerId);

    function setManager(bytes32 _rateManagerId, bool _exists) external {
        managers[_rateManagerId] = _exists;
    }

    function setFee(bytes32 _rateManagerId, address _recipient, uint256 _fee) external {
        feeConfigs[_rateManagerId] = FeeConfig({recipient: _recipient, fee: _fee});
    }

    function setRate(
        bytes32 _rateManagerId,
        address _escrow,
        uint256 _depositId,
        bytes32 _paymentMethod,
        bytes32 _currencyCode,
        uint256 _rate
    ) external {
        tupleRates[_tupleKey(_rateManagerId, _escrow, _depositId, _paymentMethod, _currencyCode)] = _rate;
    }

    function setShouldRevertOnOptIn(bool _shouldRevert) external {
        shouldRevertOnOptIn = _shouldRevert;
    }

    function setShouldRevertOnGetRate(bool _shouldRevert) external {
        shouldRevertOnGetRate = _shouldRevert;
    }

    function setShouldRevertOnGetFee(bool _shouldRevert) external {
        shouldRevertOnGetFee = _shouldRevert;
    }

    function getRate(
        bytes32 _rateManagerId,
        address _escrow,
        uint256 _depositId,
        bytes32 _paymentMethod,
        bytes32 _currencyCode
    ) external view override returns (uint256 rate) {
        if (shouldRevertOnGetRate) revert GetRateRejected();
        return tupleRates[_tupleKey(_rateManagerId, _escrow, _depositId, _paymentMethod, _currencyCode)];
    }

    function getFee(bytes32 _rateManagerId) external view override returns (address recipient, uint256 fee) {
        if (shouldRevertOnGetFee) revert GetFeeRejected();
        FeeConfig memory cfg = feeConfigs[_rateManagerId];
        return (cfg.recipient, cfg.fee);
    }

    function isRateManager(bytes32 _rateManagerId) external view override returns (bool exists) {
        return managers[_rateManagerId];
    }

    function onDepositOptIn(
        uint256 _depositId,
        bytes32 _rateManagerId
    ) external override {
        if (!managers[_rateManagerId]) revert RateManagerNotFound(_rateManagerId);
        if (shouldRevertOnOptIn) revert OptInRejected();
        emit OptedIn(msg.sender, _depositId, _rateManagerId);
    }

    function _tupleKey(
        bytes32 _rateManagerId,
        address _escrow,
        uint256 _depositId,
        bytes32 _paymentMethod,
        bytes32 _currencyCode
    ) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(_rateManagerId, _escrow, _depositId, _paymentMethod, _currencyCode));
    }
}

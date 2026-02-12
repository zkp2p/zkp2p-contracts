// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { IBaseRateManagerRegistry } from "../interfaces/IBaseRateManagerRegistry.sol";

contract DepositRateManagerRegistryBypassMock is IBaseRateManagerRegistry {
    bytes32 public id;
    address public feeRecipient_;
    uint256 public fee_;
    uint256 public managerMinRate_;

    constructor(bytes32 _id, address _recipient, uint256 _fee, uint256 _minRate) {
        id = _id;
        feeRecipient_ = _recipient;
        fee_ = _fee;
        managerMinRate_ = _minRate;
    }

    // Reads used by Escrow/Orchestrator in tests
    function isRateManager(bytes32 _id) external view returns (bool) {
        return _id == id;
    }

    function getFeeAndRecipient(bytes32) external view returns (uint256 fee, address feeRecipient) {
        return (fee_, feeRecipient_);
    }

    function getDepositHook(bytes32) external pure returns (address) {
        return address(0);
    }

    function getMinRate(bytes32, bytes32, bytes32) external view returns (uint256) {
        return managerMinRate_;
    }

    // Unused interface methods in tests
    function createRateManager(RateManagerConfig calldata) external pure returns (bytes32) {
        revert("unused");
    }

    function setRateManagerConfig(bytes32, address, address, address, string calldata, string calldata) external pure {
        revert("unused");
    }

    function setFee(bytes32, uint256) external pure {
        revert("unused");
    }

    function setMinRate(bytes32, bytes32, bytes32, uint256) external pure {
        revert("unused");
    }

    function setMinRatesBatch(bytes32, bytes32[] calldata, bytes32[][] calldata, uint256[][] calldata) external pure {
        revert("unused");
    }

    function getRateManager(bytes32) external pure returns (RateManagerConfig memory) {
        revert("unused");
    }
}

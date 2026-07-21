// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { EscrowDepositReceiver } from "./EscrowDepositReceiver.sol";
import { IEscrowV2 } from "../interfaces/IEscrowV2.sol";

/**
 * @title EscrowDepositReceiverFactory
 * @notice Deploys deterministic per-order EscrowDepositReceiver instances with CREATE2.
 */
contract EscrowDepositReceiverFactory {
    /* ============ Structs ============ */

    struct Order {
        IERC20 token;
        IEscrowV2 escrow;
        address depositor;
        uint256 amount;
        bytes32 depositParamsHash;
        uint64 expiry;
    }

    /* ============ Events ============ */

    event ReceiverDeployed(
        address indexed receiver,
        address indexed depositor,
        bytes32 indexed userSalt,
        address token,
        address escrow,
        uint256 amount,
        bytes32 depositParamsHash,
        uint64 expiry
    );

    /* ============ External Functions ============ */

    /**
     * @notice Deploys the receiver bound to `_order` at its deterministic address.
     * @dev Deployment remains permissionless after expiry so an undeployed predicted address can
     *      still be instantiated and its funds recovered by the depositor.
     */
    function deployReceiver(Order calldata _order, bytes32 _userSalt) external returns (address receiver) {
        bytes32 deploymentSalt = computeDeploymentSalt(_order, _userSalt);
        receiver = address(new EscrowDepositReceiver{ salt: deploymentSalt }(
            _order.token,
            _order.escrow,
            _order.depositor,
            _order.amount,
            _order.depositParamsHash,
            _order.expiry
        ));

        emit ReceiverDeployed(
            receiver,
            _order.depositor,
            _userSalt,
            address(_order.token),
            address(_order.escrow),
            _order.amount,
            _order.depositParamsHash,
            _order.expiry
        );
    }

    /**
     * @notice Computes the receiver address without deploying it.
     */
    function predictReceiverAddress(Order calldata _order, bytes32 _userSalt) external view returns (address) {
        bytes32 deploymentSalt = computeDeploymentSalt(_order, _userSalt);
        bytes32 initCodeHash = keccak256(abi.encodePacked(
            type(EscrowDepositReceiver).creationCode,
            abi.encode(
                _order.token,
                _order.escrow,
                _order.depositor,
                _order.amount,
                _order.depositParamsHash,
                _order.expiry
            )
        ));

        return address(uint160(uint256(keccak256(abi.encodePacked(
            bytes1(0xff),
            address(this),
            deploymentSalt,
            initCodeHash
        )))));
    }

    /**
     * @notice Returns the canonical commitment for a complete EscrowV2 deposit request.
     */
    function hashDepositParams(IEscrowV2.CreateDepositParams calldata _params) external pure returns (bytes32) {
        return keccak256(abi.encode(_params));
    }

    /**
     * @notice Derives a collision-resistant CREATE2 salt from every immutable and a caller salt.
     */
    function computeDeploymentSalt(Order calldata _order, bytes32 _userSalt) public pure returns (bytes32) {
        return keccak256(abi.encode(
            _userSalt,
            _order.token,
            _order.escrow,
            _order.depositor,
            _order.amount,
            _order.depositParamsHash,
            _order.expiry
        ));
    }
}

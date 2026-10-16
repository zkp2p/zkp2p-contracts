// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IEscrowV2} from "contracts/interfaces/IEscrowV2.sol";

contract EscrowDepositStub {
    IEscrowV2.Deposit internal deposit;

    constructor(address _depositor, IERC20 _token) {
        deposit.depositor = _depositor;
        deposit.token = _token;
    }

    /// @notice Configures the deposit returned by this stub.
    function setDeposit(address _depositor, IERC20 _token) external {
        deposit.depositor = _depositor;
        deposit.token = _token;
    }

    /// @notice Returns the complete configured deposit.
    function getDeposit(uint256) external view returns (IEscrowV2.Deposit memory) {
        return deposit;
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {ISanctionsList} from "contracts/interfaces/ISanctionsList.sol";

contract SanctionsListMock is ISanctionsList {
    mapping(address => bool) public override isSanctioned;

    function setSanctioned(address account, bool sanctioned) external {
        isSanctioned[account] = sanctioned;
    }
}

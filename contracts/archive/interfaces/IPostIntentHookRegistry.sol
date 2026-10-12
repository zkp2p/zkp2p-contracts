//SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

interface IPostIntentHookRegistry {
    function isWhitelistedHook(address _hook) external view returns (bool);
    function getWhitelistedHooks() external view returns (address[] memory);
}

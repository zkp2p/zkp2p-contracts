//SPDX-License-Identifier: MIT

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { AddressArrayUtils } from "../../external/AddressArrayUtils.sol";
import { IPostIntentHookRegistry } from "../interfaces/IPostIntentHookRegistry.sol";

pragma solidity ^0.8.18;


contract PostIntentHookRegistry is Ownable, IPostIntentHookRegistry {

    using AddressArrayUtils for address[];
    
    /* ============ Events ============ */
    event PostIntentHookAdded(address indexed hook);
    event PostIntentHookRemoved(address indexed hook);

    /* ============ State Variables ============ */
    mapping(address => bool) public whitelistedHooks;
    address[] public hooks;

    /* ============ Constructor ============ */
    constructor() Ownable() {}
    
    /* ============ External Functions ============ */

    /**
     * ONLY OWNER: Adds a post intent hook to the whitelist.
     *
     * @param _hook   The post intent hook address to add
     */
    function addPostIntentHook(address _hook) external onlyOwner {
        require(_hook != address(0), "Hook cannot be zero address");
        require(!whitelistedHooks[_hook], "Hook already whitelisted");
        
        whitelistedHooks[_hook] = true;
        hooks.push(_hook);
        
        emit PostIntentHookAdded(_hook);
    }

    /**
     * ONLY OWNER: Removes a post intent hook from the whitelist.
     *
     * @param _hook   The post intent hook address to remove
     */
    function removePostIntentHook(address _hook) external onlyOwner {
        require(whitelistedHooks[_hook], "Hook not whitelisted");
        
        whitelistedHooks[_hook] = false;
        hooks.removeStorage(_hook);
        
        emit PostIntentHookRemoved(_hook);
    }

    /* ============ External View Functions ============ */

    function isWhitelistedHook(address _hook) external view returns (bool) {
        return whitelistedHooks[_hook];
    }

    function getWhitelistedHooks() external view returns (address[] memory) {
        return hooks;
    }
} 
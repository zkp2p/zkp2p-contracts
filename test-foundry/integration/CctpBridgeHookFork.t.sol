// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import "forge-std/Test.sol";

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { CctpBridgeHook } from "contracts/hooks/CctpBridgeHook.sol";
import { IOrchestrator } from "contracts/interfaces/IOrchestrator.sol";
import { IPostIntentHook } from "contracts/interfaces/IPostIntentHook.sol";

contract CctpBridgeHookForkTest is Test {
    address internal constant USDC_BASE_SEPOLIA = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    address internal constant TOKEN_MESSENGER_BASE_SEPOLIA = 0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA;
    address internal constant MESSAGE_TRANSMITTER_BASE_SEPOLIA = 0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275;
    uint32 internal constant SOURCE_DOMAIN_BASE_SEPOLIA = 6;

    uint256 internal forkId;

    function setUp() public {
        string memory rpcUrl = vm.envOr("BASE_SEPOLIA_RPC_URL", string(""));
        if (bytes(rpcUrl).length == 0) {
            emit log("BASE_SEPOLIA_RPC_URL not set; skipping fork test.");
            vm.skip(true);
        }

        forkId = vm.createFork(rpcUrl);
        vm.selectFork(forkId);
    }

    function testExecuteAgainstLiveTokenMessenger() public {
        uint256 amount = 10 * 1e6; // 10 USDC

        vm.deal(address(this), 1 ether);
        deal(USDC_BASE_SEPOLIA, address(this), amount);

        CctpBridgeHook hook = new CctpBridgeHook(
            USDC_BASE_SEPOLIA,
            address(this),
            TOKEN_MESSENGER_BASE_SEPOLIA,
            SOURCE_DOMAIN_BASE_SEPOLIA
        );

        CctpBridgeHook.CctpBridgeCommitment memory commitment = CctpBridgeHook.CctpBridgeCommitment({
            destinationDomain: 26, // Arc Testnet
            mintRecipient: bytes32(uint256(uint160(address(this)))),
            destinationCaller: bytes32(0),
            minFinalityThreshold: 1000
        });

        CctpBridgeHook.CctpFulfillData memory fulfillData = CctpBridgeHook.CctpFulfillData({
            intentHash: keccak256("cctp-fork-test")
        });

        IOrchestrator.Intent memory intent = IOrchestrator.Intent({
            owner: address(this),
            to: address(this),
            escrow: address(this),
            depositId: 1,
            amount: amount,
            timestamp: block.timestamp,
            paymentMethod: bytes32(0),
            fiatCurrency: bytes32(0),
            conversionRate: 1e18,
            payeeId: bytes32(0),
            referrer: address(0),
            referrerFee: 0,
            postIntentHook: IPostIntentHook(address(hook)),
            data: abi.encode(commitment)
        });

        IERC20(USDC_BASE_SEPOLIA).approve(address(hook), amount);

        vm.recordLogs();
        hook.execute(intent, amount, abi.encode(fulfillData));
        Vm.Log[] memory entries = vm.getRecordedLogs();

        uint256 orchestratorBalance = IERC20(USDC_BASE_SEPOLIA).balanceOf(address(this));
        uint256 hookBalance = IERC20(USDC_BASE_SEPOLIA).balanceOf(address(hook));

        assertEq(orchestratorBalance, 0, "USDC should be consumed by burn");
        assertEq(hookBalance, 0, "Hook should not retain USDC");

        bool sawCctpLog = false;
        for (uint256 i = 0; i < entries.length; i++) {
            address emitter = entries[i].emitter;
            if (emitter == TOKEN_MESSENGER_BASE_SEPOLIA || emitter == MESSAGE_TRANSMITTER_BASE_SEPOLIA) {
                sawCctpLog = true;
                break;
            }
        }

        assertTrue(sawCctpLog, "Expected CCTP TokenMessenger/MessageTransmitter log");
    }
}

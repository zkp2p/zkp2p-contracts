// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { AcrossBridgeHook } from "contracts/hooks/AcrossBridgeHook.sol";
import { IOrchestrator } from "contracts/interfaces/IOrchestrator.sol";
import { IPostIntentHook } from "contracts/interfaces/IPostIntentHook.sol";

contract AcrossBridgeHookForkTest is Test {
    address internal constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant BASE_SPOKE_POOL = 0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64;
    address internal constant DEST_USDC_MAINNET = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;

    uint256 internal constant DEST_CHAIN_ID = 1;
    uint256 internal constant INPUT_AMOUNT = 10_000_000; // 10 USDC (6 decimals)
    uint256 internal constant OUTPUT_AMOUNT = 9_900_000; // 9.9 USDC (generous relay fee)
    uint256 internal constant MIN_OUTPUT = 9_900_000; // 9.9 USDC

    AcrossBridgeHook internal hook;

    function setUp() public {
        string memory rpcUrl = _getRpcUrl();
        vm.createSelectFork(rpcUrl);

        hook = new AcrossBridgeHook(BASE_USDC, address(this), BASE_SPOKE_POOL);
        _fundUsdc(INPUT_AMOUNT);
        IERC20(BASE_USDC).approve(address(hook), INPUT_AMOUNT);
    }

    function testFork_DepositNow_BaseToMainnetUSDC() public {
        address recipient = makeAddr("destinationRecipient");

        AcrossBridgeHook.BridgeCommitment memory commitment = AcrossBridgeHook.BridgeCommitment({
            destinationChainId: DEST_CHAIN_ID,
            outputToken: _toBytes32(DEST_USDC_MAINNET),
            recipient: _toBytes32(recipient),
            minOutputAmount: MIN_OUTPUT
        });
        bytes memory commitmentData = abi.encode(commitment);

        IOrchestrator.Intent memory intent = IOrchestrator.Intent({
            owner: address(this),
            to: recipient,
            escrow: address(0),
            depositId: 0,
            amount: INPUT_AMOUNT,
            timestamp: block.timestamp,
            paymentMethod: bytes32(0),
            fiatCurrency: bytes32(0),
            conversionRate: 0,
            payeeId: bytes32(0),
            referrer: address(0),
            referrerFee: 0,
            postIntentHook: IPostIntentHook(address(hook)),
            data: commitmentData
        });

        AcrossBridgeHook.AcrossFulfillData memory fulfill = AcrossBridgeHook.AcrossFulfillData({
            intentHash: keccak256("across-intent"),
            outputAmount: OUTPUT_AMOUNT,
            fillDeadlineOffset: 3600,
            exclusiveRelayer: bytes32(0),
            exclusivityParameter: 0
        });
        bytes memory fulfillData = abi.encode(fulfill);

        uint256 spokeBalanceBefore = IERC20(BASE_USDC).balanceOf(BASE_SPOKE_POOL);
        uint256 recipientBalanceBefore = IERC20(BASE_USDC).balanceOf(recipient);

        hook.execute(intent, INPUT_AMOUNT, fulfillData);

        uint256 spokeBalanceAfter = IERC20(BASE_USDC).balanceOf(BASE_SPOKE_POOL);
        uint256 hookBalance = IERC20(BASE_USDC).balanceOf(address(hook));
        uint256 recipientBalanceAfter = IERC20(BASE_USDC).balanceOf(recipient);

        assertEq(spokeBalanceAfter - spokeBalanceBefore, INPUT_AMOUNT, "spoke pool should receive input amount");
        assertEq(hookBalance, 0, "hook should not retain funds");
        assertEq(recipientBalanceAfter - recipientBalanceBefore, 0, "no fallback transfer expected");
    }

    function _fundUsdc(uint256 amount) internal {
        deal(BASE_USDC, address(this), amount);
        if (IERC20(BASE_USDC).balanceOf(address(this)) < amount) {
            (address whale, bool ok) = _tryEnvAddress("BASE_USDC_WHALE");
            require(ok && whale != address(0), "BASE_USDC_WHALE env var required if deal() fails");
            vm.deal(whale, 1 ether);
            vm.startPrank(whale);
            IERC20(BASE_USDC).transfer(address(this), amount);
            vm.stopPrank();
        }
    }

    function _getRpcUrl() internal view returns (string memory) {
        (string memory apiKey, bool ok) = _tryEnvString("ALCHEMY_API_KEY");
        if (ok && bytes(apiKey).length > 0) {
            return string(abi.encodePacked("https://base-mainnet.g.alchemy.com/v2/", apiKey));
        }
        (string memory rpcUrl, bool hasUrl) = _tryEnvString("BASE_RPC_URL");
        require(hasUrl && bytes(rpcUrl).length > 0, "Set ALCHEMY_API_KEY or BASE_RPC_URL");
        return rpcUrl;
    }

    function _tryEnvString(string memory key) internal view returns (string memory, bool) {
        try vm.envString(key) returns (string memory value) {
            return (value, true);
        } catch {
            return ("", false);
        }
    }

    function _tryEnvAddress(string memory key) internal view returns (address, bool) {
        try vm.envAddress(key) returns (address value) {
            return (value, true);
        } catch {
            return (address(0), false);
        }
    }

    function _toBytes32(address addr) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(addr)));
    }
}

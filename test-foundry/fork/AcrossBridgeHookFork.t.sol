// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { AcrossBridgeHook } from "contracts/hooks/AcrossBridgeHook.sol";
import { IOrchestrator } from "contracts/interfaces/IOrchestrator.sol";
import { IPostIntentHook } from "contracts/interfaces/IPostIntentHook.sol";

contract AcrossBridgeHookForkTest is Test {
    event AcrossBridgeInitiated(
        bytes32 indexed intentHash,
        uint256 destinationChainId,
        bytes32 outputToken,
        bytes32 recipient,
        uint256 inputAmount,
        uint256 outputAmount,
        uint32 fillDeadlineOffset,
        bytes32 exclusiveRelayer,
        uint32 exclusivityParameter
    );

    event FallbackTransfer(
        bytes32 indexed intentHash,
        address indexed recipient,
        uint256 amount,
        uint8 reason
    );

    address internal constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant BASE_SPOKE_POOL = 0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64;
    address internal constant DEST_USDC_MAINNET = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;

    uint256 internal constant SOLANA_CHAIN_ID = 34268394551451;
    string internal constant SOLANA_USDC_MINT_B58 = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    string internal constant SOLANA_RECIPIENT_B58 = "GsiZqCTNRi4T3qZrixFdmhXVeA4CSUzS7c44EQ7Rw1Tw";
    bytes32 internal constant SOLANA_USDC_MINT_BYTES32 =
        0xc6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d61;
    bytes32 internal constant SOLANA_RECIPIENT_BYTES32 =
        0xebdd57de24abd825270163faedaedbe3ae924bdfc22f3c91c2a7bd649fdb7b0a;

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

        uint256 poolDelta = spokeBalanceAfter - spokeBalanceBefore;
        uint256 recipientDelta = recipientBalanceAfter - recipientBalanceBefore;
        assertEq(hookBalance, 0, "hook should not retain funds");
        assertTrue(
            (poolDelta == INPUT_AMOUNT && recipientDelta == 0) || (poolDelta == 0 && recipientDelta == INPUT_AMOUNT),
            "either bridged to SpokePool or fallback transfer to recipient"
        );
    }

    function testFork_DepositNow_FallbackOnBridgeFailure() public {
        address recipient = makeAddr("fallbackRecipient");

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
            intentHash: keccak256("across-fallback-intent"),
            outputAmount: OUTPUT_AMOUNT,
            fillDeadlineOffset: 3600,
            exclusiveRelayer: bytes32(0),
            exclusivityParameter: 1
        });
        bytes memory fulfillData = abi.encode(fulfill);

        uint256 spokeBalanceBefore = IERC20(BASE_USDC).balanceOf(BASE_SPOKE_POOL);
        uint256 recipientBalanceBefore = IERC20(BASE_USDC).balanceOf(recipient);

        vm.expectEmit(true, true, false, true, address(hook));
        emit FallbackTransfer(fulfill.intentHash, recipient, INPUT_AMOUNT, 1);

        hook.execute(intent, INPUT_AMOUNT, fulfillData);

        uint256 spokeBalanceAfter = IERC20(BASE_USDC).balanceOf(BASE_SPOKE_POOL);
        uint256 hookBalance = IERC20(BASE_USDC).balanceOf(address(hook));
        uint256 recipientBalanceAfter = IERC20(BASE_USDC).balanceOf(recipient);

        assertEq(spokeBalanceAfter, spokeBalanceBefore, "spoke pool should not receive funds");
        assertEq(hookBalance, 0, "hook should not retain funds");
        assertEq(recipientBalanceAfter - recipientBalanceBefore, INPUT_AMOUNT, "fallback transfer expected");
    }

    function testFork_DepositNow_SolanaRecipientBase58() public {
        address fallbackRecipient = makeAddr("solanaFallbackRecipient");

        bytes32 solanaRecipient = _base58ToBytes32(SOLANA_RECIPIENT_B58);
        bytes32 solanaUsdc = _base58ToBytes32(SOLANA_USDC_MINT_B58);
        assertEq(solanaRecipient, SOLANA_RECIPIENT_BYTES32, "solana recipient decode mismatch");
        assertEq(solanaUsdc, SOLANA_USDC_MINT_BYTES32, "solana USDC mint decode mismatch");

        AcrossBridgeHook.BridgeCommitment memory commitment = AcrossBridgeHook.BridgeCommitment({
            destinationChainId: SOLANA_CHAIN_ID,
            outputToken: solanaUsdc,
            recipient: solanaRecipient,
            minOutputAmount: MIN_OUTPUT
        });
        bytes memory commitmentData = abi.encode(commitment);

        IOrchestrator.Intent memory intent = IOrchestrator.Intent({
            owner: address(this),
            to: fallbackRecipient,
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

        bytes32 intentHash = keccak256("across-solana-intent");
        AcrossBridgeHook.AcrossFulfillData memory fulfill = AcrossBridgeHook.AcrossFulfillData({
            intentHash: intentHash,
            outputAmount: OUTPUT_AMOUNT,
            fillDeadlineOffset: 3600,
            exclusiveRelayer: bytes32(0),
            exclusivityParameter: 0
        });
        bytes memory fulfillData = abi.encode(fulfill);

        uint256 spokeBalanceBefore = IERC20(BASE_USDC).balanceOf(BASE_SPOKE_POOL);
        uint256 recipientBalanceBefore = IERC20(BASE_USDC).balanceOf(fallbackRecipient);
hook.execute(intent, INPUT_AMOUNT, fulfillData);

        uint256 spokeBalanceAfter = IERC20(BASE_USDC).balanceOf(BASE_SPOKE_POOL);
        uint256 hookBalance = IERC20(BASE_USDC).balanceOf(address(hook));
        uint256 recipientBalanceAfter = IERC20(BASE_USDC).balanceOf(fallbackRecipient);

        uint256 poolDelta = spokeBalanceAfter - spokeBalanceBefore;
        uint256 recipientDelta = recipientBalanceAfter - recipientBalanceBefore;
        assertEq(hookBalance, 0, "hook should not retain funds");
        assertTrue(
            (poolDelta == INPUT_AMOUNT && recipientDelta == 0) || (poolDelta == 0 && recipientDelta == INPUT_AMOUNT),
            "either bridged to SpokePool or fallback transfer to recipient"
        );
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

    function _base58ToBytes32(string memory input) internal pure returns (bytes32) {
        bytes memory data = bytes(input);
        bytes memory alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
        uint256 value = 0;

        for (uint256 i = 0; i < data.length; i++) {
            uint8 digit = 255;
            for (uint256 j = 0; j < alphabet.length; j++) {
                if (data[i] == alphabet[j]) {
                    digit = uint8(j);
                    break;
                }
            }
            require(digit < 58, "InvalidBase58Char");
            value = value * 58 + digit;
        }

        return bytes32(value);
    }

    function _toBytes32(address addr) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(addr)));
    }
}

// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";

import {IntentGuardian} from "../../contracts/IntentGuardian.sol";
import {EscrowRegistry} from "../../contracts/registries/EscrowRegistry.sol";
import {IEscrowRegistry} from "../../contracts/interfaces/IEscrowRegistry.sol";
import {IEscrowV2} from "../../contracts/interfaces/IEscrowV2.sol";
import {
    GuardianEscrowMock,
    GuardianTokenMock
} from "../deterministic/staking/IntentGuardian.t.sol";

contract IntentGuardianFuzzTest is Test {
    uint256 internal constant DEPOSIT_ID = 1;
    bytes32 internal constant INTENT_HASH = keccak256("fuzz-intent");
    uint256 internal constant FEE_DENOMINATOR = 36_000_000;

    address internal owner = makeAddr("owner");
    address internal depositor = makeAddr("depositor");
    address internal payer = makeAddr("payer");

    GuardianTokenMock internal token;
    GuardianEscrowMock internal escrow;
    EscrowRegistry internal escrowRegistry;
    IntentGuardian internal guardian;

    function setUp() public {
        token = new GuardianTokenMock();
        escrow = new GuardianEscrowMock();
        escrowRegistry = new EscrowRegistry();
        escrowRegistry.addEscrow(address(escrow));
        guardian = new IntentGuardian(owner, escrowRegistry);
        escrow.configureDeposit(depositor, token, address(guardian));
    }

    function testFuzz_QuoteMatchesChargedCostAndRoundsUp(
        uint96 rawAmount,
        uint32 rawAdditionalTime,
        uint8 rawFee
    ) public {
        uint256 amount = bound(uint256(rawAmount), 1, type(uint96).max);
        uint256 additionalTime = bound(uint256(rawAdditionalTime), 1, 5 days - 1 hours);
        uint256 fee = bound(uint256(rawFee), 1, 83);
        vm.prank(owner);
        guardian.setExtensionFeeBpsPerHour(fee);
        escrow.setIntent(INTENT_HASH, amount, block.timestamp, block.timestamp + 1 hours);
        token.mint(payer, amount);
        uint256 quote = guardian.quoteExtensionCost(amount, additionalTime);

        vm.prank(payer);
        token.approve(address(guardian), quote);
        vm.prank(payer);
        guardian.extendIntent(IEscrowV2(address(escrow)), DEPOSIT_ID, INTENT_HASH, additionalTime, quote);

        uint256 numerator = amount * fee * additionalTime;
        assertEq(token.balanceOf(depositor), quote);
        assertEq(token.balanceOf(payer), amount - quote);
        assertGe(quote * FEE_DENOMINATOR, numerator);
        assertLt((quote - 1) * FEE_DENOMINATOR, numerator);
    }

    function testFuzz_CostNeverExceedsIntentAmount(uint96 rawAmount, uint32 rawTime, uint8 rawFee) public {
        uint256 amount = bound(uint256(rawAmount), 1, type(uint96).max);
        uint256 additionalTime = bound(uint256(rawTime), 1, 5 days);
        uint256 fee = bound(uint256(rawFee), 1, 83);
        vm.prank(owner);
        guardian.setExtensionFeeBpsPerHour(fee);

        assertLe(guardian.quoteExtensionCost(amount, additionalTime), amount);
    }
}

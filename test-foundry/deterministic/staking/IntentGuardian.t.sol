// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IntentGuardian} from "../../../contracts/IntentGuardian.sol";
import {IEscrowV2} from "../../../contracts/interfaces/IEscrowV2.sol";
import {IIntentGuardian} from "../../../contracts/interfaces/IIntentGuardian.sol";

contract GuardianTokenMock is ERC20 {
    constructor() ERC20("Guardian Token", "GUARD") {}

    function mint(address _account, uint256 _amount) external {
        _mint(_account, _amount);
    }
}

contract GuardianEscrowMock {
    IEscrowV2.Deposit internal deposit;
    mapping(bytes32 => IEscrowV2.Intent) internal intents;

    function configureDeposit(address _depositor, IERC20 _token, address _guardian) external {
        deposit.depositor = _depositor;
        deposit.token = _token;
        deposit.intentGuardian = _guardian;
    }

    function setIntent(
        bytes32 _intentHash,
        uint256 _amount,
        uint256 _timestamp,
        uint256 _expiryTime
    ) external {
        intents[_intentHash] = IEscrowV2.Intent({
            intentHash: _intentHash,
            amount: _amount,
            timestamp: _timestamp,
            expiryTime: _expiryTime
        });
    }

    function deleteIntent(bytes32 _intentHash) external {
        delete intents[_intentHash];
    }

    function getDeposit(uint256 _depositId) external view returns (IEscrowV2.Deposit memory) {
        _depositId;
        return deposit;
    }

    function getDepositIntent(uint256 _depositId, bytes32 _intentHash)
        external
        view
        returns (IEscrowV2.Intent memory)
    {
        _depositId;
        return intents[_intentHash];
    }

    function extendIntentExpiry(uint256 _depositId, bytes32 _intentHash, uint256 _additionalTime) external {
        IEscrowV2.Deposit storage storedDeposit = deposit;
        IEscrowV2.Intent storage intent = intents[_intentHash];

        if (storedDeposit.depositor == address(0)) revert IEscrowV2.DepositNotFound(_depositId);
        if (intent.intentHash == bytes32(0)) revert IEscrowV2.IntentNotFound(_intentHash);
        if (storedDeposit.intentGuardian != msg.sender) {
            revert IEscrowV2.UnauthorizedCaller(msg.sender, storedDeposit.intentGuardian);
        }
        if (_additionalTime == 0) revert IEscrowV2.ZeroValue();
        if (intent.expiryTime + _additionalTime > intent.timestamp + 5 days) {
            revert IEscrowV2.AmountAboveMax(_additionalTime, 5 days);
        }

        intent.expiryTime += _additionalTime;
    }
}

contract IntentGuardianTest is Test {
    event IntentExtended(
        uint256 indexed depositId,
        bytes32 indexed intentHash,
        address indexed payer,
        uint256 additionalTime,
        uint256 cost
    );
    event ExtensionFeeUpdated(uint256 extensionFeeBpsPerHour);

    uint256 internal constant DEPOSIT_ID = 1;
    uint256 internal constant INTENT_AMOUNT = 1_000e6;
    bytes32 internal constant INTENT_HASH = keccak256("intent");

    address internal owner = makeAddr("owner");
    address internal depositor = makeAddr("depositor");
    address internal payer = makeAddr("payer");

    GuardianTokenMock internal token;
    GuardianEscrowMock internal escrow;
    IntentGuardian internal guardian;

    function setUp() public {
        token = new GuardianTokenMock();
        escrow = new GuardianEscrowMock();
        guardian = new IntentGuardian(owner, IEscrowV2(address(escrow)));
        escrow.configureDeposit(depositor, token, address(guardian));
        _setLiveIntent(INTENT_HASH, INTENT_AMOUNT, 1 days);
        token.mint(payer, INTENT_AMOUNT);

        vm.prank(owner);
        guardian.setExtensionFeeBpsPerHour(10);
    }

    function test_FreshDeployDisablesExtensionsWithAZeroFee() public {
        IntentGuardian freshGuardian = new IntentGuardian(owner, IEscrowV2(address(escrow)));
        assertEq(freshGuardian.extensionFeeBpsPerHour(), 0);

        vm.expectRevert(IIntentGuardian.ExtensionsDisabled.selector);
        freshGuardian.extendIntent(DEPOSIT_ID, INTENT_HASH, 1 hours, type(uint256).max);
    }

    function test_OwnerCanSetTheMaximumFeeEmitTheUpdateAndDisableExtensionsAgain() public {
        vm.prank(owner);
        vm.expectEmit(false, false, false, true, address(guardian));
        emit ExtensionFeeUpdated(83);
        guardian.setExtensionFeeBpsPerHour(83);
        assertEq(guardian.extensionFeeBpsPerHour(), 83);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IIntentGuardian.ExtensionFeeExceedsIntentAmount.selector, 84));
        guardian.setExtensionFeeBpsPerHour(84);

        vm.prank(payer);
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        guardian.setExtensionFeeBpsPerHour(1);

        vm.prank(owner);
        guardian.setExtensionFeeBpsPerHour(0);
        vm.expectRevert(IIntentGuardian.ExtensionsDisabled.selector);
        guardian.extendIntent(DEPOSIT_ID, INTENT_HASH, 1 hours, type(uint256).max);
    }

    function test_UnrelatedPayerPrepaysTheDepositorAndExtendsTheIntentImmediately() public {
        uint256 additionalTime = 2 hours;
        uint256 cost = guardian.quoteExtensionCost(INTENT_AMOUNT, additionalTime);
        uint256 expiryBefore = escrow.getDepositIntent(DEPOSIT_ID, INTENT_HASH).expiryTime;
        uint256 payerBalanceBefore = token.balanceOf(payer);
        uint256 depositorBalanceBefore = token.balanceOf(depositor);

        vm.prank(payer);
        token.approve(address(guardian), cost);
        vm.prank(payer);
        vm.expectEmit(true, true, true, true, address(guardian));
        emit IntentExtended(DEPOSIT_ID, INTENT_HASH, payer, additionalTime, cost);
        guardian.extendIntent(DEPOSIT_ID, INTENT_HASH, additionalTime, cost);

        assertEq(escrow.getDepositIntent(DEPOSIT_ID, INTENT_HASH).expiryTime, expiryBefore + additionalTime);
        assertEq(token.balanceOf(payer), payerBalanceBefore - cost);
        assertEq(token.balanceOf(depositor), depositorBalanceBefore + cost);
        assertEq(token.balanceOf(address(guardian)), 0);
    }

    function test_QuoteRoundsUpToTheNextTokenUnit() public {
        vm.prank(owner);
        guardian.setExtensionFeeBpsPerHour(1);
        assertEq(guardian.quoteExtensionCost(1, 1), 1);

        uint256 amount = 1_000_003;
        uint256 additionalTime = 333;
        uint256 numerator = amount * additionalTime;
        assertEq(guardian.quoteExtensionCost(amount, additionalTime), (numerator + 36_000_000 - 1) / 36_000_000);
    }

    function test_MaxCostProtectsAgainstFeeChangesAndAcceptsTheUpdatedQuote() public {
        uint256 additionalTime = 1 hours;
        uint256 oldQuote = guardian.quoteExtensionCost(INTENT_AMOUNT, additionalTime);
        vm.prank(owner);
        guardian.setExtensionFeeBpsPerHour(20);
        uint256 newCost = guardian.quoteExtensionCost(INTENT_AMOUNT, additionalTime);

        vm.prank(payer);
        token.approve(address(guardian), newCost);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(IIntentGuardian.ExtensionCostExceedsMax.selector, newCost, oldQuote));
        guardian.extendIntent(DEPOSIT_ID, INTENT_HASH, additionalTime, oldQuote);

        vm.prank(payer);
        guardian.extendIntent(DEPOSIT_ID, INTENT_HASH, additionalTime, newCost);
    }

    function test_ExpiredAndUnknownIntentsCannotBeExtended() public {
        uint256 expiryTime = escrow.getDepositIntent(DEPOSIT_ID, INTENT_HASH).expiryTime;
        vm.warp(expiryTime);
        vm.expectRevert(
            abi.encodeWithSelector(
                IIntentGuardian.IntentAlreadyExpired.selector, INTENT_HASH, expiryTime, block.timestamp
            )
        );
        guardian.extendIntent(DEPOSIT_ID, INTENT_HASH, 1 hours, type(uint256).max);

        bytes32 unknownIntentHash = keccak256("unknown");
        vm.expectRevert(
            abi.encodeWithSelector(
                IIntentGuardian.IntentAlreadyExpired.selector, unknownIntentHash, 0, block.timestamp
            )
        );
        guardian.extendIntent(DEPOSIT_ID, unknownIntentHash, 1 hours, type(uint256).max);
    }

    function test_EscrowEnforcesZeroTimeAndTheCumulativeFiveDayLifetimeCap() public {
        vm.expectRevert(IEscrowV2.ZeroValue.selector);
        guardian.extendIntent(DEPOSIT_ID, INTENT_HASH, 0, type(uint256).max);

        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.AmountAboveMax.selector, 5 days, 5 days));
        guardian.extendIntent(DEPOSIT_ID, INTENT_HASH, 5 days, type(uint256).max);

        _approveGuardian(type(uint256).max);
        vm.prank(payer);
        guardian.extendIntent(DEPOSIT_ID, INTENT_HASH, 2 days, type(uint256).max);
        vm.prank(payer);
        guardian.extendIntent(DEPOSIT_ID, INTENT_HASH, 2 days, type(uint256).max);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.AmountAboveMax.selector, 1, 5 days));
        guardian.extendIntent(DEPOSIT_ID, INTENT_HASH, 1, type(uint256).max);
    }

    function test_PrepaidExtensionIsNotRefundedWhenTheIntentTerminatesImmediately() public {
        uint256 cost = guardian.quoteExtensionCost(INTENT_AMOUNT, 1 hours);
        _approveGuardian(cost);
        vm.prank(payer);
        guardian.extendIntent(DEPOSIT_ID, INTENT_HASH, 1 hours, cost);
        uint256 payerBalanceAfterExtension = token.balanceOf(payer);
        uint256 depositorBalanceAfterExtension = token.balanceOf(depositor);

        escrow.deleteIntent(INTENT_HASH);

        assertEq(token.balanceOf(payer), payerBalanceAfterExtension);
        assertEq(token.balanceOf(depositor), depositorBalanceAfterExtension);
        assertEq(token.balanceOf(address(guardian)), 0);
    }

    function _setLiveIntent(bytes32 _intentHash, uint256 _amount, uint256 _duration) internal {
        escrow.setIntent(_intentHash, _amount, block.timestamp, block.timestamp + _duration);
    }

    function _approveGuardian(uint256 _amount) internal {
        vm.prank(payer);
        token.approve(address(guardian), _amount);
    }
}

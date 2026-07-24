// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IntentGuardian} from "../../../contracts/IntentGuardian.sol";
import {IEscrow} from "../../../contracts/interfaces/IEscrow.sol";
import {IEscrowRegistry} from "../../../contracts/interfaces/IEscrowRegistry.sol";
import {IIntentGuardian} from "../../../contracts/interfaces/IIntentGuardian.sol";
import {EscrowRegistry} from "../../../contracts/registries/EscrowRegistry.sol";

contract GuardianTokenMock is ERC20 {
    constructor() ERC20("Guardian Token", "GUARD") {}

    function mint(address _account, uint256 _amount) external {
        _mint(_account, _amount);
    }
}

contract GuardianEscrowMock {
    IEscrow.Deposit internal deposit;
    mapping(bytes32 => IEscrow.Intent) internal intents;

    function configureDeposit(address _depositor, IERC20 _token, address _guardian) external {
        deposit.depositor = _depositor;
        deposit.token = _token;
        deposit.intentGuardian = _guardian;
    }

    function setIntent(bytes32 _intentHash, uint256 _amount, uint256 _timestamp, uint256 _expiryTime) external {
        intents[_intentHash] =
            IEscrow.Intent({intentHash: _intentHash, amount: _amount, timestamp: _timestamp, expiryTime: _expiryTime});
    }

    function deleteIntent(bytes32 _intentHash) external {
        delete intents[_intentHash];
    }

    function getDeposit(uint256 _depositId) external view returns (IEscrow.Deposit memory) {
        _depositId;
        return deposit;
    }

    function getDepositIntent(uint256 _depositId, bytes32 _intentHash) external view returns (IEscrow.Intent memory) {
        _depositId;
        return intents[_intentHash];
    }

    function extendIntentExpiry(uint256 _depositId, bytes32 _intentHash, uint256 _additionalTime) external {
        IEscrow.Deposit storage storedDeposit = deposit;
        IEscrow.Intent storage intent = intents[_intentHash];

        if (storedDeposit.depositor == address(0)) revert IEscrow.DepositNotFound(_depositId);
        if (intent.intentHash == bytes32(0)) revert IEscrow.IntentNotFound(_intentHash);
        if (storedDeposit.intentGuardian != msg.sender) {
            revert IEscrow.UnauthorizedCaller(msg.sender, storedDeposit.intentGuardian);
        }
        if (_additionalTime == 0) revert IEscrow.ZeroValue();
        if (intent.expiryTime + _additionalTime > intent.timestamp + 5 days) {
            revert IEscrow.AmountAboveMax(_additionalTime, 5 days);
        }

        intent.expiryTime += _additionalTime;
    }
}

contract IntentGuardianTest is Test {
    event ExtensionFeeBpsPerHourUpdated(uint256 previousFeeBpsPerHour, uint256 newFeeBpsPerHour);

    event IntentExtended(
        address indexed escrow,
        uint256 indexed depositId,
        bytes32 indexed intentHash,
        address payer,
        uint256 additionalTime,
        uint256 cost
    );

    uint256 internal constant DEPOSIT_ID = 1;
    uint256 internal constant INTENT_AMOUNT = 1_000e6;
    uint256 internal constant EXTENSION_FEE_BPS_PER_HOUR = 10;
    bytes32 internal constant INTENT_HASH = keccak256("intent");

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
        guardian = new IntentGuardian(address(this), escrowRegistry, EXTENSION_FEE_BPS_PER_HOUR);
        escrow.configureDeposit(depositor, token, address(guardian));
        _setLiveIntent(escrow, INTENT_HASH, INTENT_AMOUNT, 1 days);
        token.mint(payer, INTENT_AMOUNT);
    }

    function test_ConstructorSetsGovernanceAndRejectsInvalidConfiguration() public {
        assertEq(guardian.extensionFeeBpsPerHour(), EXTENSION_FEE_BPS_PER_HOUR);
        assertEq(address(guardian.escrowRegistry()), address(escrowRegistry));
        assertEq(guardian.owner(), address(this));
        assertEq(guardian.MAX_EXTENSION_FEE_BPS_PER_HOUR(), 83);

        vm.expectRevert(IIntentGuardian.ZeroAddress.selector);
        new IntentGuardian(address(0), escrowRegistry, EXTENSION_FEE_BPS_PER_HOUR);

        vm.expectRevert(IIntentGuardian.ZeroAddress.selector);
        new IntentGuardian(address(this), IEscrowRegistry(address(0)), EXTENSION_FEE_BPS_PER_HOUR);

        vm.expectRevert(abi.encodeWithSelector(IIntentGuardian.ExtensionFeeExceedsIntentAmount.selector, 84));
        new IntentGuardian(address(this), escrowRegistry, 84);
    }

    function test_OwnerUpdatesFeeAndQuoteWhileNonOwnerCannot() public {
        vm.prank(payer);
        vm.expectRevert("Ownable: caller is not the owner");
        guardian.setExtensionFeeBpsPerHour(1);

        uint256 previousQuote = guardian.quoteExtensionCost(INTENT_AMOUNT, 1 hours);
        vm.expectEmit(false, false, false, true, address(guardian));
        emit ExtensionFeeBpsPerHourUpdated(EXTENSION_FEE_BPS_PER_HOUR, 20);
        guardian.setExtensionFeeBpsPerHour(20);

        assertEq(guardian.extensionFeeBpsPerHour(), 20);
        assertEq(guardian.quoteExtensionCost(INTENT_AMOUNT, 1 hours), previousQuote * 2);
    }

    function test_FeeUpdateRejectsAboveMaximumAndCanDisableExtensions() public {
        vm.expectRevert(abi.encodeWithSelector(IIntentGuardian.ExtensionFeeExceedsIntentAmount.selector, 84));
        guardian.setExtensionFeeBpsPerHour(84);
        assertEq(guardian.extensionFeeBpsPerHour(), EXTENSION_FEE_BPS_PER_HOUR);

        vm.expectEmit(false, false, false, true, address(guardian));
        emit ExtensionFeeBpsPerHourUpdated(EXTENSION_FEE_BPS_PER_HOUR, 0);
        guardian.setExtensionFeeBpsPerHour(0);

        vm.expectRevert(IIntentGuardian.ExtensionsDisabled.selector);
        guardian.extendIntent(address(escrow), DEPOSIT_ID, INTENT_HASH, 1 hours, type(uint256).max);
    }

    function test_TwoStepOwnershipTransferMovesFeeAuthority() public {
        address nextOwner = makeAddr("nextOwner");
        guardian.transferOwnership(nextOwner);
        assertEq(guardian.owner(), address(this));
        assertEq(guardian.pendingOwner(), nextOwner);

        vm.prank(nextOwner);
        guardian.acceptOwnership();
        assertEq(guardian.owner(), nextOwner);
        assertEq(guardian.pendingOwner(), address(0));

        vm.expectRevert("Ownable: caller is not the owner");
        guardian.setExtensionFeeBpsPerHour(20);

        vm.prank(nextOwner);
        guardian.setExtensionFeeBpsPerHour(20);
        assertEq(guardian.extensionFeeBpsPerHour(), 20);
    }

    function test_ZeroFeeDeploymentDisablesExtensions() public {
        IntentGuardian disabledGuardian = new IntentGuardian(address(this), escrowRegistry, 0);
        escrow.configureDeposit(depositor, token, address(disabledGuardian));

        vm.expectRevert(IIntentGuardian.ExtensionsDisabled.selector);
        disabledGuardian.extendIntent(address(escrow), DEPOSIT_ID, INTENT_HASH, 1 hours, type(uint256).max);
    }

    function test_UnrelatedPayerPrepaysDepositorAndExtendsIntentImmediately() public {
        uint256 additionalTime = 2 hours;
        uint256 cost = guardian.quoteExtensionCost(INTENT_AMOUNT, additionalTime);
        uint256 expiryBefore = escrow.getDepositIntent(DEPOSIT_ID, INTENT_HASH).expiryTime;
        uint256 payerBalanceBefore = token.balanceOf(payer);
        uint256 depositorBalanceBefore = token.balanceOf(depositor);

        _approveGuardian(cost);
        vm.prank(payer);
        vm.expectEmit(true, true, true, true, address(guardian));
        emit IntentExtended(address(escrow), DEPOSIT_ID, INTENT_HASH, payer, additionalTime, cost);
        guardian.extendIntent(address(escrow), DEPOSIT_ID, INTENT_HASH, additionalTime, cost);

        assertEq(escrow.getDepositIntent(DEPOSIT_ID, INTENT_HASH).expiryTime, expiryBefore + additionalTime);
        assertEq(token.balanceOf(payer), payerBalanceBefore - cost);
        assertEq(token.balanceOf(depositor), depositorBalanceBefore + cost);
        assertEq(token.balanceOf(address(guardian)), 0);
    }

    function test_RemovedOrUnknownEscrowCannotBeUsed() public {
        escrowRegistry.removeEscrow(address(escrow));

        vm.expectRevert(abi.encodeWithSelector(IIntentGuardian.EscrowNotWhitelisted.selector, address(escrow)));
        guardian.extendIntent(address(escrow), DEPOSIT_ID, INTENT_HASH, 1 hours, type(uint256).max);
    }

    function test_AcceptAllRegistryModeSupportsCompatibleUnlistedEscrow() public {
        GuardianEscrowMock otherEscrow = new GuardianEscrowMock();
        otherEscrow.configureDeposit(depositor, token, address(guardian));
        _setLiveIntent(otherEscrow, INTENT_HASH, INTENT_AMOUNT, 1 days);
        escrowRegistry.setAcceptAllEscrows(true);

        uint256 additionalTime = 1 hours;
        uint256 cost = guardian.quoteExtensionCost(INTENT_AMOUNT, additionalTime);
        uint256 expiryBefore = otherEscrow.getDepositIntent(DEPOSIT_ID, INTENT_HASH).expiryTime;

        _approveGuardian(cost);
        vm.prank(payer);
        guardian.extendIntent(address(otherEscrow), DEPOSIT_ID, INTENT_HASH, additionalTime, cost);

        assertEq(otherEscrow.getDepositIntent(DEPOSIT_ID, INTENT_HASH).expiryTime, expiryBefore + additionalTime);
    }

    function test_OneGuardianSupportsMultipleWhitelistedEscrows() public {
        GuardianEscrowMock secondEscrow = new GuardianEscrowMock();
        escrowRegistry.addEscrow(address(secondEscrow));
        secondEscrow.configureDeposit(depositor, token, address(guardian));
        bytes32 secondIntent = keccak256("second-intent");
        _setLiveIntent(secondEscrow, secondIntent, INTENT_AMOUNT, 1 days);

        uint256 additionalTime = 1 hours;
        uint256 cost = guardian.quoteExtensionCost(INTENT_AMOUNT, additionalTime);
        uint256 firstExpiryBefore = escrow.getDepositIntent(DEPOSIT_ID, INTENT_HASH).expiryTime;
        uint256 secondExpiryBefore = secondEscrow.getDepositIntent(DEPOSIT_ID, secondIntent).expiryTime;
        _approveGuardian(cost * 2);

        vm.startPrank(payer);
        guardian.extendIntent(address(escrow), DEPOSIT_ID, INTENT_HASH, additionalTime, cost);
        guardian.extendIntent(address(secondEscrow), DEPOSIT_ID, secondIntent, additionalTime, cost);
        vm.stopPrank();

        assertEq(escrow.getDepositIntent(DEPOSIT_ID, INTENT_HASH).expiryTime, firstExpiryBefore + additionalTime);
        assertEq(
            secondEscrow.getDepositIntent(DEPOSIT_ID, secondIntent).expiryTime, secondExpiryBefore + additionalTime
        );
    }

    function test_QuoteRoundsUpToNextTokenUnit() public {
        IntentGuardian oneBpsGuardian = new IntentGuardian(address(this), escrowRegistry, 1);
        assertEq(oneBpsGuardian.quoteExtensionCost(1, 1), 1);

        uint256 amount = 1_000_003;
        uint256 additionalTime = 333;
        uint256 numerator = amount * additionalTime;
        assertEq(oneBpsGuardian.quoteExtensionCost(amount, additionalTime), (numerator + 36_000_000 - 1) / 36_000_000);
    }

    function test_MaxCostRevertsAtomicallyThenAcceptsExactQuote() public {
        uint256 additionalTime = 1 hours;
        uint256 cost = guardian.quoteExtensionCost(INTENT_AMOUNT, additionalTime);
        uint256 expiryBefore = escrow.getDepositIntent(DEPOSIT_ID, INTENT_HASH).expiryTime;
        _approveGuardian(cost);

        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(IIntentGuardian.ExtensionCostExceedsMax.selector, cost, cost - 1));
        guardian.extendIntent(address(escrow), DEPOSIT_ID, INTENT_HASH, additionalTime, cost - 1);

        assertEq(escrow.getDepositIntent(DEPOSIT_ID, INTENT_HASH).expiryTime, expiryBefore);

        vm.prank(payer);
        guardian.extendIntent(address(escrow), DEPOSIT_ID, INTENT_HASH, additionalTime, cost);
        assertEq(escrow.getDepositIntent(DEPOSIT_ID, INTENT_HASH).expiryTime, expiryBefore + additionalTime);
    }

    function test_ExpiredAndUnknownIntentsCannotBeExtended() public {
        uint256 expiryTime = escrow.getDepositIntent(DEPOSIT_ID, INTENT_HASH).expiryTime;
        vm.warp(expiryTime);
        vm.expectRevert(
            abi.encodeWithSelector(
                IIntentGuardian.IntentAlreadyExpired.selector, INTENT_HASH, expiryTime, block.timestamp
            )
        );
        guardian.extendIntent(address(escrow), DEPOSIT_ID, INTENT_HASH, 1 hours, type(uint256).max);

        bytes32 unknownIntentHash = keccak256("unknown");
        vm.expectRevert(
            abi.encodeWithSelector(IIntentGuardian.IntentAlreadyExpired.selector, unknownIntentHash, 0, block.timestamp)
        );
        guardian.extendIntent(address(escrow), DEPOSIT_ID, unknownIntentHash, 1 hours, type(uint256).max);
    }

    function test_EscrowEnforcesZeroTimeAndCumulativeFiveDayLifetimeCap() public {
        vm.expectRevert(IEscrow.ZeroValue.selector);
        guardian.extendIntent(address(escrow), DEPOSIT_ID, INTENT_HASH, 0, type(uint256).max);

        vm.expectRevert(abi.encodeWithSelector(IEscrow.AmountAboveMax.selector, 5 days, 5 days));
        guardian.extendIntent(address(escrow), DEPOSIT_ID, INTENT_HASH, 5 days, type(uint256).max);

        _approveGuardian(type(uint256).max);
        vm.startPrank(payer);
        guardian.extendIntent(address(escrow), DEPOSIT_ID, INTENT_HASH, 2 days, type(uint256).max);
        guardian.extendIntent(address(escrow), DEPOSIT_ID, INTENT_HASH, 2 days, type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(IEscrow.AmountAboveMax.selector, 1, 5 days));
        guardian.extendIntent(address(escrow), DEPOSIT_ID, INTENT_HASH, 1, type(uint256).max);
        vm.stopPrank();
    }

    function test_FailedSafeTransferRevertsEscrowExtensionAtomically() public {
        uint256 expiryBefore = escrow.getDepositIntent(DEPOSIT_ID, INTENT_HASH).expiryTime;

        vm.prank(payer);
        vm.expectRevert();
        guardian.extendIntent(address(escrow), DEPOSIT_ID, INTENT_HASH, 1 hours, type(uint256).max);

        assertEq(escrow.getDepositIntent(DEPOSIT_ID, INTENT_HASH).expiryTime, expiryBefore);
        assertEq(token.balanceOf(depositor), 0);
    }

    function test_PrepaidExtensionIsNotRefundedWhenIntentTerminatesImmediately() public {
        uint256 cost = guardian.quoteExtensionCost(INTENT_AMOUNT, 1 hours);
        _approveGuardian(cost);
        vm.prank(payer);
        guardian.extendIntent(address(escrow), DEPOSIT_ID, INTENT_HASH, 1 hours, cost);
        uint256 payerBalanceAfterExtension = token.balanceOf(payer);
        uint256 depositorBalanceAfterExtension = token.balanceOf(depositor);

        escrow.deleteIntent(INTENT_HASH);

        assertEq(token.balanceOf(payer), payerBalanceAfterExtension);
        assertEq(token.balanceOf(depositor), depositorBalanceAfterExtension);
        assertEq(token.balanceOf(address(guardian)), 0);
    }

    function _setLiveIntent(GuardianEscrowMock _escrow, bytes32 _intentHash, uint256 _amount, uint256 _duration)
        internal
    {
        _escrow.setIntent(_intentHash, _amount, block.timestamp, block.timestamp + _duration);
    }

    function _approveGuardian(uint256 _amount) internal {
        vm.prank(payer);
        token.approve(address(guardian), _amount);
    }
}

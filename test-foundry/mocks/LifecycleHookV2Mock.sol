// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {IIntentLifecycleHookV2} from "contracts/interfaces/IIntentLifecycleHookV2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Configurable lifecycle callbacks for OrchestratorV4 tests.
contract LifecycleHookV2Mock is IIntentLifecycleHookV2 {
    bool public revertOnSignal;
    bool public revertOnCallback;
    bool public revertOnFunding;
    address public deferralVault;
    bytes32 public lastIntentHash;
    bytes32 public lastFundedIntentHash;
    SettlementContext public lastSettlementContext;
    uint256 public signaledCalls;
    uint256 public cancelledCalls;
    uint256 public settlementCalls;
    uint256 public fundedCalls;
    uint256 public balanceAtFunding;
    address[3] internal feeRecipients;
    uint256[3] internal feeBalances;

    /// @notice Configures admission failure.
    function setRevertOnCreate(bool _shouldRevert) external {
        revertOnSignal = _shouldRevert;
    }

    /// @notice Configures cancellation and settlement failure.
    function setRevertOnCallback(bool _shouldRevert) external {
        revertOnCallback = _shouldRevert;
    }

    /// @notice Configures funding failure.
    function setRevertOnFunding(bool _shouldRevert) external {
        revertOnFunding = _shouldRevert;
    }

    /// @notice Selects the vault, or zero for immediate settlement.
    function setDeferralVault(address _vault) external {
        deferralVault = _vault;
    }

    /// @notice Requires fee balances to be present when settlement is called.
    function expectFeeBalances(
        address _protocol,
        uint256 _protocolBalance,
        address _referrer,
        uint256 _referrerBalance,
        address _manager,
        uint256 _managerBalance
    ) external {
        feeRecipients = [_protocol, _referrer, _manager];
        feeBalances = [_protocolBalance, _referrerBalance, _managerBalance];
    }

    /// @inheritdoc IIntentLifecycleHookV2
    function onIntentSignaled(bytes32 _intentHash) external override {
        if (revertOnSignal) revert("risk admission failed");
        lastIntentHash = _intentHash;
        signaledCalls++;
    }

    /// @inheritdoc IIntentLifecycleHookV2
    function onIntentCancelled(bytes32 _intentHash) external override {
        if (revertOnCallback) revert("risk cancellation failed");
        lastIntentHash = _intentHash;
        cancelledCalls++;
    }

    /// @inheritdoc IIntentLifecycleHookV2
    function settleIntent(SettlementContext calldata _context) external override returns (address) {
        if (revertOnCallback) revert("risk settlement failed");
        for (uint256 i; i < feeRecipients.length; ++i) {
            if (feeRecipients[i] != address(0)) {
                require(IERC20(_context.token).balanceOf(feeRecipients[i]) == feeBalances[i], "fees not paid");
            }
        }
        lastIntentHash = _context.intentHash;
        lastSettlementContext = _context;
        settlementCalls++;
        return deferralVault;
    }

    /// @inheritdoc IIntentLifecycleHookV2
    function onDeferredPayoutFunded(bytes32 _intentHash) external override {
        if (revertOnFunding) revert("risk funding failed");
        balanceAtFunding = IERC20(lastSettlementContext.token).balanceOf(deferralVault);
        require(balanceAtFunding >= lastSettlementContext.netAmount, "payout not funded");
        lastFundedIntentHash = _intentHash;
        fundedCalls++;
    }

    /// @inheritdoc IIntentLifecycleHookV2
    function lifecycleHookInterfaceId() external pure override returns (bytes4) {
        return type(IIntentLifecycleHookV2).interfaceId;
    }
}

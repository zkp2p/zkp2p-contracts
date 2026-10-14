// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {ERC165} from "@openzeppelin/contracts/utils/introspection/ERC165.sol";

import {IIntentLifecycleHookV2} from "contracts/interfaces/IIntentLifecycleHookV2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Configurable lifecycle callbacks for OrchestratorV4 tests.
contract LifecycleHookV2Mock is ERC165, IIntentLifecycleHookV2 {
    bool public revertOnSignal;
    bool public revertOnCallback;
    bool public revertOnFunding;
    address public deferralVault;
    bytes32 public lastIntentHash;
    bytes public lastSignaledLifecycleHookData;
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

    /// @notice Requires fee balances to be present before deferred payout funding is acknowledged.
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
    function onIntentSignaled(bytes32 _intentHash, bytes calldata _lifecycleHookData) external override {
        if (revertOnSignal) revert("risk admission failed");
        lastIntentHash = _intentHash;
        lastSignaledLifecycleHookData = _lifecycleHookData;
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
        lastIntentHash = _context.intentHash;
        lastSettlementContext = _context;
        settlementCalls++;
        return deferralVault;
    }

    /// @inheritdoc IIntentLifecycleHookV2
    function onDeferredPayoutFunded(bytes32 _intentHash) external override {
        if (revertOnFunding) revert("risk funding failed");
        for (uint256 i; i < feeRecipients.length; ++i) {
            if (feeRecipients[i] != address(0)) {
                require(IERC20(lastSettlementContext.token).balanceOf(feeRecipients[i]) == feeBalances[i], "fees not paid");
            }
        }
        balanceAtFunding = IERC20(lastSettlementContext.token).balanceOf(deferralVault);
        require(balanceAtFunding >= lastSettlementContext.netAmount, "payout not funded");
        lastFundedIntentHash = _intentHash;
        fundedCalls++;
    }

    /// @notice Returns all fields forwarded at settlement.
    function getLastSettlementContext() external view returns (SettlementContext memory) {
        return lastSettlementContext;
    }

    /// @notice Reports ERC-165 and IIntentLifecycleHookV2 support.
    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return interfaceId == type(IIntentLifecycleHookV2).interfaceId || super.supportsInterface(interfaceId);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {ERC165} from "@openzeppelin/contracts/utils/introspection/ERC165.sol";

import {IIntentSettlementPolicy} from "contracts/interfaces/IIntentSettlementPolicy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Configurable settlement callbacks for OrchestratorV4 tests.
contract SettlementPolicyMock is ERC165, IIntentSettlementPolicy {
    bool public revertOnCallback;
    bool public revertOnFunding;
    address public deferralVault;
    bytes32 public lastIntentHash;
    bytes32 public lastFundedIntentHash;
    SettlementContext public lastSettlementContext;
    uint256 public settlementCalls;
    uint256 public fundedCalls;
    uint256 public balanceAtFunding;
    address[3] internal feeRecipients;
    uint256[3] internal feeBalances;

    /// @notice Configures settlement failure.
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

    /// @notice Requires fee balances to be present before policy settlement.
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

    /// @inheritdoc IIntentSettlementPolicy
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

    /// @inheritdoc IIntentSettlementPolicy
    function onDeferredPayoutFunded(SettlementContext calldata _context) external override {
        if (revertOnFunding) revert("risk funding failed");
        require(keccak256(abi.encode(_context)) == keccak256(abi.encode(lastSettlementContext)), "context changed");
        balanceAtFunding = IERC20(_context.token).balanceOf(deferralVault);
        require(balanceAtFunding >= _context.netAmount, "payout not funded");
        lastFundedIntentHash = _context.intentHash;
        fundedCalls++;
    }

    /// @notice Returns all fields forwarded at settlement.
    function getLastSettlementContext() external view returns (SettlementContext memory) {
        return lastSettlementContext;
    }

    /// @notice Reports ERC-165 and IIntentSettlementPolicy support.
    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return interfaceId == type(IIntentSettlementPolicy).interfaceId || super.supportsInterface(interfaceId);
    }
}

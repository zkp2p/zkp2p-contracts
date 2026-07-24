// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {RiskManager} from "../../../contracts/RiskManager.sol";
import {StakeVault} from "../../../contracts/StakeVault.sol";
import {IAttestationVerifier} from "../../../contracts/interfaces/IAttestationVerifier.sol";
import {IEscrowV2} from "../../../contracts/interfaces/IEscrowV2.sol";
import {IIntentLifecycleHook} from "../../../contracts/interfaces/IIntentLifecycleHook.sol";
import {INullifierRegistryV2} from "../../../contracts/interfaces/INullifierRegistryV2.sol";
import {IOrchestratorV3} from "../../../contracts/interfaces/IOrchestratorV3.sol";
import {IPostIntentHookV2} from "../../../contracts/interfaces/IPostIntentHookV2.sol";
import {IReferralFee} from "../../../contracts/interfaces/IReferralFee.sol";
import {IRiskManager} from "../../../contracts/interfaces/IRiskManager.sol";

contract RiskTokenMock is ERC20 {
    bool internal transferFeeEnabled;

    constructor() ERC20("Risk Token", "RISK") {}

    function mint(address _account, uint256 _amount) external {
        _mint(_account, _amount);
    }

    function setTransferFeeEnabled(bool _enabled) external {
        transferFeeEnabled = _enabled;
    }

    function _transfer(address _from, address _to, uint256 _amount) internal override {
        if (!transferFeeEnabled || _amount == 0) {
            super._transfer(_from, _to, _amount);
            return;
        }

        super._transfer(_from, _to, _amount - 1);
        _burn(_from, 1);
    }
}

contract RiskManagerHarness is RiskManager {
    constructor(
        address _owner,
        IOrchestratorV3 _orchestrator,
        StakeVault _stakeVault,
        IAttestationVerifier _attestationVerifier,
        INullifierRegistryV2 _nullifierRegistry
    ) RiskManager(_owner, _orchestrator, _stakeVault, _attestationVerifier, _nullifierRegistry) {}

    function setPositionCoverageAmount(bytes32 _intentHash, uint256 _coverageAmount) external {
        chargebackPositions[_intentHash].coverageAmount = _coverageAmount;
    }

    function setPositionTotalExtensionTime(bytes32 _intentHash, uint64 _totalExtensionTime) external {
        intentExtensionPositions[_intentHash].totalExtensionTime = _totalExtensionTime;
    }

    function setPositionMode(bytes32 _intentHash, RiskMode _mode) external {
        chargebackPositions[_intentHash].mode = _mode;
    }
}

contract RiskAttestationVerifierMock is IAttestationVerifier {
    bool public result = true;
    bytes32 public lastDigest;

    function setResult(bool _result) external {
        result = _result;
    }

    function verify(bytes32 _digest, bytes[] calldata, bytes calldata) external view returns (bool) {
        _digest;
        return result;
    }
}

contract RiskNullifierRegistryMock {
    mapping(bytes32 => bytes32) public intentHashByNullifier;
    mapping(bytes32 => bytes32) public nullifierByIntentHash;

    function setPaymentBinding(bytes32 _nullifier, bytes32 _intentHash) external {
        intentHashByNullifier[_nullifier] = _intentHash;
        nullifierByIntentHash[_intentHash] = _nullifier;
    }
}

contract RiskEscrowMock {
    uint256 public intentExpirationPeriod = 1 hours;
    IEscrowV2.Deposit internal deposit;
    mapping(bytes32 => IEscrowV2.Intent) internal intents;

    function configureDeposit(address _lp, IERC20 _token, address _guardian) external {
        deposit.depositor = _lp;
        deposit.token = _token;
        deposit.intentGuardian = _guardian;
        deposit.acceptingIntents = true;
    }

    function setIntent(bytes32 _intentHash, uint256 _amount, uint64 _createdAt) external {
        intents[_intentHash] = IEscrowV2.Intent({
            intentHash: _intentHash,
            amount: _amount,
            timestamp: _createdAt,
            expiryTime: uint256(_createdAt) + intentExpirationPeriod
        });
    }

    function setIntentExpirationPeriod(uint256 _period) external {
        intentExpirationPeriod = _period;
    }

    function setIntentExpiry(bytes32 _intentHash, uint256 _expiryTime) external {
        intents[_intentHash].expiryTime = _expiryTime;
    }

    function setGuardian(address _guardian) external {
        deposit.intentGuardian = _guardian;
    }

    function setToken(IERC20 _token) external {
        deposit.token = _token;
    }

    function getDeposit(uint256) external view returns (IEscrowV2.Deposit memory) {
        return deposit;
    }

    function getDepositIntent(uint256, bytes32 _intentHash) external view returns (IEscrowV2.Intent memory) {
        return intents[_intentHash];
    }

    function extendIntentExpiry(uint256, bytes32 _intentHash, uint256 _additionalTime) external {
        require(msg.sender == deposit.intentGuardian, "guardian");
        IEscrowV2.Intent storage intent = intents[_intentHash];
        require(intent.intentHash != bytes32(0), "intent");
        require(intent.expiryTime + _additionalTime <= intent.timestamp + 5 days, "lifetime");
        intent.expiryTime += _additionalTime;
    }
}

contract RiskOrchestratorMock {
    mapping(bytes32 => IOrchestratorV3.RiskIntentData) internal intents;
    mapping(bytes32 => IPostIntentHookV2) internal postIntentHooks;
    mapping(bytes32 => uint64) public cancellationAt;
    mapping(bytes32 => bool) public cancellationAcknowledged;

    function setIntent(
        bytes32 _intentHash,
        address _owner,
        address _recipient,
        address _escrow,
        uint256 _amount,
        bytes32 _paymentMethod,
        uint64 _createdAt
    ) external {
        intents[_intentHash] = IOrchestratorV3.RiskIntentData({
            owner: _owner,
            to: _recipient,
            escrow: _escrow,
            depositId: 1,
            amount: _amount,
            paymentMethod: _paymentMethod,
            createdAt: _createdAt
        });
    }

    function getRiskIntent(bytes32 _intentHash) external view returns (IOrchestratorV3.RiskIntentData memory) {
        return intents[_intentHash];
    }

    function setPostIntentHook(bytes32 _intentHash, IPostIntentHookV2 _postIntentHook) external {
        postIntentHooks[_intentHash] = _postIntentHook;
    }

    function getIntent(bytes32 _intentHash) external view returns (IOrchestratorV3.Intent memory intent) {
        IOrchestratorV3.RiskIntentData memory riskIntent = intents[_intentHash];
        intent.owner = riskIntent.owner;
        intent.to = riskIntent.to;
        intent.escrow = riskIntent.escrow;
        intent.depositId = riskIntent.depositId;
        intent.amount = riskIntent.amount;
        intent.timestamp = riskIntent.createdAt;
        intent.paymentMethod = riskIntent.paymentMethod;
        intent.referralFees = new IReferralFee.ReferralFee[](0);
        intent.postIntentHook = postIntentHooks[_intentHash];
    }

    function getIntentCancellation(bytes32 _intentHash) external view returns (uint64) {
        return cancellationAt[_intentHash];
    }

    function acknowledgeIntentCancellation(bytes32 _intentHash) external {
        require(cancellationAt[_intentHash] != 0, "missing cancellation");
        delete cancellationAt[_intentHash];
        cancellationAcknowledged[_intentHash] = true;
    }

    function admit(RiskManager _manager, bytes32 _intentHash) external {
        _manager.onIntentCreated(_intentHash);
    }

    function cancel(RiskManager _manager, bytes32 _intentHash) external {
        _manager.onIntentCancelled(_intentHash);
    }

    function recordFailedCancellation(bytes32 _intentHash, uint64 _cancelledAt) external {
        cancellationAt[_intentHash] = _cancelledAt;
    }

    function settle(RiskManager _manager, IIntentLifecycleHook.RiskSettlementContext calldata _context) external {
        IERC20 token = IERC20(_context.token);
        token.approve(address(_manager), _context.grossAmount);
        _manager.settleIntent(_context);
        token.approve(address(_manager), 0);
    }
}

abstract contract RiskManagerFixture is Test {
    uint64 internal constant RISK_WINDOW = 30 days;
    uint32 internal constant EXTENSION_SLOPE = 10;
    uint256 internal constant INTENT_AMOUNT = 1_000e6;
    bytes32 internal constant PAYMENT_METHOD = keccak256("payment-method");

    address internal owner = makeAddr("owner");
    address internal taker = makeAddr("taker");
    address internal payoutRecipient = makeAddr("payoutRecipient");
    address internal safe = makeAddr("safe");
    address internal lp = makeAddr("lp");
    address internal protocolFeeRecipient = makeAddr("protocolFeeRecipient");
    address internal referralFeeRecipient = makeAddr("referralFeeRecipient");

    RiskTokenMock internal token;
    RiskTokenMock internal otherToken;
    StakeVault internal vault;
    RiskManagerHarness internal manager;
    RiskOrchestratorMock internal orchestrator;
    RiskEscrowMock internal escrow;
    RiskAttestationVerifierMock internal verifier;
    RiskNullifierRegistryMock internal nullifierRegistry;

    uint256 internal nextIntentId = 1;

    function setUp() public virtual {
        token = new RiskTokenMock();
        otherToken = new RiskTokenMock();
        orchestrator = new RiskOrchestratorMock();
        escrow = new RiskEscrowMock();
        verifier = new RiskAttestationVerifierMock();
        nullifierRegistry = new RiskNullifierRegistryMock();
        vault = new StakeVault(owner, token, address(0), 1 days);
        manager = new RiskManagerHarness(
            owner,
            IOrchestratorV3(address(orchestrator)),
            vault,
            verifier,
            INullifierRegistryV2(address(nullifierRegistry))
        );

        vm.prank(owner);
        vault.initializeController(address(manager));
        escrow.configureDeposit(lp, token, address(manager));
        _setConfig(true, true, RISK_WINDOW, EXTENSION_SLOPE);

        token.mint(safe, 100_000e6);
        token.mint(taker, 100_000e6);
        token.mint(address(orchestrator), 100_000e6);
        _depositStake(safe, 50_000e6);

        vm.prank(safe);
        vault.setTakerAuthorization(taker, true);
        vm.prank(taker);
        vault.selectStakeOwner(safe);
    }

    function _setConfig(bool _chargebackable, bool _deferredPayoutEnabled, uint64 _riskWindow, uint32 _extensionSlope)
        internal
    {
        IRiskManager.PlatformRiskConfig memory config = IRiskManager.PlatformRiskConfig({
            enabled: true,
            chargeback: IRiskManager.ChargebackConfig({
                chargebackable: _chargebackable, deferredPayoutEnabled: _deferredPayoutEnabled, riskWindow: _riskWindow
            }),
            extensionPenaltyBpsPerHour: _extensionSlope
        });
        vm.prank(owner);
        manager.setPlatformRiskConfig(PAYMENT_METHOD, config);
    }

    function _depositStake(address _stakeOwner, uint256 _amount) internal {
        vm.startPrank(_stakeOwner);
        token.approve(address(vault), _amount);
        vault.depositStake(_amount);
        vm.stopPrank();
    }

    function _newIntent(address _intentTaker, address _recipient, uint256 _amount)
        internal
        returns (bytes32 intentHash, uint64 createdAt)
    {
        intentHash = keccak256(abi.encode("intent", nextIntentId++));
        createdAt = uint64(block.timestamp);
        orchestrator.setIntent(
            intentHash, _intentTaker, _recipient, address(escrow), _amount, PAYMENT_METHOD, createdAt
        );
        escrow.setIntent(intentHash, _amount, createdAt);
    }

    function _admit(address _intentTaker, address _recipient, uint256 _amount) internal returns (bytes32 intentHash) {
        (intentHash,) = _newIntent(_intentTaker, _recipient, _amount);
        orchestrator.admit(manager, intentHash);
    }

    function _feePlan(uint256 _grossAmount, uint256 _protocolFee, uint256 _referralFee)
        internal
        view
        returns (IIntentLifecycleHook.FeeAllocation[] memory allocations, uint256 executableAmount)
    {
        allocations = new IIntentLifecycleHook.FeeAllocation[](2);
        allocations[0] = IIntentLifecycleHook.FeeAllocation({
            feeType: IIntentLifecycleHook.FeeType.PROTOCOL, recipient: protocolFeeRecipient, amount: _protocolFee
        });
        allocations[1] = IIntentLifecycleHook.FeeAllocation({
            feeType: IIntentLifecycleHook.FeeType.REFERRAL, recipient: referralFeeRecipient, amount: _referralFee
        });
        executableAmount = _grossAmount - _protocolFee - _referralFee;
    }

    function _settlementContext(
        bytes32 _intentHash,
        uint256 _grossAmount,
        uint256 _protocolFee,
        uint256 _referralFee,
        bool _isManualRelease
    ) internal view returns (IIntentLifecycleHook.RiskSettlementContext memory context) {
        (IIntentLifecycleHook.FeeAllocation[] memory allocations, uint256 executableAmount) =
            _feePlan(_grossAmount, _protocolFee, _referralFee);
        context = IIntentLifecycleHook.RiskSettlementContext({
            intentHash: _intentHash,
            token: address(token),
            recipient: payoutRecipient,
            grossAmount: _grossAmount,
            executableAmount: executableAmount,
            isManualRelease: _isManualRelease,
            feeAllocations: allocations
        });
    }

    function _chargebackAttestation(bytes32 _intentHash, bytes32 _paymentId, bytes32 _disputeId)
        internal
        pure
        returns (IRiskManager.ChargebackAttestation memory attestation)
    {
        IRiskManager.ChargebackDetails memory details = IRiskManager.ChargebackDetails({
            paymentMethod: PAYMENT_METHOD,
            originalPaymentId: _paymentId,
            disputeId: _disputeId,
            paymentAmount: 100_00,
            paymentCurrency: keccak256("USD")
        });
        bytes memory data = abi.encode(details);
        attestation = IRiskManager.ChargebackAttestation({
            intentHash: _intentHash, dataHash: keccak256(data), signatures: new bytes[](0), data: data
        });
    }
}

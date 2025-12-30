// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

import { IOrchestrator } from "../interfaces/IOrchestrator.sol";
import { IPostIntentHook } from "../interfaces/IPostIntentHook.sol";
import { IRelayDepository } from "../external/Interfaces/IRelayDepository.sol";


/**
 * @title RelayBridgeHook
 * @notice Post-intent hook that deposits USDC into Relay Depository to initiate a bridge to a destination chain
 */
contract RelayBridgeHook is IPostIntentHook, Ownable, EIP712 {
    using SafeERC20 for IERC20;

    /* ============ Structs ============ */

    /// @notice Commitment stored in intent.data at signalIntent time.
    struct BridgeCommitment {
        uint256 destinationChainId;
        address destinationCurrency;
        address recipient;
        uint16 maxSlippageBps;
        address refundTo;
    }

    /// @notice Payment details returned by Relay /quote/v2.
    struct RelayPaymentDetails {
        uint256 chainId;
        address depository;
        address currency;
        uint256 amount;
    }

    /// @notice Quote data provided at fulfillIntent time (postIntentHookData).
    /// @dev intentHash is included for off-chain reconciliation and is not validated against _intent on-chain.
    struct RelayQuoteData {
        bytes32 intentHash;
        bytes32 orderId;
        RelayPaymentDetails payment;
        uint256 quoteExpiration;
        uint256 destinationChainId;
        address destinationCurrency;
        address recipient;
        address refundTo;
        uint16 slippageBps;
        bytes signature;
    }

    /// @notice Signed payload used for EIP-712 verification.
    struct RelayQuoteAuthorization {
        bytes32 intentDigest;
        bytes32 intentHash;
        bytes32 orderId;
        uint256 quoteExpiration;
        uint256 paymentChainId;
        address paymentDepository;
        address paymentCurrency;
        uint256 paymentAmount;
        uint256 destinationChainId;
        address destinationCurrency;
        address recipient;
        address refundTo;
        uint16 slippageBps;
    }

    /* ============ Events ============ */

    event RelayBridgeInitiated(
        bytes32 indexed intentHash,
        bytes32 indexed orderId,
        uint256 amount,
        uint256 destinationChainId,
        address destinationCurrency,
        address recipient
    );

    event RescueERC20(address indexed token, address indexed to, uint256 amount);
    event RescueNative(address indexed to, uint256 amount);

    /* ============ Errors ============ */

    error ZeroAddress();
    error UnauthorizedCaller(address caller);
    error InvalidChainId(uint256 chainId);
    error InvalidDepository(address depository);
    error InvalidCurrency(address currency);
    error InvalidAmount(uint256 amount, uint256 expected);
    error InvalidOrderId(bytes32 orderId);
    error QuoteExpired(uint256 expiration, uint256 currentTime);
    error DestinationChainMismatch(uint256 committed, uint256 provided);
    error DestinationCurrencyMismatch(address committed, address provided);
    error RecipientMismatch(address committed, address provided);
    error RefundAddressMismatch(address committed, address provided);
    error SlippageExceedsMax(uint16 provided, uint16 maximum);
    error InvalidSignature(address signer, address expected);
    error NativeTransferFailed(address to, uint256 amount);

    /* ============ State Variables ============ */

    IERC20 public immutable usdc;
    address public immutable orchestrator;
    address public immutable depository;
    address public immutable trustedSigner;

    /* ============ Constants ============ */

    bytes32 private constant RELAY_QUOTE_AUTHORIZATION_TYPEHASH = keccak256(
        "RelayQuoteAuthorization(bytes32 intentDigest,bytes32 intentHash,bytes32 orderId,uint256 quoteExpiration,uint256 paymentChainId,address paymentDepository,address paymentCurrency,uint256 paymentAmount,uint256 destinationChainId,address destinationCurrency,address recipient,address refundTo,uint16 slippageBps)"
    );

    /* ============ Constructor ============ */

    /**
     * @notice Creates a new RelayBridgeHook instance.
     * @param _usdc USDC token address on this chain
     * @param _orchestrator Orchestrator that invokes this hook
     * @param _depository Relay Depository address on this chain
     * @param _trustedSigner Backend signer for quote authorization
     */
    constructor(
        address _usdc,
        address _orchestrator,
        address _depository,
        address _trustedSigner
    ) EIP712("RelayBridgeHook", "1") Ownable() {
        if (
            _usdc == address(0) ||
            _orchestrator == address(0) ||
            _depository == address(0) ||
            _trustedSigner == address(0)
        ) {
            revert ZeroAddress();
        }

        usdc = IERC20(_usdc);
        orchestrator = _orchestrator;
        depository = _depository;
        trustedSigner = _trustedSigner;
    }

    /* ============ External Functions ============ */

    /**
     * @notice Executes the hook by depositing USDC into Relay Depository.
     * @dev Validates payment details, destination commitment, quote expiration, and signature.
     * The signature binds the intent digest and includes intentHash for off-chain reconciliation.
     * @param _intent Intent data passed by Orchestrator (includes commitment in intent.data)
     * @param _amountNetFees Net USDC amount after fees
     * @param _fulfillIntentData ABI-encoded RelayQuoteData from a fresh Relay quote
     */
    function execute(
        IOrchestrator.Intent memory _intent,
        uint256 _amountNetFees,
        bytes calldata _fulfillIntentData
    ) external override {
        if (msg.sender != orchestrator) revert UnauthorizedCaller(msg.sender);

        BridgeCommitment memory commitment = abi.decode(_intent.data, (BridgeCommitment));
        RelayQuoteData memory quote = abi.decode(_fulfillIntentData, (RelayQuoteData));
        _validateQuote(_intent, quote, _amountNetFees);

        usdc.safeTransferFrom(orchestrator, address(this), _amountNetFees);

        usdc.safeApprove(depository, 0);
        usdc.safeApprove(depository, _amountNetFees);
        IRelayDepository(depository).depositErc20(address(this), address(usdc), _amountNetFees, quote.orderId);
        usdc.safeApprove(depository, 0);

        emit RelayBridgeInitiated(
            quote.intentHash,
            quote.orderId,
            _amountNetFees,
            commitment.destinationChainId,
            commitment.destinationCurrency,
            commitment.recipient
        );
    }

    /**
     * @notice Rescues ERC20 tokens sent to this contract.
     * @param _token Token address to rescue
     * @param _to Recipient address for rescued tokens
     * @param _amount Amount to rescue
     */
    function rescueERC20(address _token, address _to, uint256 _amount) external onlyOwner {
        if (_token == address(0) || _to == address(0)) revert ZeroAddress();
        IERC20(_token).safeTransfer(_to, _amount);
        emit RescueERC20(_token, _to, _amount);
    }

    /**
     * @notice Rescues native tokens sent to this contract.
     * @param _to Recipient address for rescued native tokens
     * @param _amount Amount to rescue
     */
    function rescueNative(address payable _to, uint256 _amount) external onlyOwner {
        if (_to == address(0)) revert ZeroAddress();
        (bool success, ) = _to.call{ value: _amount }("");
        if (!success) revert NativeTransferFailed(_to, _amount);
        emit RescueNative(_to, _amount);
    }

    receive() external payable {}

    /* ============ Internal Functions ============ */

    /**
     * @notice Validates a quote against the commitment and verifies the signer.
     * @param _intent Intent struct used to compute the intent digest
     * @param _quote Relay quote data supplied by the fulfiller
     * @param _amountNetFees Net USDC amount expected to be deposited
     */
    function _validateQuote(
        IOrchestrator.Intent memory _intent,
        RelayQuoteData memory _quote,
        uint256 _amountNetFees
    ) internal view {
        BridgeCommitment memory commitment = abi.decode(_intent.data, (BridgeCommitment));

        if (_quote.orderId == bytes32(0)) revert InvalidOrderId(_quote.orderId);

        if (_quote.quoteExpiration < block.timestamp) {
            revert QuoteExpired(_quote.quoteExpiration, block.timestamp);
        }
        if (_quote.destinationChainId != commitment.destinationChainId) {
            revert DestinationChainMismatch(commitment.destinationChainId, _quote.destinationChainId);
        }
        if (_quote.destinationCurrency != commitment.destinationCurrency) {
            revert DestinationCurrencyMismatch(commitment.destinationCurrency, _quote.destinationCurrency);
        }
        if (_quote.recipient != commitment.recipient) {
            revert RecipientMismatch(commitment.recipient, _quote.recipient);
        }
        if (_quote.refundTo != commitment.refundTo) {
            revert RefundAddressMismatch(commitment.refundTo, _quote.refundTo);
        }
        if (_quote.slippageBps > commitment.maxSlippageBps) {
            revert SlippageExceedsMax(_quote.slippageBps, commitment.maxSlippageBps);
        }

        if (_quote.payment.chainId != block.chainid) revert InvalidChainId(_quote.payment.chainId);
        if (_quote.payment.depository != depository) revert InvalidDepository(_quote.payment.depository);
        if (_quote.payment.currency != address(usdc)) revert InvalidCurrency(_quote.payment.currency);
        if (_quote.payment.amount != _amountNetFees) revert InvalidAmount(_quote.payment.amount, _amountNetFees);

        bytes32 intentDigest = _hashIntent(_intent);
        _verifySignature(intentDigest, _quote);
    }

    /**
     * @notice Verifies the EIP-712 signature for a Relay quote authorization.
     * @param _intentDigest Hash of the intent fields
     * @param _quote Relay quote data supplied by the fulfiller
     */
    function _verifySignature(bytes32 _intentDigest, RelayQuoteData memory _quote) internal view {
        RelayQuoteAuthorization memory auth;
        auth.intentDigest = _intentDigest;
        auth.intentHash = _quote.intentHash;
        auth.orderId = _quote.orderId;
        auth.quoteExpiration = _quote.quoteExpiration;
        auth.paymentChainId = _quote.payment.chainId;
        auth.paymentDepository = _quote.payment.depository;
        auth.paymentCurrency = _quote.payment.currency;
        auth.paymentAmount = _quote.payment.amount;
        auth.destinationChainId = _quote.destinationChainId;
        auth.destinationCurrency = _quote.destinationCurrency;
        auth.recipient = _quote.recipient;
        auth.refundTo = _quote.refundTo;
        auth.slippageBps = _quote.slippageBps;

        bytes32 structHash = keccak256(abi.encode(RELAY_QUOTE_AUTHORIZATION_TYPEHASH, auth));
        bytes32 digest = _hashTypedDataV4(structHash);
        address signer = ECDSA.recover(digest, _quote.signature);
        if (signer != trustedSigner) revert InvalidSignature(signer, trustedSigner);
    }

    /**
     * @notice Computes a deterministic digest of the intent.
     * @dev Used for signature binding because Orchestrator does not pass intentHash.
     * @param _intent Intent struct to hash
     * @return intentDigest Keccak256 hash of the intent fields
     */
    function _hashIntent(IOrchestrator.Intent memory _intent) internal pure returns (bytes32) {
        return keccak256(abi.encode(_intent));
    }
}

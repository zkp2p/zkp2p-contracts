# CCTP v2 Hook Integration Spec (Source Chain Only)

## Purpose
Integrate a CCTP v2 source-chain post-intent hook similar to `AcrossBridgeHook` that burns USDC on Base and emits a CCTP message for minting on any supported destination domain. Destination chain execution and minting are out of scope for contract changes, but are included here for flow clarity.

## Scope
- Source chain only (Base mainnet or Base Sepolia).
- USDC only.
- Uses CCTP v2 `TokenMessengerV2` for `depositForBurn` (no destination hook execution).
- Destination chain minting and hook execution are out of scope.

## References
- Arc tutorial: https://docs.arc.network/arc/tutorials/bridge-usdc-to-arc
- Circle CCTP overview: https://developers.circle.com/cctp
- CCTP technical guide: https://developers.circle.com/cctp/technical-guide
- CCTP EVM contracts: https://developers.circle.com/cctp/evm-smart-contracts

## Current Hook Architecture (Context)
- The Orchestrator calls `IPostIntentHook.execute(intent, amountNetFees, postIntentHookData)`.
- The hook must pull exactly `amountNetFees` from the Orchestrator, otherwise the call reverts.
- `AcrossBridgeHook` is the existing example.

## Proposed Contract: `CctpBridgeHook`
### Responsibilities
- Validate commitment and fulfill data.
- Pull net USDC from Orchestrator.
- Call `TokenMessengerV2.depositForBurn`.
- Emit a `CctpBridgeInitiated` event.

### External Dependencies
- `TokenMessengerV2` (CCTP v2) on Base.
- USDC on Base.

### Data Structures
Commitment stored in `intent.data` at `signalIntent` time:
```
struct CctpBridgeCommitment {
    uint32 destinationDomain;
    bytes32 mintRecipient;       // bytes32 for EVM or non-EVM address
    bytes32 destinationCaller;   // bytes32(0) = any caller can mint
    uint32 minFinalityThreshold; // 1000 (fast) or 2000 (standard)
}
```
Note: There is no signal-time fee cap; `maxFee` is supplied at fulfill time.

Fulfill data supplied at `fulfillIntent` time:
```
struct CctpFulfillData {
    bytes32 intentHash; // used for event indexing
    uint256 maxFee;     // max fee to allow on destination mint
}
```

### Execution Flow (Onchain)
1. Orchestrator calls `CctpBridgeHook.execute`.
2. Hook validates:
   - Caller is Orchestrator.
   - `destinationDomain != sourceDomain` and `destinationDomain != 0`.
   - `mintRecipient != bytes32(0)`.
   - `minFinalityThreshold` is 1000 or 2000.
   - `maxFee <= amountNetFees`.
3. Hook pulls `amountNetFees` from Orchestrator.
4. Hook calls `TokenMessengerV2.depositForBurn`.
5. Hook emits `CctpBridgeInitiated`.

### CCTP Call
Use `depositForBurn` (no hook data) on the source chain.
```
TokenMessengerV2.depositForBurn(
    amount,              // amountNetFees (USDC)
    destinationDomain,
    mintRecipient,
    burnToken,            // USDC
    destinationCaller,
    maxFee,
    minFinalityThreshold
)
```

### Events
```
event CctpBridgeInitiated(
    bytes32 indexed intentHash,
    uint32 destinationDomain,
    bytes32 mintRecipient,
    uint256 amount,
    uint256 maxFee,
    uint32 minFinalityThreshold
);
```

### Errors
- `ZeroAddress()`
- `UnauthorizedCaller(address caller)`
- `InvalidDestinationDomain(uint32 destinationDomain)`
- `InvalidRecipient(bytes32 mintRecipient)`
- `InvalidFinalityThreshold(uint32 minFinalityThreshold)`
- `MaxFeeAboveAmount(uint256 maxFee, uint256 amount)`
- `NativeTransferFailed(address to, uint256 amount)`

## Configuration
### Domains
- Base mainnet domain: 6
- Base Sepolia domain: 6

### Contract Addresses (TokenMessengerV2)
From Circle CCTP EVM contracts reference:
- Base mainnet: `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d`
- Base Sepolia: `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA`

### Deployment Parameters
Add to `deployments/parameters.ts`:
- `CCTP_TOKEN_MESSENGER_V2[network]`
- `CCTP_SOURCE_DOMAIN[network]` (Base = 6)

## Offchain Responsibilities
- Compute `maxFee` using Iris API: `GET /v2/burn/USDC/fees`.
- For fast transfers, check allowance: `GET /v2/fastBurn/USDC/allowance`.
- Encode `mintRecipient` as `bytes32` (EVM: left-pad 20 byte address).
- Provide `postIntentHookData = abi.encode(CctpFulfillData)`.
- Fetch attestation after burn: `GET /v2/messages` with tx hash or nonce.

## Flow Diagram
```mermaid
flowchart TD
    A[User or App] --> B[Offchain coordinator]
    B --> C[GET /v2/burn/USDC/fees]
    B --> D[Optional: GET /v2/fastBurn/USDC/allowance]
    B --> E[Signal intent on Orchestrator]
    E --> F[Fulfill intent]
    F --> G[CctpBridgeHook.execute]
    G --> H[TokenMessengerV2.depositForBurn]
    H --> I[TokenMinterV2 burns USDC]
    H --> J[MessageTransmitterV2.sendMessage]
    J --> K[Circle attestation service (Iris)]
    K --> L[GET /v2/messages for attestation]
    L --> M[Destination relayer or user submits receiveMessage]
    M --> N[TokenMessengerV2.handleReceiveFinalizedMessage]
    N --> O[Mint USDC to destination recipient]
```

## Destination User Requirements (Informational)
- Someone (user or relayer) must pay gas on the destination chain to call `MessageTransmitterV2.receiveMessage` with the attestation.
- If `destinationCaller` is non-zero, only that address can submit the receive call.

## Security and Safety Notes
- CCTP enforces a per-transaction burn limit of 10M USDC; larger transfers must be split.
- Hook must consume exactly `amountNetFees` from the Orchestrator to satisfy invariant checks.
- `minFinalityThreshold` governs fast (1000) vs standard (2000) attestations.
- `maxFee` must be computed offchain to avoid onchain revert from fee minimums.
- Keep `destinationCaller = bytes32(0)` unless there is a specific relayer restriction.

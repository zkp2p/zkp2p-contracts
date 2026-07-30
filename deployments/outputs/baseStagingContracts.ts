export default {
  "name": "base_staging",
  "chainId": "8453",
  "contracts": {
    "AddressGroupRegistry": {
      "address": "0x54Ff7788Cb42B46FE2F016a65Fd0f654Bb9BcF3D",
      "abi": [
        {
          "inputs": [],
          "name": "EmptyArray",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "groupId",
              "type": "bytes32"
            }
          ],
          "name": "GroupDoesNotExist",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "groupId",
              "type": "bytes32"
            }
          ],
          "name": "GroupNotPublic",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "groupId",
              "type": "bytes32"
            }
          ],
          "name": "NoPendingTransfer",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "resolver",
              "type": "address"
            }
          ],
          "name": "ResolverNotContract",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "caller",
              "type": "address"
            },
            {
              "internalType": "address",
              "name": "curator",
              "type": "address"
            }
          ],
          "name": "UnauthorizedGroupCurator",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "caller",
              "type": "address"
            },
            {
              "internalType": "address",
              "name": "pendingCurator",
              "type": "address"
            }
          ],
          "name": "UnauthorizedPendingCurator",
          "type": "error"
        },
        {
          "inputs": [],
          "name": "ZeroAddress",
          "type": "error"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "groupId",
              "type": "bytes32"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "curator",
              "type": "address"
            },
            {
              "indexed": false,
              "internalType": "string",
              "name": "name",
              "type": "string"
            }
          ],
          "name": "GroupCreated",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "groupId",
              "type": "bytes32"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "cancelledPendingCurator",
              "type": "address"
            }
          ],
          "name": "GroupCuratorTransferCancelled",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "groupId",
              "type": "bytes32"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "curator",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "pendingCurator",
              "type": "address"
            }
          ],
          "name": "GroupCuratorTransferStarted",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "groupId",
              "type": "bytes32"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "previousCurator",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "newCurator",
              "type": "address"
            }
          ],
          "name": "GroupCuratorTransferred",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "groupId",
              "type": "bytes32"
            },
            {
              "indexed": false,
              "internalType": "bool",
              "name": "isPublic",
              "type": "bool"
            }
          ],
          "name": "GroupVisibilityChanged",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "groupId",
              "type": "bytes32"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "member",
              "type": "address"
            }
          ],
          "name": "MemberAdded",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "groupId",
              "type": "bytes32"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "member",
              "type": "address"
            }
          ],
          "name": "MemberRemoved",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "groupId",
              "type": "bytes32"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "oldResolver",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "newResolver",
              "type": "address"
            }
          ],
          "name": "ResolverSet",
          "type": "event"
        },
        {
          "inputs": [],
          "name": "RESOLVER_GAS_LIMIT",
          "outputs": [
            {
              "internalType": "uint256",
              "name": "",
              "type": "uint256"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_groupId",
              "type": "bytes32"
            }
          ],
          "name": "acceptGroupCurator",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_groupId",
              "type": "bytes32"
            },
            {
              "internalType": "address[]",
              "name": "_members",
              "type": "address[]"
            }
          ],
          "name": "addMembers",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_groupId",
              "type": "bytes32"
            }
          ],
          "name": "cancelGroupCuratorTransfer",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "string",
              "name": "_name",
              "type": "string"
            }
          ],
          "name": "createGroup",
          "outputs": [
            {
              "internalType": "bytes32",
              "name": "groupId",
              "type": "bytes32"
            }
          ],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_groupId",
              "type": "bytes32"
            }
          ],
          "name": "getGroup",
          "outputs": [
            {
              "internalType": "address",
              "name": "curator",
              "type": "address"
            },
            {
              "internalType": "address",
              "name": "pendingCurator",
              "type": "address"
            },
            {
              "internalType": "address",
              "name": "resolver",
              "type": "address"
            },
            {
              "internalType": "bool",
              "name": "isPublic",
              "type": "bool"
            },
            {
              "internalType": "bool",
              "name": "exists",
              "type": "bool"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "groupCount",
          "outputs": [
            {
              "internalType": "uint256",
              "name": "",
              "type": "uint256"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_groupId",
              "type": "bytes32"
            }
          ],
          "name": "groupExists",
          "outputs": [
            {
              "internalType": "bool",
              "name": "",
              "type": "bool"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_groupId",
              "type": "bytes32"
            },
            {
              "internalType": "address",
              "name": "_account",
              "type": "address"
            }
          ],
          "name": "isMember",
          "outputs": [
            {
              "internalType": "bool",
              "name": "",
              "type": "bool"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_groupId",
              "type": "bytes32"
            }
          ],
          "name": "joinGroup",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_groupId",
              "type": "bytes32"
            }
          ],
          "name": "leaveGroup",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "",
              "type": "bytes32"
            },
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            }
          ],
          "name": "members",
          "outputs": [
            {
              "internalType": "bool",
              "name": "",
              "type": "bool"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_groupId",
              "type": "bytes32"
            },
            {
              "internalType": "address[]",
              "name": "_members",
              "type": "address[]"
            }
          ],
          "name": "removeMembers",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_groupId",
              "type": "bytes32"
            },
            {
              "internalType": "bool",
              "name": "_isPublic",
              "type": "bool"
            }
          ],
          "name": "setGroupVisibility",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_groupId",
              "type": "bytes32"
            },
            {
              "internalType": "address",
              "name": "_resolver",
              "type": "address"
            }
          ],
          "name": "setResolver",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_groupId",
              "type": "bytes32"
            },
            {
              "internalType": "address",
              "name": "_newCurator",
              "type": "address"
            }
          ],
          "name": "transferGroupCurator",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        }
      ]
    },
    "ChainlinkOracleAdapter": {
      "address": "0xA3dBea0fCc742bF2eF32BB38E0D94e6AF0A6eDD6",
      "abi": [
        {
          "inputs": [
            {
              "internalType": "bytes",
              "name": "normalizedConfig",
              "type": "bytes"
            }
          ],
          "name": "getRate",
          "outputs": [
            {
              "internalType": "bool",
              "name": "valid",
              "type": "bool"
            },
            {
              "internalType": "uint256",
              "name": "rate",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "updatedAt",
              "type": "uint256"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes",
              "name": "rawConfig",
              "type": "bytes"
            }
          ],
          "name": "validateConfig",
          "outputs": [
            {
              "internalType": "bytes",
              "name": "normalizedConfig",
              "type": "bytes"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        }
      ]
    },
    "ChargebackNullifierRegistry": {
      "address": "0xB010Dc8E628AA1e5B2bE027DaE1A79293E727A84",
      "abi": [
        {
          "inputs": [],
          "stateMutability": "nonpayable",
          "type": "constructor"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": false,
              "internalType": "bytes32",
              "name": "nullifier",
              "type": "bytes32"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "writer",
              "type": "address"
            }
          ],
          "name": "NullifierAdded",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "previousOwner",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "newOwner",
              "type": "address"
            }
          ],
          "name": "OwnershipTransferred",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": false,
              "internalType": "address",
              "name": "writer",
              "type": "address"
            }
          ],
          "name": "WriterAdded",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": false,
              "internalType": "address",
              "name": "writer",
              "type": "address"
            }
          ],
          "name": "WriterRemoved",
          "type": "event"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_nullifier",
              "type": "bytes32"
            }
          ],
          "name": "addNullifier",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_newWriter",
              "type": "address"
            }
          ],
          "name": "addWritePermission",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "getWriters",
          "outputs": [
            {
              "internalType": "address[]",
              "name": "",
              "type": "address[]"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "",
              "type": "bytes32"
            }
          ],
          "name": "isNullified",
          "outputs": [
            {
              "internalType": "bool",
              "name": "",
              "type": "bool"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            }
          ],
          "name": "isWriter",
          "outputs": [
            {
              "internalType": "bool",
              "name": "",
              "type": "bool"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "owner",
          "outputs": [
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_removedWriter",
              "type": "address"
            }
          ],
          "name": "removeWritePermission",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "renounceOwnership",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "newOwner",
              "type": "address"
            }
          ],
          "name": "transferOwnership",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "",
              "type": "uint256"
            }
          ],
          "name": "writers",
          "outputs": [
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        }
      ]
    },
    "ChargebackPolicy": {
      "address": "0x672215e9D390C01C96dC1eB439438001efEfe967",
      "abi": [
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_owner",
              "type": "address"
            },
            {
              "internalType": "contract IStakeVault",
              "name": "_stakeVault",
              "type": "address"
            },
            {
              "internalType": "contract IChargebackVerifier",
              "name": "_chargebackVerifier",
              "type": "address"
            },
            {
              "internalType": "contract INullifierRegistry",
              "name": "_chargebackNullifierRegistry",
              "type": "address"
            }
          ],
          "stateMutability": "nonpayable",
          "type": "constructor"
        },
        {
          "inputs": [],
          "name": "AdmissionsPaused",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "intentHash",
              "type": "bytes32"
            }
          ],
          "name": "ChargebackIntentAlreadyExists",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "intentHash",
              "type": "bytes32"
            },
            {
              "internalType": "enum IChargebackPolicy.ChargebackIntentStatus",
              "name": "status",
              "type": "uint8"
            }
          ],
          "name": "ChargebackIntentNotPending",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint64",
              "name": "releaseEligibleAt",
              "type": "uint64"
            },
            {
              "internalType": "uint64",
              "name": "currentTime",
              "type": "uint64"
            }
          ],
          "name": "ChargebackIntentNotReleaseEligible",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "intentHash",
              "type": "bytes32"
            },
            {
              "internalType": "enum IChargebackPolicy.ChargebackIntentStatus",
              "name": "status",
              "type": "uint8"
            }
          ],
          "name": "ChargebackIntentNotSettled",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "escrow",
              "type": "address"
            },
            {
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            }
          ],
          "name": "ChargebackNotEnabled",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "expectedToken",
              "type": "address"
            },
            {
              "internalType": "address",
              "name": "actualToken",
              "type": "address"
            }
          ],
          "name": "IntentTokenMismatch",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "dependency",
              "type": "address"
            }
          ],
          "name": "InvalidContract",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint64",
              "name": "riskWindow",
              "type": "uint64"
            }
          ],
          "name": "InvalidRiskWindow",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "escrow",
              "type": "address"
            },
            {
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "internalType": "address",
              "name": "caller",
              "type": "address"
            }
          ],
          "name": "NotDepositor",
          "type": "error"
        },
        {
          "inputs": [],
          "name": "OwnershipRenunciationDisabled",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "timestamp",
              "type": "uint256"
            }
          ],
          "name": "TimestampOverflow",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "caller",
              "type": "address"
            }
          ],
          "name": "UnauthorizedLifecycleHook",
          "type": "error"
        },
        {
          "inputs": [],
          "name": "ZeroAddress",
          "type": "error"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": false,
              "internalType": "bool",
              "name": "isPaused",
              "type": "bool"
            }
          ],
          "name": "AdmissionsPausedUpdated",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "escrow",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "indexed": false,
              "internalType": "bool",
              "name": "isChargebackEnabled",
              "type": "bool"
            }
          ],
          "name": "ChargebackEnabledUpdated",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "intentHash",
              "type": "bytes32"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "stakeOwner",
              "type": "address"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "releasedAmount",
              "type": "uint256"
            }
          ],
          "name": "ChargebackIntentCancelled",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "intentHash",
              "type": "bytes32"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "stakeOwner",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "depositor",
              "type": "address"
            },
            {
              "indexed": false,
              "internalType": "address",
              "name": "taker",
              "type": "address"
            },
            {
              "indexed": false,
              "internalType": "bytes32",
              "name": "paymentMethod",
              "type": "bytes32"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "amount",
              "type": "uint256"
            },
            {
              "indexed": false,
              "internalType": "uint64",
              "name": "riskWindow",
              "type": "uint64"
            }
          ],
          "name": "ChargebackIntentOpened",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "intentHash",
              "type": "bytes32"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "stakeOwner",
              "type": "address"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "releasedAmount",
              "type": "uint256"
            }
          ],
          "name": "ChargebackIntentReleased",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "intentHash",
              "type": "bytes32"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "stakeOwner",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "depositor",
              "type": "address"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "releaseAmount",
              "type": "uint256"
            },
            {
              "indexed": false,
              "internalType": "uint64",
              "name": "releaseEligibleAt",
              "type": "uint64"
            },
            {
              "indexed": false,
              "internalType": "bool",
              "name": "isManualRelease",
              "type": "bool"
            }
          ],
          "name": "ChargebackIntentSettled",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "intentHash",
              "type": "bytes32"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "stakeOwner",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "depositor",
              "type": "address"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "compensatedAmount",
              "type": "uint256"
            },
            {
              "indexed": false,
              "internalType": "bytes32",
              "name": "disputeId",
              "type": "bytes32"
            }
          ],
          "name": "ChargebackSettled",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "previousVerifier",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "newVerifier",
              "type": "address"
            }
          ],
          "name": "ChargebackVerifierUpdated",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "hook",
              "type": "address"
            },
            {
              "indexed": false,
              "internalType": "bool",
              "name": "isAuthorized",
              "type": "bool"
            }
          ],
          "name": "LifecycleHookAuthorizationUpdated",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "previousOwner",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "newOwner",
              "type": "address"
            }
          ],
          "name": "OwnershipTransferStarted",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "previousOwner",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "newOwner",
              "type": "address"
            }
          ],
          "name": "OwnershipTransferred",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "paymentMethod",
              "type": "bytes32"
            },
            {
              "indexed": false,
              "internalType": "uint64",
              "name": "riskWindow",
              "type": "uint64"
            }
          ],
          "name": "RiskWindowUpdated",
          "type": "event"
        },
        {
          "inputs": [],
          "name": "MAX_RISK_WINDOW",
          "outputs": [
            {
              "internalType": "uint64",
              "name": "",
              "type": "uint64"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "PENDING_COVERAGE_MATURITY",
          "outputs": [
            {
              "internalType": "uint64",
              "name": "",
              "type": "uint64"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "acceptOwnership",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "acceptVaultController",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "admissionsPaused",
          "outputs": [
            {
              "internalType": "bool",
              "name": "",
              "type": "bool"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "chargebackNullifierRegistry",
          "outputs": [
            {
              "internalType": "contract INullifierRegistry",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "chargebackVerifier",
          "outputs": [
            {
              "internalType": "contract IChargebackVerifier",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_intentHash",
              "type": "bytes32"
            }
          ],
          "name": "getChargebackIntent",
          "outputs": [
            {
              "components": [
                {
                  "internalType": "address",
                  "name": "taker",
                  "type": "address"
                },
                {
                  "internalType": "address",
                  "name": "stakeOwner",
                  "type": "address"
                },
                {
                  "internalType": "address",
                  "name": "depositor",
                  "type": "address"
                },
                {
                  "internalType": "bytes32",
                  "name": "paymentMethod",
                  "type": "bytes32"
                },
                {
                  "internalType": "enum IChargebackPolicy.ChargebackIntentStatus",
                  "name": "status",
                  "type": "uint8"
                },
                {
                  "internalType": "bool",
                  "name": "isManualRelease",
                  "type": "bool"
                },
                {
                  "internalType": "uint64",
                  "name": "riskWindow",
                  "type": "uint64"
                },
                {
                  "internalType": "uint64",
                  "name": "releaseEligibleAt",
                  "type": "uint64"
                },
                {
                  "internalType": "uint256",
                  "name": "releaseAmount",
                  "type": "uint256"
                }
              ],
              "internalType": "struct IChargebackPolicy.ChargebackIntent",
              "name": "",
              "type": "tuple"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_paymentMethod",
              "type": "bytes32"
            }
          ],
          "name": "getRiskWindow",
          "outputs": [
            {
              "internalType": "uint64",
              "name": "",
              "type": "uint64"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_escrow",
              "type": "address"
            },
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            }
          ],
          "name": "isChargebackEnabled",
          "outputs": [
            {
              "internalType": "bool",
              "name": "",
              "type": "bool"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_hook",
              "type": "address"
            }
          ],
          "name": "isLifecycleHookAuthorized",
          "outputs": [
            {
              "internalType": "bool",
              "name": "",
              "type": "bool"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_intentHash",
              "type": "bytes32"
            }
          ],
          "name": "onIntentCancelled",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_intentHash",
              "type": "bytes32"
            },
            {
              "internalType": "uint256",
              "name": "_releaseAmount",
              "type": "uint256"
            },
            {
              "internalType": "bool",
              "name": "_isManualRelease",
              "type": "bool"
            }
          ],
          "name": "onIntentSettled",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_intentHash",
              "type": "bytes32"
            },
            {
              "internalType": "address",
              "name": "_escrow",
              "type": "address"
            },
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "address",
              "name": "_taker",
              "type": "address"
            },
            {
              "internalType": "bytes32",
              "name": "_paymentMethod",
              "type": "bytes32"
            },
            {
              "internalType": "uint256",
              "name": "_amount",
              "type": "uint256"
            }
          ],
          "name": "onIntentSignaled",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "owner",
          "outputs": [
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "pendingOwner",
          "outputs": [
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_intentHash",
              "type": "bytes32"
            }
          ],
          "name": "releaseMaturedChargebackIntent",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32[]",
              "name": "_intentHashes",
              "type": "bytes32[]"
            }
          ],
          "name": "releaseMaturedChargebackIntents",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "renounceOwnership",
          "outputs": [],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bool",
              "name": "_isPaused",
              "type": "bool"
            }
          ],
          "name": "setAdmissionsPaused",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_escrow",
              "type": "address"
            },
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "bool",
              "name": "_isEnabled",
              "type": "bool"
            }
          ],
          "name": "setChargebackEnabled",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_verifier",
              "type": "address"
            }
          ],
          "name": "setChargebackVerifier",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_hook",
              "type": "address"
            },
            {
              "internalType": "bool",
              "name": "_isAuthorized",
              "type": "bool"
            }
          ],
          "name": "setLifecycleHookAuthorization",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_paymentMethod",
              "type": "bytes32"
            },
            {
              "internalType": "uint64",
              "name": "_riskWindow",
              "type": "uint64"
            }
          ],
          "name": "setRiskWindow",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "stakeVault",
          "outputs": [
            {
              "internalType": "contract IStakeVault",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "components": [
                {
                  "internalType": "bytes32",
                  "name": "intentHash",
                  "type": "bytes32"
                },
                {
                  "internalType": "bytes32",
                  "name": "dataHash",
                  "type": "bytes32"
                },
                {
                  "internalType": "bytes[]",
                  "name": "signatures",
                  "type": "bytes[]"
                },
                {
                  "internalType": "bytes",
                  "name": "data",
                  "type": "bytes"
                }
              ],
              "internalType": "struct IChargebackVerifier.ChargebackAttestation",
              "name": "_attestation",
              "type": "tuple"
            }
          ],
          "name": "submitChargeback",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "newOwner",
              "type": "address"
            }
          ],
          "name": "transferOwnership",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        }
      ]
    },
    "ChargebackVerifier": {
      "address": "0x6b7b729826363716F5FCC570709342043932eEfb",
      "abi": [
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_owner",
              "type": "address"
            },
            {
              "internalType": "contract INullifierRegistryV2",
              "name": "_nullifierRegistry",
              "type": "address"
            },
            {
              "internalType": "contract IAttestationVerifier",
              "name": "_attestationVerifier",
              "type": "address"
            }
          ],
          "stateMutability": "nonpayable",
          "type": "constructor"
        },
        {
          "inputs": [],
          "name": "AttestationVerificationFailed",
          "type": "error"
        },
        {
          "inputs": [],
          "name": "InvalidAttestation",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "dependency",
              "type": "address"
            }
          ],
          "name": "InvalidContract",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "intentHash",
              "type": "bytes32"
            },
            {
              "internalType": "bytes32",
              "name": "nullifier",
              "type": "bytes32"
            }
          ],
          "name": "InvalidPaymentBinding",
          "type": "error"
        },
        {
          "inputs": [],
          "name": "InvalidShortString",
          "type": "error"
        },
        {
          "inputs": [],
          "name": "OwnershipRenunciationDisabled",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "string",
              "name": "str",
              "type": "string"
            }
          ],
          "name": "StringTooLong",
          "type": "error"
        },
        {
          "inputs": [],
          "name": "ZeroAddress",
          "type": "error"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "previousVerifier",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "newVerifier",
              "type": "address"
            }
          ],
          "name": "AttestationVerifierUpdated",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [],
          "name": "EIP712DomainChanged",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "previousOwner",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "newOwner",
              "type": "address"
            }
          ],
          "name": "OwnershipTransferStarted",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "previousOwner",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "newOwner",
              "type": "address"
            }
          ],
          "name": "OwnershipTransferred",
          "type": "event"
        },
        {
          "inputs": [],
          "name": "CHARGEBACK_ATTESTATION_TYPEHASH",
          "outputs": [
            {
              "internalType": "bytes32",
              "name": "",
              "type": "bytes32"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "acceptOwnership",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "attestationVerifier",
          "outputs": [
            {
              "internalType": "contract IAttestationVerifier",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "eip712Domain",
          "outputs": [
            {
              "internalType": "bytes1",
              "name": "fields",
              "type": "bytes1"
            },
            {
              "internalType": "string",
              "name": "name",
              "type": "string"
            },
            {
              "internalType": "string",
              "name": "version",
              "type": "string"
            },
            {
              "internalType": "uint256",
              "name": "chainId",
              "type": "uint256"
            },
            {
              "internalType": "address",
              "name": "verifyingContract",
              "type": "address"
            },
            {
              "internalType": "bytes32",
              "name": "salt",
              "type": "bytes32"
            },
            {
              "internalType": "uint256[]",
              "name": "extensions",
              "type": "uint256[]"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "components": [
                {
                  "internalType": "bytes32",
                  "name": "intentHash",
                  "type": "bytes32"
                },
                {
                  "internalType": "bytes32",
                  "name": "dataHash",
                  "type": "bytes32"
                },
                {
                  "internalType": "bytes[]",
                  "name": "signatures",
                  "type": "bytes[]"
                },
                {
                  "internalType": "bytes",
                  "name": "data",
                  "type": "bytes"
                }
              ],
              "internalType": "struct IChargebackVerifier.ChargebackAttestation",
              "name": "_attestation",
              "type": "tuple"
            }
          ],
          "name": "hashChargebackAttestation",
          "outputs": [
            {
              "internalType": "bytes32",
              "name": "",
              "type": "bytes32"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "nullifierRegistry",
          "outputs": [
            {
              "internalType": "contract INullifierRegistryV2",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "owner",
          "outputs": [
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "pendingOwner",
          "outputs": [
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "renounceOwnership",
          "outputs": [],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_verifier",
              "type": "address"
            }
          ],
          "name": "setAttestationVerifier",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "newOwner",
              "type": "address"
            }
          ],
          "name": "transferOwnership",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "components": [
                {
                  "internalType": "bytes32",
                  "name": "intentHash",
                  "type": "bytes32"
                },
                {
                  "internalType": "bytes32",
                  "name": "dataHash",
                  "type": "bytes32"
                },
                {
                  "internalType": "bytes[]",
                  "name": "signatures",
                  "type": "bytes[]"
                },
                {
                  "internalType": "bytes",
                  "name": "data",
                  "type": "bytes"
                }
              ],
              "internalType": "struct IChargebackVerifier.ChargebackAttestation",
              "name": "_attestation",
              "type": "tuple"
            },
            {
              "internalType": "bytes32",
              "name": "_paymentMethod",
              "type": "bytes32"
            },
            {
              "internalType": "bool",
              "name": "_isManualRelease",
              "type": "bool"
            }
          ],
          "name": "verifyChargeback",
          "outputs": [
            {
              "internalType": "bytes32",
              "name": "disputeId",
              "type": "bytes32"
            },
            {
              "internalType": "bytes32",
              "name": "disputeNullifier",
              "type": "bytes32"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        }
      ]
    },
    "Escrow": {
      "address": "0x5C2a8D9246777eE4501B6C426a8B8C7635C7b5b5",
      "abi": [
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_owner",
              "type": "address"
            },
            {
              "internalType": "uint256",
              "name": "_chainId",
              "type": "uint256"
            },
            {
              "internalType": "address",
              "name": "_paymentVerifierRegistry",
              "type": "address"
            },
            {
              "internalType": "address",
              "name": "_dustRecipient",
              "type": "address"
            },
            {
              "internalType": "uint256",
              "name": "_dustThreshold",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "_maxIntentsPerDeposit",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "_intentExpirationPeriod",
              "type": "uint256"
            }
          ],
          "stateMutability": "nonpayable",
          "type": "constructor"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "amount",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "max",
              "type": "uint256"
            }
          ],
          "name": "AmountAboveMax",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "amount",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "min",
              "type": "uint256"
            }
          ],
          "name": "AmountBelowMin",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "requested",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "available",
              "type": "uint256"
            }
          ],
          "name": "AmountExceedsAvailable",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "length1",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "length2",
              "type": "uint256"
            }
          ],
          "name": "ArrayLengthMismatch",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "paymentMethod",
              "type": "bytes32"
            },
            {
              "internalType": "bytes32",
              "name": "currency",
              "type": "bytes32"
            }
          ],
          "name": "CurrencyAlreadyExists",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "paymentMethod",
              "type": "bytes32"
            },
            {
              "internalType": "bytes32",
              "name": "currency",
              "type": "bytes32"
            }
          ],
          "name": "CurrencyNotFound",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "paymentMethod",
              "type": "bytes32"
            },
            {
              "internalType": "bytes32",
              "name": "currency",
              "type": "bytes32"
            }
          ],
          "name": "CurrencyNotSupported",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            }
          ],
          "name": "DelegateNotFound",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "internalType": "bool",
              "name": "currentState",
              "type": "bool"
            }
          ],
          "name": "DepositAlreadyInState",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            }
          ],
          "name": "DepositNotAcceptingIntents",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            }
          ],
          "name": "DepositNotFound",
          "type": "error"
        },
        {
          "inputs": [],
          "name": "EmptyPayeeDetails",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "available",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "required",
              "type": "uint256"
            }
          ],
          "name": "InsufficientDepositLiquidity",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "internalType": "bytes32",
              "name": "intentHash",
              "type": "bytes32"
            }
          ],
          "name": "IntentAlreadyExists",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "intentHash",
              "type": "bytes32"
            }
          ],
          "name": "IntentNotFound",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "min",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "max",
              "type": "uint256"
            }
          ],
          "name": "InvalidRange",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "current",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "max",
              "type": "uint256"
            }
          ],
          "name": "MaxIntentsExceeded",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "internalType": "bytes32",
              "name": "paymentMethod",
              "type": "bytes32"
            }
          ],
          "name": "PaymentMethodAlreadyExists",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "internalType": "bytes32",
              "name": "paymentMethod",
              "type": "bytes32"
            }
          ],
          "name": "PaymentMethodNotActive",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "internalType": "bytes32",
              "name": "paymentMethod",
              "type": "bytes32"
            }
          ],
          "name": "PaymentMethodNotListed",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "paymentMethod",
              "type": "bytes32"
            }
          ],
          "name": "PaymentMethodNotWhitelisted",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "caller",
              "type": "address"
            },
            {
              "internalType": "address",
              "name": "authorized",
              "type": "address"
            }
          ],
          "name": "UnauthorizedCaller",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "caller",
              "type": "address"
            },
            {
              "internalType": "address",
              "name": "owner",
              "type": "address"
            },
            {
              "internalType": "address",
              "name": "delegate",
              "type": "address"
            }
          ],
          "name": "UnauthorizedCallerOrDelegate",
          "type": "error"
        },
        {
          "inputs": [],
          "name": "ZeroAddress",
          "type": "error"
        },
        {
          "inputs": [],
          "name": "ZeroConversionRate",
          "type": "error"
        },
        {
          "inputs": [],
          "name": "ZeroMinValue",
          "type": "error"
        },
        {
          "inputs": [],
          "name": "ZeroValue",
          "type": "error"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "indexed": false,
              "internalType": "bool",
              "name": "acceptingIntents",
              "type": "bool"
            }
          ],
          "name": "DepositAcceptingIntentsUpdated",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "indexed": false,
              "internalType": "address",
              "name": "depositor",
              "type": "address"
            }
          ],
          "name": "DepositClosed",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "paymentMethod",
              "type": "bytes32"
            },
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "currency",
              "type": "bytes32"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "minConversionRate",
              "type": "uint256"
            }
          ],
          "name": "DepositCurrencyAdded",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "depositor",
              "type": "address"
            }
          ],
          "name": "DepositDelegateRemoved",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "depositor",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "delegate",
              "type": "address"
            }
          ],
          "name": "DepositDelegateSet",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "depositor",
              "type": "address"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "amount",
              "type": "uint256"
            }
          ],
          "name": "DepositFundsAdded",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "components": [
                {
                  "internalType": "uint256",
                  "name": "min",
                  "type": "uint256"
                },
                {
                  "internalType": "uint256",
                  "name": "max",
                  "type": "uint256"
                }
              ],
              "indexed": false,
              "internalType": "struct IEscrow.Range",
              "name": "intentAmountRange",
              "type": "tuple"
            }
          ],
          "name": "DepositIntentAmountRangeUpdated",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "paymentMethod",
              "type": "bytes32"
            },
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "currency",
              "type": "bytes32"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "newMinConversionRate",
              "type": "uint256"
            }
          ],
          "name": "DepositMinConversionRateUpdated",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "paymentMethod",
              "type": "bytes32"
            },
            {
              "indexed": false,
              "internalType": "bool",
              "name": "active",
              "type": "bool"
            }
          ],
          "name": "DepositPaymentMethodActiveUpdated",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "paymentMethod",
              "type": "bytes32"
            },
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "payeeDetails",
              "type": "bytes32"
            },
            {
              "indexed": false,
              "internalType": "address",
              "name": "intentGatingService",
              "type": "address"
            }
          ],
          "name": "DepositPaymentMethodAdded",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "depositor",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "contract IERC20",
              "name": "token",
              "type": "address"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "amount",
              "type": "uint256"
            },
            {
              "components": [
                {
                  "internalType": "uint256",
                  "name": "min",
                  "type": "uint256"
                },
                {
                  "internalType": "uint256",
                  "name": "max",
                  "type": "uint256"
                }
              ],
              "indexed": false,
              "internalType": "struct IEscrow.Range",
              "name": "intentAmountRange",
              "type": "tuple"
            },
            {
              "indexed": false,
              "internalType": "address",
              "name": "delegate",
              "type": "address"
            },
            {
              "indexed": false,
              "internalType": "address",
              "name": "intentGuardian",
              "type": "address"
            }
          ],
          "name": "DepositReceived",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "indexed": false,
              "internalType": "bool",
              "name": "retainOnEmpty",
              "type": "bool"
            }
          ],
          "name": "DepositRetainOnEmptyUpdated",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "depositor",
              "type": "address"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "amount",
              "type": "uint256"
            }
          ],
          "name": "DepositWithdrawn",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "dustAmount",
              "type": "uint256"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "dustRecipient",
              "type": "address"
            }
          ],
          "name": "DustCollected",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "dustRecipient",
              "type": "address"
            }
          ],
          "name": "DustRecipientUpdated",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "dustThreshold",
              "type": "uint256"
            }
          ],
          "name": "DustThresholdUpdated",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "intentHash",
              "type": "bytes32"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "amount",
              "type": "uint256"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "expiryTime",
              "type": "uint256"
            }
          ],
          "name": "FundsLocked",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "intentHash",
              "type": "bytes32"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "amount",
              "type": "uint256"
            }
          ],
          "name": "FundsUnlocked",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "intentHash",
              "type": "bytes32"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "unlockedAmount",
              "type": "uint256"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "transferredAmount",
              "type": "uint256"
            },
            {
              "indexed": false,
              "internalType": "address",
              "name": "to",
              "type": "address"
            }
          ],
          "name": "FundsUnlockedAndTransferred",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "intentExpirationPeriod",
              "type": "uint256"
            }
          ],
          "name": "IntentExpirationPeriodUpdated",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "intentHash",
              "type": "bytes32"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "newExpiryTime",
              "type": "uint256"
            }
          ],
          "name": "IntentExpiryExtended",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "maxIntentsPerDeposit",
              "type": "uint256"
            }
          ],
          "name": "MaxIntentsPerDepositUpdated",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "minDepositAmount",
              "type": "uint256"
            }
          ],
          "name": "MinDepositAmountSet",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "orchestrator",
              "type": "address"
            }
          ],
          "name": "OrchestratorUpdated",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "previousOwner",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "newOwner",
              "type": "address"
            }
          ],
          "name": "OwnershipTransferred",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": false,
              "internalType": "address",
              "name": "account",
              "type": "address"
            }
          ],
          "name": "Paused",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "paymentVerifierRegistry",
              "type": "address"
            }
          ],
          "name": "PaymentVerifierRegistryUpdated",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": false,
              "internalType": "address",
              "name": "account",
              "type": "address"
            }
          ],
          "name": "Unpaused",
          "type": "event"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "bytes32",
              "name": "_paymentMethod",
              "type": "bytes32"
            },
            {
              "components": [
                {
                  "internalType": "bytes32",
                  "name": "code",
                  "type": "bytes32"
                },
                {
                  "internalType": "uint256",
                  "name": "minConversionRate",
                  "type": "uint256"
                }
              ],
              "internalType": "struct IEscrow.Currency[]",
              "name": "_currencies",
              "type": "tuple[]"
            }
          ],
          "name": "addCurrencies",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "_amount",
              "type": "uint256"
            }
          ],
          "name": "addFunds",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "bytes32[]",
              "name": "_paymentMethods",
              "type": "bytes32[]"
            },
            {
              "components": [
                {
                  "internalType": "address",
                  "name": "intentGatingService",
                  "type": "address"
                },
                {
                  "internalType": "bytes32",
                  "name": "payeeDetails",
                  "type": "bytes32"
                },
                {
                  "internalType": "bytes",
                  "name": "data",
                  "type": "bytes"
                }
              ],
              "internalType": "struct IEscrow.DepositPaymentMethodData[]",
              "name": "_paymentMethodData",
              "type": "tuple[]"
            },
            {
              "components": [
                {
                  "internalType": "bytes32",
                  "name": "code",
                  "type": "bytes32"
                },
                {
                  "internalType": "uint256",
                  "name": "minConversionRate",
                  "type": "uint256"
                }
              ],
              "internalType": "struct IEscrow.Currency[][]",
              "name": "_currencies",
              "type": "tuple[][]"
            }
          ],
          "name": "addPaymentMethods",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "chainId",
          "outputs": [
            {
              "internalType": "uint256",
              "name": "",
              "type": "uint256"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "components": [
                {
                  "internalType": "contract IERC20",
                  "name": "token",
                  "type": "address"
                },
                {
                  "internalType": "uint256",
                  "name": "amount",
                  "type": "uint256"
                },
                {
                  "components": [
                    {
                      "internalType": "uint256",
                      "name": "min",
                      "type": "uint256"
                    },
                    {
                      "internalType": "uint256",
                      "name": "max",
                      "type": "uint256"
                    }
                  ],
                  "internalType": "struct IEscrow.Range",
                  "name": "intentAmountRange",
                  "type": "tuple"
                },
                {
                  "internalType": "bytes32[]",
                  "name": "paymentMethods",
                  "type": "bytes32[]"
                },
                {
                  "components": [
                    {
                      "internalType": "address",
                      "name": "intentGatingService",
                      "type": "address"
                    },
                    {
                      "internalType": "bytes32",
                      "name": "payeeDetails",
                      "type": "bytes32"
                    },
                    {
                      "internalType": "bytes",
                      "name": "data",
                      "type": "bytes"
                    }
                  ],
                  "internalType": "struct IEscrow.DepositPaymentMethodData[]",
                  "name": "paymentMethodData",
                  "type": "tuple[]"
                },
                {
                  "components": [
                    {
                      "internalType": "bytes32",
                      "name": "code",
                      "type": "bytes32"
                    },
                    {
                      "internalType": "uint256",
                      "name": "minConversionRate",
                      "type": "uint256"
                    }
                  ],
                  "internalType": "struct IEscrow.Currency[][]",
                  "name": "currencies",
                  "type": "tuple[][]"
                },
                {
                  "internalType": "address",
                  "name": "delegate",
                  "type": "address"
                },
                {
                  "internalType": "address",
                  "name": "intentGuardian",
                  "type": "address"
                },
                {
                  "internalType": "bool",
                  "name": "retainOnEmpty",
                  "type": "bool"
                }
              ],
              "internalType": "struct IEscrow.CreateDepositParams",
              "name": "_params",
              "type": "tuple"
            }
          ],
          "name": "createDeposit",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "bytes32",
              "name": "_paymentMethod",
              "type": "bytes32"
            },
            {
              "internalType": "bytes32",
              "name": "_currencyCode",
              "type": "bytes32"
            }
          ],
          "name": "deactivateCurrency",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "depositCounter",
          "outputs": [
            {
              "internalType": "uint256",
              "name": "",
              "type": "uint256"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "dustRecipient",
          "outputs": [
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "dustThreshold",
          "outputs": [
            {
              "internalType": "uint256",
              "name": "",
              "type": "uint256"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "bytes32",
              "name": "_intentHash",
              "type": "bytes32"
            },
            {
              "internalType": "uint256",
              "name": "_additionalTime",
              "type": "uint256"
            }
          ],
          "name": "extendIntentExpiry",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_account",
              "type": "address"
            }
          ],
          "name": "getAccountDeposits",
          "outputs": [
            {
              "internalType": "uint256[]",
              "name": "",
              "type": "uint256[]"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            }
          ],
          "name": "getDeposit",
          "outputs": [
            {
              "components": [
                {
                  "internalType": "address",
                  "name": "depositor",
                  "type": "address"
                },
                {
                  "internalType": "address",
                  "name": "delegate",
                  "type": "address"
                },
                {
                  "internalType": "contract IERC20",
                  "name": "token",
                  "type": "address"
                },
                {
                  "components": [
                    {
                      "internalType": "uint256",
                      "name": "min",
                      "type": "uint256"
                    },
                    {
                      "internalType": "uint256",
                      "name": "max",
                      "type": "uint256"
                    }
                  ],
                  "internalType": "struct IEscrow.Range",
                  "name": "intentAmountRange",
                  "type": "tuple"
                },
                {
                  "internalType": "bool",
                  "name": "acceptingIntents",
                  "type": "bool"
                },
                {
                  "internalType": "uint256",
                  "name": "remainingDeposits",
                  "type": "uint256"
                },
                {
                  "internalType": "uint256",
                  "name": "outstandingIntentAmount",
                  "type": "uint256"
                },
                {
                  "internalType": "address",
                  "name": "intentGuardian",
                  "type": "address"
                },
                {
                  "internalType": "bool",
                  "name": "retainOnEmpty",
                  "type": "bool"
                }
              ],
              "internalType": "struct IEscrow.Deposit",
              "name": "",
              "type": "tuple"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "bytes32",
              "name": "_paymentMethod",
              "type": "bytes32"
            }
          ],
          "name": "getDepositCurrencies",
          "outputs": [
            {
              "internalType": "bytes32[]",
              "name": "",
              "type": "bytes32[]"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "bytes32",
              "name": "_paymentMethod",
              "type": "bytes32"
            },
            {
              "internalType": "bytes32",
              "name": "_currencyCode",
              "type": "bytes32"
            }
          ],
          "name": "getDepositCurrencyListed",
          "outputs": [
            {
              "internalType": "bool",
              "name": "",
              "type": "bool"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "bytes32",
              "name": "_paymentMethod",
              "type": "bytes32"
            },
            {
              "internalType": "bytes32",
              "name": "_currencyCode",
              "type": "bytes32"
            }
          ],
          "name": "getDepositCurrencyMinRate",
          "outputs": [
            {
              "internalType": "uint256",
              "name": "",
              "type": "uint256"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "bytes32",
              "name": "_paymentMethod",
              "type": "bytes32"
            }
          ],
          "name": "getDepositGatingService",
          "outputs": [
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "bytes32",
              "name": "_intentHash",
              "type": "bytes32"
            }
          ],
          "name": "getDepositIntent",
          "outputs": [
            {
              "components": [
                {
                  "internalType": "bytes32",
                  "name": "intentHash",
                  "type": "bytes32"
                },
                {
                  "internalType": "uint256",
                  "name": "amount",
                  "type": "uint256"
                },
                {
                  "internalType": "uint256",
                  "name": "timestamp",
                  "type": "uint256"
                },
                {
                  "internalType": "uint256",
                  "name": "expiryTime",
                  "type": "uint256"
                }
              ],
              "internalType": "struct IEscrow.Intent",
              "name": "",
              "type": "tuple"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            }
          ],
          "name": "getDepositIntentHashes",
          "outputs": [
            {
              "internalType": "bytes32[]",
              "name": "",
              "type": "bytes32[]"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "bytes32",
              "name": "_paymentMethod",
              "type": "bytes32"
            }
          ],
          "name": "getDepositPaymentMethodActive",
          "outputs": [
            {
              "internalType": "bool",
              "name": "",
              "type": "bool"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "bytes32",
              "name": "_paymentMethod",
              "type": "bytes32"
            }
          ],
          "name": "getDepositPaymentMethodData",
          "outputs": [
            {
              "components": [
                {
                  "internalType": "address",
                  "name": "intentGatingService",
                  "type": "address"
                },
                {
                  "internalType": "bytes32",
                  "name": "payeeDetails",
                  "type": "bytes32"
                },
                {
                  "internalType": "bytes",
                  "name": "data",
                  "type": "bytes"
                }
              ],
              "internalType": "struct IEscrow.DepositPaymentMethodData",
              "name": "",
              "type": "tuple"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "bytes32",
              "name": "_paymentMethod",
              "type": "bytes32"
            }
          ],
          "name": "getDepositPaymentMethodListed",
          "outputs": [
            {
              "internalType": "bool",
              "name": "",
              "type": "bool"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            }
          ],
          "name": "getDepositPaymentMethods",
          "outputs": [
            {
              "internalType": "bytes32[]",
              "name": "",
              "type": "bytes32[]"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            }
          ],
          "name": "getExpiredIntents",
          "outputs": [
            {
              "internalType": "bytes32[]",
              "name": "expiredIntents",
              "type": "bytes32[]"
            },
            {
              "internalType": "uint256",
              "name": "reclaimableAmount",
              "type": "uint256"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "intentExpirationPeriod",
          "outputs": [
            {
              "internalType": "uint256",
              "name": "",
              "type": "uint256"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "bytes32",
              "name": "_intentHash",
              "type": "bytes32"
            },
            {
              "internalType": "uint256",
              "name": "_amount",
              "type": "uint256"
            }
          ],
          "name": "lockFunds",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "maxIntentsPerDeposit",
          "outputs": [
            {
              "internalType": "uint256",
              "name": "",
              "type": "uint256"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "orchestrator",
          "outputs": [
            {
              "internalType": "contract IOrchestrator",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "owner",
          "outputs": [
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "pauseEscrow",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "paused",
          "outputs": [
            {
              "internalType": "bool",
              "name": "",
              "type": "bool"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "paymentVerifierRegistry",
          "outputs": [
            {
              "internalType": "contract IPaymentVerifierRegistry",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            }
          ],
          "name": "pruneExpiredIntents",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            }
          ],
          "name": "removeDelegate",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "_amount",
              "type": "uint256"
            }
          ],
          "name": "removeFunds",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "renounceOwnership",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "bool",
              "name": "_acceptingIntents",
              "type": "bool"
            }
          ],
          "name": "setAcceptingIntents",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "bytes32",
              "name": "_paymentMethod",
              "type": "bytes32"
            },
            {
              "internalType": "bytes32",
              "name": "_fiatCurrency",
              "type": "bytes32"
            },
            {
              "internalType": "uint256",
              "name": "_newMinConversionRate",
              "type": "uint256"
            }
          ],
          "name": "setCurrencyMinRate",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "address",
              "name": "_delegate",
              "type": "address"
            }
          ],
          "name": "setDelegate",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_dustRecipient",
              "type": "address"
            }
          ],
          "name": "setDustRecipient",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_dustThreshold",
              "type": "uint256"
            }
          ],
          "name": "setDustThreshold",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_intentExpirationPeriod",
              "type": "uint256"
            }
          ],
          "name": "setIntentExpirationPeriod",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "components": [
                {
                  "internalType": "uint256",
                  "name": "min",
                  "type": "uint256"
                },
                {
                  "internalType": "uint256",
                  "name": "max",
                  "type": "uint256"
                }
              ],
              "internalType": "struct IEscrow.Range",
              "name": "_intentAmountRange",
              "type": "tuple"
            }
          ],
          "name": "setIntentRange",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_maxIntentsPerDeposit",
              "type": "uint256"
            }
          ],
          "name": "setMaxIntentsPerDeposit",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_orchestrator",
              "type": "address"
            }
          ],
          "name": "setOrchestrator",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "bytes32",
              "name": "_paymentMethod",
              "type": "bytes32"
            },
            {
              "internalType": "bool",
              "name": "_isActive",
              "type": "bool"
            }
          ],
          "name": "setPaymentMethodActive",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_paymentVerifierRegistry",
              "type": "address"
            }
          ],
          "name": "setPaymentVerifierRegistry",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "bool",
              "name": "_retainOnEmpty",
              "type": "bool"
            }
          ],
          "name": "setRetainOnEmpty",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "newOwner",
              "type": "address"
            }
          ],
          "name": "transferOwnership",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "bytes32",
              "name": "_intentHash",
              "type": "bytes32"
            },
            {
              "internalType": "uint256",
              "name": "_transferAmount",
              "type": "uint256"
            },
            {
              "internalType": "address",
              "name": "_to",
              "type": "address"
            }
          ],
          "name": "unlockAndTransferFunds",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "bytes32",
              "name": "_intentHash",
              "type": "bytes32"
            }
          ],
          "name": "unlockFunds",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "unpauseEscrow",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            }
          ],
          "name": "withdrawDeposit",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        }
      ]
    },
    "EscrowRegistry": {
      "address": "0xc545f336eC77E69bf115729acCbf2e557A00ac91",
      "abi": [
        {
          "inputs": [],
          "stateMutability": "nonpayable",
          "type": "constructor"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": false,
              "internalType": "bool",
              "name": "acceptAll",
              "type": "bool"
            }
          ],
          "name": "AcceptAllEscrowsUpdated",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "escrow",
              "type": "address"
            }
          ],
          "name": "EscrowAdded",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "escrow",
              "type": "address"
            }
          ],
          "name": "EscrowRemoved",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "previousOwner",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "newOwner",
              "type": "address"
            }
          ],
          "name": "OwnershipTransferred",
          "type": "event"
        },
        {
          "inputs": [],
          "name": "acceptAllEscrows",
          "outputs": [
            {
              "internalType": "bool",
              "name": "",
              "type": "bool"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_escrow",
              "type": "address"
            }
          ],
          "name": "addEscrow",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "",
              "type": "uint256"
            }
          ],
          "name": "escrows",
          "outputs": [
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "getWhitelistedEscrows",
          "outputs": [
            {
              "internalType": "address[]",
              "name": "",
              "type": "address[]"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "isAcceptingAllEscrows",
          "outputs": [
            {
              "internalType": "bool",
              "name": "",
              "type": "bool"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            }
          ],
          "name": "isWhitelistedEscrow",
          "outputs": [
            {
              "internalType": "bool",
              "name": "",
              "type": "bool"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "owner",
          "outputs": [
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_escrow",
              "type": "address"
            }
          ],
          "name": "removeEscrow",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "renounceOwnership",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bool",
              "name": "_acceptAll",
              "type": "bool"
            }
          ],
          "name": "setAcceptAllEscrows",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "newOwner",
              "type": "address"
            }
          ],
          "name": "transferOwnership",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        }
      ]
    },
    "EscrowV2": {
      "address": "0x77e8f808FE201075e0bD651CD46fdF239fc83265",
      "abi": [
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_owner",
              "type": "address"
            },
            {
              "internalType": "uint256",
              "name": "_chainId",
              "type": "uint256"
            },
            {
              "internalType": "address",
              "name": "_orchestratorRegistry",
              "type": "address"
            },
            {
              "internalType": "address",
              "name": "_paymentVerifierRegistry",
              "type": "address"
            },
            {
              "internalType": "address",
              "name": "_dustRecipient",
              "type": "address"
            },
            {
              "internalType": "uint256",
              "name": "_dustThreshold",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "_maxIntentsPerDeposit",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "_intentExpirationPeriod",
              "type": "uint256"
            }
          ],
          "stateMutability": "nonpayable",
          "type": "constructor"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "length",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "maxLength",
              "type": "uint256"
            }
          ],
          "name": "AdapterConfigTooLong",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "amount",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "max",
              "type": "uint256"
            }
          ],
          "name": "AmountAboveMax",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "amount",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "min",
              "type": "uint256"
            }
          ],
          "name": "AmountBelowMin",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "requested",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "available",
              "type": "uint256"
            }
          ],
          "name": "AmountExceedsAvailable",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "length1",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "length2",
              "type": "uint256"
            }
          ],
          "name": "ArrayLengthMismatch",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "depositor",
              "type": "address"
            }
          ],
          "name": "CannotDelegateToSelf",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "paymentMethod",
              "type": "bytes32"
            },
            {
              "internalType": "bytes32",
              "name": "currency",
              "type": "bytes32"
            }
          ],
          "name": "CurrencyAlreadyExists",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "paymentMethod",
              "type": "bytes32"
            },
            {
              "internalType": "bytes32",
              "name": "currency",
              "type": "bytes32"
            }
          ],
          "name": "CurrencyNotFound",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "paymentMethod",
              "type": "bytes32"
            },
            {
              "internalType": "bytes32",
              "name": "currency",
              "type": "bytes32"
            }
          ],
          "name": "CurrencyNotSupported",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            }
          ],
          "name": "DelegateNotFound",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "internalType": "bool",
              "name": "currentState",
              "type": "bool"
            }
          ],
          "name": "DepositAlreadyInState",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            }
          ],
          "name": "DepositNotAcceptingIntents",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            }
          ],
          "name": "DepositNotFound",
          "type": "error"
        },
        {
          "inputs": [],
          "name": "EmptyPayeeDetails",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "available",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "required",
              "type": "uint256"
            }
          ],
          "name": "InsufficientDepositLiquidity",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "internalType": "bytes32",
              "name": "intentHash",
              "type": "bytes32"
            }
          ],
          "name": "IntentAlreadyExists",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "intentHash",
              "type": "bytes32"
            }
          ],
          "name": "IntentNotFound",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "adapter",
              "type": "address"
            }
          ],
          "name": "InvalidOracleAdapter",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "min",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "max",
              "type": "uint256"
            }
          ],
          "name": "InvalidRange",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "rateManager",
              "type": "address"
            }
          ],
          "name": "InvalidRateManager",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "int16",
              "name": "spreadBps",
              "type": "int16"
            }
          ],
          "name": "InvalidSpread",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "current",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "max",
              "type": "uint256"
            }
          ],
          "name": "MaxIntentsExceeded",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "internalType": "bytes32",
              "name": "paymentMethod",
              "type": "bytes32"
            }
          ],
          "name": "PaymentMethodAlreadyExists",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "internalType": "bytes32",
              "name": "paymentMethod",
              "type": "bytes32"
            }
          ],
          "name": "PaymentMethodNotActive",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "internalType": "bytes32",
              "name": "paymentMethod",
              "type": "bytes32"
            }
          ],
          "name": "PaymentMethodNotListed",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "paymentMethod",
              "type": "bytes32"
            }
          ],
          "name": "PaymentMethodNotWhitelisted",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "rateManagerId",
              "type": "bytes32"
            }
          ],
          "name": "RateManagerAlreadySet",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "rateManagerId",
              "type": "bytes32"
            }
          ],
          "name": "RateManagerNotFound",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            }
          ],
          "name": "RateManagerNotSet",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "caller",
              "type": "address"
            },
            {
              "internalType": "address",
              "name": "authorized",
              "type": "address"
            }
          ],
          "name": "UnauthorizedCaller",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "caller",
              "type": "address"
            },
            {
              "internalType": "address",
              "name": "owner",
              "type": "address"
            },
            {
              "internalType": "address",
              "name": "delegate",
              "type": "address"
            }
          ],
          "name": "UnauthorizedCallerOrDelegate",
          "type": "error"
        },
        {
          "inputs": [],
          "name": "ZeroAddress",
          "type": "error"
        },
        {
          "inputs": [],
          "name": "ZeroConversionRate",
          "type": "error"
        },
        {
          "inputs": [],
          "name": "ZeroMinValue",
          "type": "error"
        },
        {
          "inputs": [],
          "name": "ZeroValue",
          "type": "error"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "indexed": false,
              "internalType": "bool",
              "name": "acceptingIntents",
              "type": "bool"
            }
          ],
          "name": "DepositAcceptingIntentsUpdated",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "indexed": false,
              "internalType": "address",
              "name": "depositor",
              "type": "address"
            }
          ],
          "name": "DepositClosed",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "paymentMethod",
              "type": "bytes32"
            },
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "currency",
              "type": "bytes32"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "minConversionRate",
              "type": "uint256"
            }
          ],
          "name": "DepositCurrencyAdded",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "depositor",
              "type": "address"
            }
          ],
          "name": "DepositDelegateRemoved",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "depositor",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "delegate",
              "type": "address"
            }
          ],
          "name": "DepositDelegateSet",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "depositor",
              "type": "address"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "amount",
              "type": "uint256"
            }
          ],
          "name": "DepositFundsAdded",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "components": [
                {
                  "internalType": "uint256",
                  "name": "min",
                  "type": "uint256"
                },
                {
                  "internalType": "uint256",
                  "name": "max",
                  "type": "uint256"
                }
              ],
              "indexed": false,
              "internalType": "struct IEscrowV2.Range",
              "name": "intentAmountRange",
              "type": "tuple"
            }
          ],
          "name": "DepositIntentAmountRangeUpdated",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "paymentMethod",
              "type": "bytes32"
            },
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "currency",
              "type": "bytes32"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "newMinConversionRate",
              "type": "uint256"
            }
          ],
          "name": "DepositMinConversionRateUpdated",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "paymentMethod",
              "type": "bytes32"
            },
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "currencyCode",
              "type": "bytes32"
            }
          ],
          "name": "DepositOracleRateConfigRemoved",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "paymentMethod",
              "type": "bytes32"
            },
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "currencyCode",
              "type": "bytes32"
            },
            {
              "indexed": false,
              "internalType": "address",
              "name": "adapter",
              "type": "address"
            },
            {
              "indexed": false,
              "internalType": "bytes",
              "name": "adapterConfig",
              "type": "bytes"
            },
            {
              "indexed": false,
              "internalType": "int16",
              "name": "spreadBps",
              "type": "int16"
            },
            {
              "indexed": false,
              "internalType": "uint32",
              "name": "maxStaleness",
              "type": "uint32"
            }
          ],
          "name": "DepositOracleRateConfigSet",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "paymentMethod",
              "type": "bytes32"
            },
            {
              "indexed": false,
              "internalType": "bool",
              "name": "active",
              "type": "bool"
            }
          ],
          "name": "DepositPaymentMethodActiveUpdated",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "paymentMethod",
              "type": "bytes32"
            },
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "payeeDetails",
              "type": "bytes32"
            },
            {
              "indexed": false,
              "internalType": "address",
              "name": "intentGatingService",
              "type": "address"
            }
          ],
          "name": "DepositPaymentMethodAdded",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "rateManager",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "rateManagerId",
              "type": "bytes32"
            }
          ],
          "name": "DepositRateManagerCleared",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "rateManager",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "rateManagerId",
              "type": "bytes32"
            }
          ],
          "name": "DepositRateManagerSet",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "depositor",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "contract IERC20",
              "name": "token",
              "type": "address"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "amount",
              "type": "uint256"
            },
            {
              "components": [
                {
                  "internalType": "uint256",
                  "name": "min",
                  "type": "uint256"
                },
                {
                  "internalType": "uint256",
                  "name": "max",
                  "type": "uint256"
                }
              ],
              "indexed": false,
              "internalType": "struct IEscrowV2.Range",
              "name": "intentAmountRange",
              "type": "tuple"
            },
            {
              "indexed": false,
              "internalType": "address",
              "name": "delegate",
              "type": "address"
            },
            {
              "indexed": false,
              "internalType": "address",
              "name": "intentGuardian",
              "type": "address"
            }
          ],
          "name": "DepositReceived",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "indexed": false,
              "internalType": "bool",
              "name": "retainOnEmpty",
              "type": "bool"
            }
          ],
          "name": "DepositRetainOnEmptyUpdated",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "depositor",
              "type": "address"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "amount",
              "type": "uint256"
            }
          ],
          "name": "DepositWithdrawn",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "dustAmount",
              "type": "uint256"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "dustRecipient",
              "type": "address"
            }
          ],
          "name": "DustCollected",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "dustRecipient",
              "type": "address"
            }
          ],
          "name": "DustRecipientUpdated",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "dustThreshold",
              "type": "uint256"
            }
          ],
          "name": "DustThresholdUpdated",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "intentHash",
              "type": "bytes32"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "amount",
              "type": "uint256"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "expiryTime",
              "type": "uint256"
            }
          ],
          "name": "FundsLocked",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "intentHash",
              "type": "bytes32"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "amount",
              "type": "uint256"
            }
          ],
          "name": "FundsUnlocked",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "intentHash",
              "type": "bytes32"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "unlockedAmount",
              "type": "uint256"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "transferredAmount",
              "type": "uint256"
            },
            {
              "indexed": false,
              "internalType": "address",
              "name": "to",
              "type": "address"
            }
          ],
          "name": "FundsUnlockedAndTransferred",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "intentExpirationPeriod",
              "type": "uint256"
            }
          ],
          "name": "IntentExpirationPeriodUpdated",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "intentHash",
              "type": "bytes32"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "newExpiryTime",
              "type": "uint256"
            }
          ],
          "name": "IntentExpiryExtended",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "maxIntentsPerDeposit",
              "type": "uint256"
            }
          ],
          "name": "MaxIntentsPerDepositUpdated",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "minDepositAmount",
              "type": "uint256"
            }
          ],
          "name": "MinDepositAmountSet",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "orchestratorRegistry",
              "type": "address"
            }
          ],
          "name": "OrchestratorRegistryUpdated",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "orchestrator",
              "type": "address"
            }
          ],
          "name": "OrchestratorUpdated",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "previousOwner",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "newOwner",
              "type": "address"
            }
          ],
          "name": "OwnershipTransferred",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": false,
              "internalType": "address",
              "name": "account",
              "type": "address"
            }
          ],
          "name": "Paused",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "paymentVerifierRegistry",
              "type": "address"
            }
          ],
          "name": "PaymentVerifierRegistryUpdated",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": false,
              "internalType": "address",
              "name": "account",
              "type": "address"
            }
          ],
          "name": "Unpaused",
          "type": "event"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "bytes32",
              "name": "_paymentMethod",
              "type": "bytes32"
            },
            {
              "components": [
                {
                  "internalType": "bytes32",
                  "name": "code",
                  "type": "bytes32"
                },
                {
                  "internalType": "uint256",
                  "name": "minConversionRate",
                  "type": "uint256"
                },
                {
                  "components": [
                    {
                      "internalType": "address",
                      "name": "adapter",
                      "type": "address"
                    },
                    {
                      "internalType": "bytes",
                      "name": "adapterConfig",
                      "type": "bytes"
                    },
                    {
                      "internalType": "int16",
                      "name": "spreadBps",
                      "type": "int16"
                    },
                    {
                      "internalType": "uint32",
                      "name": "maxStaleness",
                      "type": "uint32"
                    }
                  ],
                  "internalType": "struct IEscrowV2.OracleRateConfig",
                  "name": "oracleRateConfig",
                  "type": "tuple"
                }
              ],
              "internalType": "struct IEscrowV2.Currency[]",
              "name": "_currencies",
              "type": "tuple[]"
            }
          ],
          "name": "addCurrencies",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "_amount",
              "type": "uint256"
            }
          ],
          "name": "addFunds",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "bytes32[]",
              "name": "_paymentMethods",
              "type": "bytes32[]"
            },
            {
              "components": [
                {
                  "internalType": "address",
                  "name": "intentGatingService",
                  "type": "address"
                },
                {
                  "internalType": "bytes32",
                  "name": "payeeDetails",
                  "type": "bytes32"
                },
                {
                  "internalType": "bytes",
                  "name": "data",
                  "type": "bytes"
                }
              ],
              "internalType": "struct IEscrowV2.DepositPaymentMethodData[]",
              "name": "_paymentMethodData",
              "type": "tuple[]"
            },
            {
              "components": [
                {
                  "internalType": "bytes32",
                  "name": "code",
                  "type": "bytes32"
                },
                {
                  "internalType": "uint256",
                  "name": "minConversionRate",
                  "type": "uint256"
                },
                {
                  "components": [
                    {
                      "internalType": "address",
                      "name": "adapter",
                      "type": "address"
                    },
                    {
                      "internalType": "bytes",
                      "name": "adapterConfig",
                      "type": "bytes"
                    },
                    {
                      "internalType": "int16",
                      "name": "spreadBps",
                      "type": "int16"
                    },
                    {
                      "internalType": "uint32",
                      "name": "maxStaleness",
                      "type": "uint32"
                    }
                  ],
                  "internalType": "struct IEscrowV2.OracleRateConfig",
                  "name": "oracleRateConfig",
                  "type": "tuple"
                }
              ],
              "internalType": "struct IEscrowV2.Currency[][]",
              "name": "_currencies",
              "type": "tuple[][]"
            }
          ],
          "name": "addPaymentMethods",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "chainId",
          "outputs": [
            {
              "internalType": "uint256",
              "name": "",
              "type": "uint256"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            }
          ],
          "name": "clearRateManager",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "components": [
                {
                  "internalType": "contract IERC20",
                  "name": "token",
                  "type": "address"
                },
                {
                  "internalType": "uint256",
                  "name": "amount",
                  "type": "uint256"
                },
                {
                  "components": [
                    {
                      "internalType": "uint256",
                      "name": "min",
                      "type": "uint256"
                    },
                    {
                      "internalType": "uint256",
                      "name": "max",
                      "type": "uint256"
                    }
                  ],
                  "internalType": "struct IEscrowV2.Range",
                  "name": "intentAmountRange",
                  "type": "tuple"
                },
                {
                  "internalType": "bytes32[]",
                  "name": "paymentMethods",
                  "type": "bytes32[]"
                },
                {
                  "components": [
                    {
                      "internalType": "address",
                      "name": "intentGatingService",
                      "type": "address"
                    },
                    {
                      "internalType": "bytes32",
                      "name": "payeeDetails",
                      "type": "bytes32"
                    },
                    {
                      "internalType": "bytes",
                      "name": "data",
                      "type": "bytes"
                    }
                  ],
                  "internalType": "struct IEscrowV2.DepositPaymentMethodData[]",
                  "name": "paymentMethodData",
                  "type": "tuple[]"
                },
                {
                  "components": [
                    {
                      "internalType": "bytes32",
                      "name": "code",
                      "type": "bytes32"
                    },
                    {
                      "internalType": "uint256",
                      "name": "minConversionRate",
                      "type": "uint256"
                    },
                    {
                      "components": [
                        {
                          "internalType": "address",
                          "name": "adapter",
                          "type": "address"
                        },
                        {
                          "internalType": "bytes",
                          "name": "adapterConfig",
                          "type": "bytes"
                        },
                        {
                          "internalType": "int16",
                          "name": "spreadBps",
                          "type": "int16"
                        },
                        {
                          "internalType": "uint32",
                          "name": "maxStaleness",
                          "type": "uint32"
                        }
                      ],
                      "internalType": "struct IEscrowV2.OracleRateConfig",
                      "name": "oracleRateConfig",
                      "type": "tuple"
                    }
                  ],
                  "internalType": "struct IEscrowV2.Currency[][]",
                  "name": "currencies",
                  "type": "tuple[][]"
                },
                {
                  "internalType": "address",
                  "name": "delegate",
                  "type": "address"
                },
                {
                  "internalType": "address",
                  "name": "intentGuardian",
                  "type": "address"
                },
                {
                  "internalType": "bool",
                  "name": "retainOnEmpty",
                  "type": "bool"
                }
              ],
              "internalType": "struct IEscrowV2.CreateDepositParams",
              "name": "_params",
              "type": "tuple"
            }
          ],
          "name": "createDeposit",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "bytes32[]",
              "name": "_paymentMethods",
              "type": "bytes32[]"
            },
            {
              "internalType": "bytes32[][]",
              "name": "_currencyCodes",
              "type": "bytes32[][]"
            }
          ],
          "name": "deactivateCurrenciesBatch",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "bytes32",
              "name": "_paymentMethod",
              "type": "bytes32"
            },
            {
              "internalType": "bytes32",
              "name": "_currencyCode",
              "type": "bytes32"
            }
          ],
          "name": "deactivateCurrency",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "depositCounter",
          "outputs": [
            {
              "internalType": "uint256",
              "name": "",
              "type": "uint256"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_depositor",
              "type": "address"
            },
            {
              "components": [
                {
                  "internalType": "contract IERC20",
                  "name": "token",
                  "type": "address"
                },
                {
                  "internalType": "uint256",
                  "name": "amount",
                  "type": "uint256"
                },
                {
                  "components": [
                    {
                      "internalType": "uint256",
                      "name": "min",
                      "type": "uint256"
                    },
                    {
                      "internalType": "uint256",
                      "name": "max",
                      "type": "uint256"
                    }
                  ],
                  "internalType": "struct IEscrowV2.Range",
                  "name": "intentAmountRange",
                  "type": "tuple"
                },
                {
                  "internalType": "bytes32[]",
                  "name": "paymentMethods",
                  "type": "bytes32[]"
                },
                {
                  "components": [
                    {
                      "internalType": "address",
                      "name": "intentGatingService",
                      "type": "address"
                    },
                    {
                      "internalType": "bytes32",
                      "name": "payeeDetails",
                      "type": "bytes32"
                    },
                    {
                      "internalType": "bytes",
                      "name": "data",
                      "type": "bytes"
                    }
                  ],
                  "internalType": "struct IEscrowV2.DepositPaymentMethodData[]",
                  "name": "paymentMethodData",
                  "type": "tuple[]"
                },
                {
                  "components": [
                    {
                      "internalType": "bytes32",
                      "name": "code",
                      "type": "bytes32"
                    },
                    {
                      "internalType": "uint256",
                      "name": "minConversionRate",
                      "type": "uint256"
                    },
                    {
                      "components": [
                        {
                          "internalType": "address",
                          "name": "adapter",
                          "type": "address"
                        },
                        {
                          "internalType": "bytes",
                          "name": "adapterConfig",
                          "type": "bytes"
                        },
                        {
                          "internalType": "int16",
                          "name": "spreadBps",
                          "type": "int16"
                        },
                        {
                          "internalType": "uint32",
                          "name": "maxStaleness",
                          "type": "uint32"
                        }
                      ],
                      "internalType": "struct IEscrowV2.OracleRateConfig",
                      "name": "oracleRateConfig",
                      "type": "tuple"
                    }
                  ],
                  "internalType": "struct IEscrowV2.Currency[][]",
                  "name": "currencies",
                  "type": "tuple[][]"
                },
                {
                  "internalType": "address",
                  "name": "delegate",
                  "type": "address"
                },
                {
                  "internalType": "address",
                  "name": "intentGuardian",
                  "type": "address"
                },
                {
                  "internalType": "bool",
                  "name": "retainOnEmpty",
                  "type": "bool"
                }
              ],
              "internalType": "struct IEscrowV2.CreateDepositParams",
              "name": "_params",
              "type": "tuple"
            }
          ],
          "name": "depositTo",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "dustRecipient",
          "outputs": [
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "dustThreshold",
          "outputs": [
            {
              "internalType": "uint256",
              "name": "",
              "type": "uint256"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "bytes32",
              "name": "_intentHash",
              "type": "bytes32"
            },
            {
              "internalType": "uint256",
              "name": "_additionalTime",
              "type": "uint256"
            }
          ],
          "name": "extendIntentExpiry",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            }
          ],
          "name": "getDeposit",
          "outputs": [
            {
              "components": [
                {
                  "internalType": "address",
                  "name": "depositor",
                  "type": "address"
                },
                {
                  "internalType": "address",
                  "name": "delegate",
                  "type": "address"
                },
                {
                  "internalType": "contract IERC20",
                  "name": "token",
                  "type": "address"
                },
                {
                  "components": [
                    {
                      "internalType": "uint256",
                      "name": "min",
                      "type": "uint256"
                    },
                    {
                      "internalType": "uint256",
                      "name": "max",
                      "type": "uint256"
                    }
                  ],
                  "internalType": "struct IEscrowV2.Range",
                  "name": "intentAmountRange",
                  "type": "tuple"
                },
                {
                  "internalType": "bool",
                  "name": "acceptingIntents",
                  "type": "bool"
                },
                {
                  "internalType": "uint256",
                  "name": "remainingDeposits",
                  "type": "uint256"
                },
                {
                  "internalType": "uint256",
                  "name": "outstandingIntentAmount",
                  "type": "uint256"
                },
                {
                  "internalType": "address",
                  "name": "intentGuardian",
                  "type": "address"
                },
                {
                  "internalType": "bool",
                  "name": "retainOnEmpty",
                  "type": "bool"
                }
              ],
              "internalType": "struct IEscrowV2.Deposit",
              "name": "",
              "type": "tuple"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "bytes32",
              "name": "_paymentMethod",
              "type": "bytes32"
            }
          ],
          "name": "getDepositCurrencies",
          "outputs": [
            {
              "internalType": "bytes32[]",
              "name": "",
              "type": "bytes32[]"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "bytes32",
              "name": "_paymentMethod",
              "type": "bytes32"
            },
            {
              "internalType": "bytes32",
              "name": "_currencyCode",
              "type": "bytes32"
            }
          ],
          "name": "getDepositCurrencyListed",
          "outputs": [
            {
              "internalType": "bool",
              "name": "",
              "type": "bool"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "bytes32",
              "name": "_paymentMethod",
              "type": "bytes32"
            },
            {
              "internalType": "bytes32",
              "name": "_currencyCode",
              "type": "bytes32"
            }
          ],
          "name": "getDepositCurrencyMinRate",
          "outputs": [
            {
              "internalType": "uint256",
              "name": "",
              "type": "uint256"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "bytes32",
              "name": "_paymentMethod",
              "type": "bytes32"
            }
          ],
          "name": "getDepositGatingService",
          "outputs": [
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "bytes32",
              "name": "_intentHash",
              "type": "bytes32"
            }
          ],
          "name": "getDepositIntent",
          "outputs": [
            {
              "components": [
                {
                  "internalType": "bytes32",
                  "name": "intentHash",
                  "type": "bytes32"
                },
                {
                  "internalType": "uint256",
                  "name": "amount",
                  "type": "uint256"
                },
                {
                  "internalType": "uint256",
                  "name": "timestamp",
                  "type": "uint256"
                },
                {
                  "internalType": "uint256",
                  "name": "expiryTime",
                  "type": "uint256"
                }
              ],
              "internalType": "struct IEscrowV2.Intent",
              "name": "",
              "type": "tuple"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            }
          ],
          "name": "getDepositIntentHashes",
          "outputs": [
            {
              "internalType": "bytes32[]",
              "name": "",
              "type": "bytes32[]"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "bytes32",
              "name": "_paymentMethod",
              "type": "bytes32"
            },
            {
              "internalType": "bytes32",
              "name": "_currencyCode",
              "type": "bytes32"
            }
          ],
          "name": "getDepositOracleRateConfig",
          "outputs": [
            {
              "components": [
                {
                  "internalType": "address",
                  "name": "adapter",
                  "type": "address"
                },
                {
                  "internalType": "bytes",
                  "name": "adapterConfig",
                  "type": "bytes"
                },
                {
                  "internalType": "int16",
                  "name": "spreadBps",
                  "type": "int16"
                },
                {
                  "internalType": "uint32",
                  "name": "maxStaleness",
                  "type": "uint32"
                }
              ],
              "internalType": "struct IEscrowV2.OracleRateConfig",
              "name": "",
              "type": "tuple"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "bytes32",
              "name": "_paymentMethod",
              "type": "bytes32"
            }
          ],
          "name": "getDepositPaymentMethodActive",
          "outputs": [
            {
              "internalType": "bool",
              "name": "",
              "type": "bool"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "bytes32",
              "name": "_paymentMethod",
              "type": "bytes32"
            }
          ],
          "name": "getDepositPaymentMethodData",
          "outputs": [
            {
              "components": [
                {
                  "internalType": "address",
                  "name": "intentGatingService",
                  "type": "address"
                },
                {
                  "internalType": "bytes32",
                  "name": "payeeDetails",
                  "type": "bytes32"
                },
                {
                  "internalType": "bytes",
                  "name": "data",
                  "type": "bytes"
                }
              ],
              "internalType": "struct IEscrowV2.DepositPaymentMethodData",
              "name": "",
              "type": "tuple"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "bytes32",
              "name": "_paymentMethod",
              "type": "bytes32"
            }
          ],
          "name": "getDepositPaymentMethodListed",
          "outputs": [
            {
              "internalType": "bool",
              "name": "",
              "type": "bool"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            }
          ],
          "name": "getDepositPaymentMethods",
          "outputs": [
            {
              "internalType": "bytes32[]",
              "name": "",
              "type": "bytes32[]"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            }
          ],
          "name": "getDepositRateManager",
          "outputs": [
            {
              "internalType": "address",
              "name": "rateManager",
              "type": "address"
            },
            {
              "internalType": "bytes32",
              "name": "rateManagerId",
              "type": "bytes32"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "bytes32",
              "name": "_paymentMethod",
              "type": "bytes32"
            },
            {
              "internalType": "bytes32",
              "name": "_currencyCode",
              "type": "bytes32"
            }
          ],
          "name": "getEffectiveRate",
          "outputs": [
            {
              "internalType": "uint256",
              "name": "",
              "type": "uint256"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            }
          ],
          "name": "getExpiredIntents",
          "outputs": [
            {
              "internalType": "bytes32[]",
              "name": "expiredIntents",
              "type": "bytes32[]"
            },
            {
              "internalType": "uint256",
              "name": "reclaimableAmount",
              "type": "uint256"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            }
          ],
          "name": "getManagerFee",
          "outputs": [
            {
              "internalType": "address",
              "name": "recipient",
              "type": "address"
            },
            {
              "internalType": "uint256",
              "name": "fee",
              "type": "uint256"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "intentExpirationPeriod",
          "outputs": [
            {
              "internalType": "uint256",
              "name": "",
              "type": "uint256"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "bytes32",
              "name": "_intentHash",
              "type": "bytes32"
            },
            {
              "internalType": "uint256",
              "name": "_amount",
              "type": "uint256"
            }
          ],
          "name": "lockFunds",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "maxIntentsPerDeposit",
          "outputs": [
            {
              "internalType": "uint256",
              "name": "",
              "type": "uint256"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "orchestratorRegistry",
          "outputs": [
            {
              "internalType": "contract IOrchestratorRegistry",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "owner",
          "outputs": [
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "pauseEscrow",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "paused",
          "outputs": [
            {
              "internalType": "bool",
              "name": "",
              "type": "bool"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "paymentVerifierRegistry",
          "outputs": [
            {
              "internalType": "contract IPaymentVerifierRegistry",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            }
          ],
          "name": "pruneExpiredIntents",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            }
          ],
          "name": "removeDelegate",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "_amount",
              "type": "uint256"
            }
          ],
          "name": "removeFunds",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "bytes32",
              "name": "_paymentMethod",
              "type": "bytes32"
            },
            {
              "internalType": "bytes32",
              "name": "_currencyCode",
              "type": "bytes32"
            }
          ],
          "name": "removeOracleRateConfig",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "renounceOwnership",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "bool",
              "name": "_acceptingIntents",
              "type": "bool"
            }
          ],
          "name": "setAcceptingIntents",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "bytes32",
              "name": "_paymentMethod",
              "type": "bytes32"
            },
            {
              "internalType": "bytes32",
              "name": "_fiatCurrency",
              "type": "bytes32"
            },
            {
              "internalType": "uint256",
              "name": "_newMinConversionRate",
              "type": "uint256"
            }
          ],
          "name": "setCurrencyMinRate",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "address",
              "name": "_delegate",
              "type": "address"
            }
          ],
          "name": "setDelegate",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_dustRecipient",
              "type": "address"
            }
          ],
          "name": "setDustRecipient",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_dustThreshold",
              "type": "uint256"
            }
          ],
          "name": "setDustThreshold",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_intentExpirationPeriod",
              "type": "uint256"
            }
          ],
          "name": "setIntentExpirationPeriod",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "components": [
                {
                  "internalType": "uint256",
                  "name": "min",
                  "type": "uint256"
                },
                {
                  "internalType": "uint256",
                  "name": "max",
                  "type": "uint256"
                }
              ],
              "internalType": "struct IEscrowV2.Range",
              "name": "_intentAmountRange",
              "type": "tuple"
            }
          ],
          "name": "setIntentRange",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_maxIntentsPerDeposit",
              "type": "uint256"
            }
          ],
          "name": "setMaxIntentsPerDeposit",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "bytes32",
              "name": "_paymentMethod",
              "type": "bytes32"
            },
            {
              "internalType": "bytes32",
              "name": "_currencyCode",
              "type": "bytes32"
            },
            {
              "components": [
                {
                  "internalType": "address",
                  "name": "adapter",
                  "type": "address"
                },
                {
                  "internalType": "bytes",
                  "name": "adapterConfig",
                  "type": "bytes"
                },
                {
                  "internalType": "int16",
                  "name": "spreadBps",
                  "type": "int16"
                },
                {
                  "internalType": "uint32",
                  "name": "maxStaleness",
                  "type": "uint32"
                }
              ],
              "internalType": "struct IEscrowV2.OracleRateConfig",
              "name": "_config",
              "type": "tuple"
            }
          ],
          "name": "setOracleRateConfig",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "bytes32[]",
              "name": "_paymentMethods",
              "type": "bytes32[]"
            },
            {
              "internalType": "bytes32[][]",
              "name": "_currencyCodes",
              "type": "bytes32[][]"
            },
            {
              "components": [
                {
                  "internalType": "address",
                  "name": "adapter",
                  "type": "address"
                },
                {
                  "internalType": "bytes",
                  "name": "adapterConfig",
                  "type": "bytes"
                },
                {
                  "internalType": "int16",
                  "name": "spreadBps",
                  "type": "int16"
                },
                {
                  "internalType": "uint32",
                  "name": "maxStaleness",
                  "type": "uint32"
                }
              ],
              "internalType": "struct IEscrowV2.OracleRateConfig[][]",
              "name": "_configs",
              "type": "tuple[][]"
            }
          ],
          "name": "setOracleRateConfigBatch",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_orchestratorRegistry",
              "type": "address"
            }
          ],
          "name": "setOrchestratorRegistry",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "bytes32",
              "name": "_paymentMethod",
              "type": "bytes32"
            },
            {
              "internalType": "bool",
              "name": "_isActive",
              "type": "bool"
            }
          ],
          "name": "setPaymentMethodActive",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_paymentVerifierRegistry",
              "type": "address"
            }
          ],
          "name": "setPaymentVerifierRegistry",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "address",
              "name": "_rateManager",
              "type": "address"
            },
            {
              "internalType": "bytes32",
              "name": "_rateManagerId",
              "type": "bytes32"
            }
          ],
          "name": "setRateManager",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "bool",
              "name": "_retainOnEmpty",
              "type": "bool"
            }
          ],
          "name": "setRetainOnEmpty",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "newOwner",
              "type": "address"
            }
          ],
          "name": "transferOwnership",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "bytes32",
              "name": "_intentHash",
              "type": "bytes32"
            },
            {
              "internalType": "uint256",
              "name": "_transferAmount",
              "type": "uint256"
            },
            {
              "internalType": "address",
              "name": "_to",
              "type": "address"
            }
          ],
          "name": "unlockAndTransferFunds",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "bytes32",
              "name": "_intentHash",
              "type": "bytes32"
            }
          ],
          "name": "unlockFunds",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "unpauseEscrow",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "bytes32[]",
              "name": "_paymentMethods",
              "type": "bytes32[]"
            },
            {
              "components": [
                {
                  "internalType": "bytes32",
                  "name": "code",
                  "type": "bytes32"
                },
                {
                  "internalType": "uint256",
                  "name": "minConversionRate",
                  "type": "uint256"
                },
                {
                  "internalType": "bool",
                  "name": "updateOracle",
                  "type": "bool"
                },
                {
                  "components": [
                    {
                      "internalType": "address",
                      "name": "adapter",
                      "type": "address"
                    },
                    {
                      "internalType": "bytes",
                      "name": "adapterConfig",
                      "type": "bytes"
                    },
                    {
                      "internalType": "int16",
                      "name": "spreadBps",
                      "type": "int16"
                    },
                    {
                      "internalType": "uint32",
                      "name": "maxStaleness",
                      "type": "uint32"
                    }
                  ],
                  "internalType": "struct IEscrowV2.OracleRateConfig",
                  "name": "oracleRateConfig",
                  "type": "tuple"
                }
              ],
              "internalType": "struct IEscrowV2.CurrencyRateUpdate[][]",
              "name": "_updates",
              "type": "tuple[][]"
            }
          ],
          "name": "updateCurrencyConfigBatch",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            }
          ],
          "name": "withdrawDeposit",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        }
      ]
    },
    "IntentGuardian": {
      "address": "0x3355bb8CEFA54509d244384CFA7f2A71fdb1FDD6",
      "abi": [
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_owner",
              "type": "address"
            },
            {
              "internalType": "contract IEscrowRegistry",
              "name": "_escrowRegistry",
              "type": "address"
            },
            {
              "internalType": "uint256",
              "name": "_extensionFeeBpsPerHour",
              "type": "uint256"
            }
          ],
          "stateMutability": "nonpayable",
          "type": "constructor"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "escrow",
              "type": "address"
            }
          ],
          "name": "EscrowNotWhitelisted",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "cost",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "maxCost",
              "type": "uint256"
            }
          ],
          "name": "ExtensionCostExceedsMax",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "extensionFeeBpsPerHour",
              "type": "uint256"
            }
          ],
          "name": "ExtensionFeeExceedsIntentAmount",
          "type": "error"
        },
        {
          "inputs": [],
          "name": "ExtensionsDisabled",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "intentHash",
              "type": "bytes32"
            },
            {
              "internalType": "uint256",
              "name": "expiryTime",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "currentTime",
              "type": "uint256"
            }
          ],
          "name": "IntentAlreadyExpired",
          "type": "error"
        },
        {
          "inputs": [],
          "name": "ZeroAddress",
          "type": "error"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "previousFeeBpsPerHour",
              "type": "uint256"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "newFeeBpsPerHour",
              "type": "uint256"
            }
          ],
          "name": "ExtensionFeeBpsPerHourUpdated",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "escrow",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "intentHash",
              "type": "bytes32"
            },
            {
              "indexed": false,
              "internalType": "address",
              "name": "payer",
              "type": "address"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "additionalTime",
              "type": "uint256"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "cost",
              "type": "uint256"
            }
          ],
          "name": "IntentExtended",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "previousOwner",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "newOwner",
              "type": "address"
            }
          ],
          "name": "OwnershipTransferStarted",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "previousOwner",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "newOwner",
              "type": "address"
            }
          ],
          "name": "OwnershipTransferred",
          "type": "event"
        },
        {
          "inputs": [],
          "name": "BPS_DENOMINATOR",
          "outputs": [
            {
              "internalType": "uint256",
              "name": "",
              "type": "uint256"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "EXTENSION_FEE_DENOMINATOR",
          "outputs": [
            {
              "internalType": "uint256",
              "name": "",
              "type": "uint256"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "MAX_EXTENSION_FEE_BPS_PER_HOUR",
          "outputs": [
            {
              "internalType": "uint256",
              "name": "",
              "type": "uint256"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "MAX_TOTAL_INTENT_LIFETIME",
          "outputs": [
            {
              "internalType": "uint256",
              "name": "",
              "type": "uint256"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "SECONDS_PER_HOUR",
          "outputs": [
            {
              "internalType": "uint256",
              "name": "",
              "type": "uint256"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "acceptOwnership",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "escrowRegistry",
          "outputs": [
            {
              "internalType": "contract IEscrowRegistry",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_escrow",
              "type": "address"
            },
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "bytes32",
              "name": "_intentHash",
              "type": "bytes32"
            },
            {
              "internalType": "uint256",
              "name": "_additionalTime",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "_maxCost",
              "type": "uint256"
            }
          ],
          "name": "extendIntent",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "extensionFeeBpsPerHour",
          "outputs": [
            {
              "internalType": "uint256",
              "name": "",
              "type": "uint256"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "owner",
          "outputs": [
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "pendingOwner",
          "outputs": [
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_intentAmount",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "_additionalTime",
              "type": "uint256"
            }
          ],
          "name": "quoteExtensionCost",
          "outputs": [
            {
              "internalType": "uint256",
              "name": "",
              "type": "uint256"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "renounceOwnership",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_extensionFeeBpsPerHour",
              "type": "uint256"
            }
          ],
          "name": "setExtensionFeeBpsPerHour",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "newOwner",
              "type": "address"
            }
          ],
          "name": "transferOwnership",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        }
      ]
    },
    "IntentLifecycleHookV1": {
      "address": "0x186388bBC1A694E4d1e6A65f8866a24DA45E6D09",
      "abi": [
        {
          "inputs": [
            {
              "internalType": "contract IOrchestratorRegistry",
              "name": "_orchestratorRegistry",
              "type": "address"
            },
            {
              "internalType": "contract IWhitelistPolicy",
              "name": "_whitelistPolicy",
              "type": "address"
            },
            {
              "internalType": "contract IChargebackPolicy",
              "name": "_chargebackPolicy",
              "type": "address"
            }
          ],
          "stateMutability": "nonpayable",
          "type": "constructor"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "intentHash",
              "type": "bytes32"
            }
          ],
          "name": "IntentNotFound",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "dependency",
              "type": "address"
            }
          ],
          "name": "InvalidDependency",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "escrow",
              "type": "address"
            },
            {
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "internalType": "address",
              "name": "taker",
              "type": "address"
            }
          ],
          "name": "TakerNotWhitelisted",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "caller",
              "type": "address"
            }
          ],
          "name": "UnauthorizedOrchestrator",
          "type": "error"
        },
        {
          "inputs": [],
          "name": "ZeroAddress",
          "type": "error"
        },
        {
          "inputs": [],
          "name": "chargebackPolicy",
          "outputs": [
            {
              "internalType": "contract IChargebackPolicy",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_intentHash",
              "type": "bytes32"
            }
          ],
          "name": "onIntentCancelled",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_intentHash",
              "type": "bytes32"
            }
          ],
          "name": "onIntentSignaled",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "orchestratorRegistry",
          "outputs": [
            {
              "internalType": "contract IOrchestratorRegistry",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "components": [
                {
                  "internalType": "bytes32",
                  "name": "intentHash",
                  "type": "bytes32"
                },
                {
                  "internalType": "address",
                  "name": "token",
                  "type": "address"
                },
                {
                  "internalType": "address",
                  "name": "recipient",
                  "type": "address"
                },
                {
                  "internalType": "uint256",
                  "name": "releaseAmount",
                  "type": "uint256"
                },
                {
                  "internalType": "uint256",
                  "name": "netAmount",
                  "type": "uint256"
                },
                {
                  "internalType": "bool",
                  "name": "isManualRelease",
                  "type": "bool"
                }
              ],
              "internalType": "struct IIntentLifecycleHook.SettlementContext",
              "name": "_context",
              "type": "tuple"
            }
          ],
          "name": "settleIntent",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "whitelistPolicy",
          "outputs": [
            {
              "internalType": "contract IWhitelistPolicy",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        }
      ]
    },
    "MultiAttestationVerifier": {
      "address": "0x9855a39aC5975069632e91160d8712CBfF19e864",
      "abi": [
        {
          "inputs": [
            {
              "internalType": "address[]",
              "name": "_initialWitnesses",
              "type": "address[]"
            },
            {
              "internalType": "uint256",
              "name": "_initialThreshold",
              "type": "uint256"
            }
          ],
          "stateMutability": "nonpayable",
          "type": "constructor"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "previousOwner",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "newOwner",
              "type": "address"
            }
          ],
          "name": "OwnershipTransferred",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "oldThreshold",
              "type": "uint256"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "newThreshold",
              "type": "uint256"
            }
          ],
          "name": "RequiredSignaturesUpdated",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "witness",
              "type": "address"
            }
          ],
          "name": "WitnessAdded",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "witness",
              "type": "address"
            }
          ],
          "name": "WitnessRemoved",
          "type": "event"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_witness",
              "type": "address"
            }
          ],
          "name": "addWitness",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_witness",
              "type": "address"
            }
          ],
          "name": "isWitness",
          "outputs": [
            {
              "internalType": "bool",
              "name": "",
              "type": "bool"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "owner",
          "outputs": [
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_witness",
              "type": "address"
            }
          ],
          "name": "removeWitness",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "renounceOwnership",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "requiredSignatures",
          "outputs": [
            {
              "internalType": "uint256",
              "name": "",
              "type": "uint256"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_requiredSignatures",
              "type": "uint256"
            }
          ],
          "name": "setRequiredSignatures",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "newOwner",
              "type": "address"
            }
          ],
          "name": "transferOwnership",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_digest",
              "type": "bytes32"
            },
            {
              "internalType": "bytes[]",
              "name": "_sigs",
              "type": "bytes[]"
            },
            {
              "internalType": "bytes",
              "name": "",
              "type": "bytes"
            }
          ],
          "name": "verify",
          "outputs": [
            {
              "internalType": "bool",
              "name": "isValid",
              "type": "bool"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "witnessCount",
          "outputs": [
            {
              "internalType": "uint256",
              "name": "",
              "type": "uint256"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "witnesses",
          "outputs": [
            {
              "internalType": "address[]",
              "name": "",
              "type": "address[]"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        }
      ]
    },
    "NullifierRegistry": {
      "address": "0x3FFd04f7909a16d3476263A1f4ce413A089dCc69",
      "abi": [
        {
          "inputs": [],
          "stateMutability": "nonpayable",
          "type": "constructor"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": false,
              "internalType": "bytes32",
              "name": "nullifier",
              "type": "bytes32"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "writer",
              "type": "address"
            }
          ],
          "name": "NullifierAdded",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "previousOwner",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "newOwner",
              "type": "address"
            }
          ],
          "name": "OwnershipTransferred",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": false,
              "internalType": "address",
              "name": "writer",
              "type": "address"
            }
          ],
          "name": "WriterAdded",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": false,
              "internalType": "address",
              "name": "writer",
              "type": "address"
            }
          ],
          "name": "WriterRemoved",
          "type": "event"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_nullifier",
              "type": "bytes32"
            }
          ],
          "name": "addNullifier",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_newWriter",
              "type": "address"
            }
          ],
          "name": "addWritePermission",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "getWriters",
          "outputs": [
            {
              "internalType": "address[]",
              "name": "",
              "type": "address[]"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "",
              "type": "bytes32"
            }
          ],
          "name": "isNullified",
          "outputs": [
            {
              "internalType": "bool",
              "name": "",
              "type": "bool"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            }
          ],
          "name": "isWriter",
          "outputs": [
            {
              "internalType": "bool",
              "name": "",
              "type": "bool"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "owner",
          "outputs": [
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_removedWriter",
              "type": "address"
            }
          ],
          "name": "removeWritePermission",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "renounceOwnership",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "newOwner",
              "type": "address"
            }
          ],
          "name": "transferOwnership",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "",
              "type": "uint256"
            }
          ],
          "name": "writers",
          "outputs": [
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        }
      ]
    },
    "NullifierRegistryV2": {
      "address": "0x2eb43d6C7c7Ec4220Aa6B8735BC053824a71778C",
      "abi": [
        {
          "inputs": [
            {
              "internalType": "contract INullifierRegistry",
              "name": "_legacyNullifierRegistry",
              "type": "address"
            }
          ],
          "stateMutability": "nonpayable",
          "type": "constructor"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "intentHash",
              "type": "bytes32"
            },
            {
              "internalType": "bytes32",
              "name": "nullifier",
              "type": "bytes32"
            }
          ],
          "name": "IntentAlreadyBound",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "nullifier",
              "type": "bytes32"
            }
          ],
          "name": "NullifierAlreadyExists",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "caller",
              "type": "address"
            }
          ],
          "name": "UnauthorizedWriter",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "writer",
              "type": "address"
            }
          ],
          "name": "WriterAlreadyAuthorized",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "writer",
              "type": "address"
            }
          ],
          "name": "WriterNotAuthorized",
          "type": "error"
        },
        {
          "inputs": [],
          "name": "ZeroAddress",
          "type": "error"
        },
        {
          "inputs": [],
          "name": "ZeroIntentHash",
          "type": "error"
        },
        {
          "inputs": [],
          "name": "ZeroNullifier",
          "type": "error"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "nullifier",
              "type": "bytes32"
            },
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "intentHash",
              "type": "bytes32"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "writer",
              "type": "address"
            }
          ],
          "name": "NullifierAdded",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "previousOwner",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "newOwner",
              "type": "address"
            }
          ],
          "name": "OwnershipTransferred",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "writer",
              "type": "address"
            }
          ],
          "name": "WriterAdded",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "writer",
              "type": "address"
            }
          ],
          "name": "WriterRemoved",
          "type": "event"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_nullifier",
              "type": "bytes32"
            },
            {
              "internalType": "bytes32",
              "name": "_intentHash",
              "type": "bytes32"
            }
          ],
          "name": "addNullifier",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_writer",
              "type": "address"
            }
          ],
          "name": "addWritePermission",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "getWriters",
          "outputs": [
            {
              "internalType": "address[]",
              "name": "",
              "type": "address[]"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "",
              "type": "bytes32"
            }
          ],
          "name": "intentHashByNullifier",
          "outputs": [
            {
              "internalType": "bytes32",
              "name": "",
              "type": "bytes32"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_nullifier",
              "type": "bytes32"
            }
          ],
          "name": "isNullified",
          "outputs": [
            {
              "internalType": "bool",
              "name": "",
              "type": "bool"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            }
          ],
          "name": "isWriter",
          "outputs": [
            {
              "internalType": "bool",
              "name": "",
              "type": "bool"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "legacyNullifierRegistry",
          "outputs": [
            {
              "internalType": "contract INullifierRegistry",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "",
              "type": "bytes32"
            }
          ],
          "name": "nullifierByIntentHash",
          "outputs": [
            {
              "internalType": "bytes32",
              "name": "",
              "type": "bytes32"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "owner",
          "outputs": [
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_writer",
              "type": "address"
            }
          ],
          "name": "removeWritePermission",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "renounceOwnership",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "newOwner",
              "type": "address"
            }
          ],
          "name": "transferOwnership",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        }
      ]
    },
    "Orchestrator": {
      "address": "0xF9b9CD27Deea496B960b3cb5221b514705fCaF5e",
      "abi": [
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_owner",
              "type": "address"
            },
            {
              "internalType": "uint256",
              "name": "_chainId",
              "type": "uint256"
            },
            {
              "internalType": "address",
              "name": "_escrowRegistry",
              "type": "address"
            },
            {
              "internalType": "address",
              "name": "_paymentVerifierRegistry",
              "type": "address"
            },
            {
              "internalType": "address",
              "name": "_postIntentHookRegistry",
              "type": "address"
            },
            {
              "internalType": "address",
              "name": "_relayerRegistry",
              "type": "address"
            },
            {
              "internalType": "uint256",
              "name": "_protocolFee",
              "type": "uint256"
            },
            {
              "internalType": "address",
              "name": "_protocolFeeRecipient",
              "type": "address"
            }
          ],
          "stateMutability": "nonpayable",
          "type": "constructor"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "account",
              "type": "address"
            },
            {
              "internalType": "bytes32",
              "name": "existingIntent",
              "type": "bytes32"
            }
          ],
          "name": "AccountHasActiveIntent",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "amount",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "max",
              "type": "uint256"
            }
          ],
          "name": "AmountAboveMax",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "amount",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "min",
              "type": "uint256"
            }
          ],
          "name": "AmountBelowMin",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "amount",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "limit",
              "type": "uint256"
            }
          ],
          "name": "AmountExceedsLimit",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "paymentMethod",
              "type": "bytes32"
            },
            {
              "internalType": "bytes32",
              "name": "currency",
              "type": "bytes32"
            }
          ],
          "name": "CurrencyNotSupported",
          "type": "error"
        },
        {
          "inputs": [],
          "name": "EscrowLockFailed",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "escrow",
              "type": "address"
            }
          ],
          "name": "EscrowNotWhitelisted",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "fee",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "maximum",
              "type": "uint256"
            }
          ],
          "name": "FeeExceedsMaximum",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "expected",
              "type": "bytes32"
            },
            {
              "internalType": "bytes32",
              "name": "actual",
              "type": "bytes32"
            }
          ],
          "name": "HashMismatch",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "intentHash",
              "type": "bytes32"
            }
          ],
          "name": "IntentNotFound",
          "type": "error"
        },
        {
          "inputs": [],
          "name": "InvalidReferrerFeeConfiguration",
          "type": "error"
        },
        {
          "inputs": [],
          "name": "InvalidSignature",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "currentTime",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "allowedTime",
              "type": "uint256"
            }
          ],
          "name": "PartialReleaseNotAllowedYet",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "paymentMethod",
              "type": "bytes32"
            }
          ],
          "name": "PaymentMethodDoesNotExist",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "paymentMethod",
              "type": "bytes32"
            }
          ],
          "name": "PaymentMethodNotSupported",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "paymentMethod",
              "type": "bytes32"
            }
          ],
          "name": "PaymentMethodNotWhitelisted",
          "type": "error"
        },
        {
          "inputs": [],
          "name": "PaymentVerificationFailed",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "hook",
              "type": "address"
            }
          ],
          "name": "PostIntentHookNotWhitelisted",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "rate",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "minRate",
              "type": "uint256"
            }
          ],
          "name": "RateBelowMinimum",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "expiration",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "currentTime",
              "type": "uint256"
            }
          ],
          "name": "SignatureExpired",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "recipient",
              "type": "address"
            },
            {
              "internalType": "uint256",
              "name": "amount",
              "type": "uint256"
            }
          ],
          "name": "TransferFailed",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "caller",
              "type": "address"
            },
            {
              "internalType": "address",
              "name": "authorized",
              "type": "address"
            }
          ],
          "name": "UnauthorizedCaller",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "caller",
              "type": "address"
            }
          ],
          "name": "UnauthorizedEscrowCaller",
          "type": "error"
        },
        {
          "inputs": [],
          "name": "ZeroAddress",
          "type": "error"
        },
        {
          "inputs": [],
          "name": "ZeroValue",
          "type": "error"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": false,
              "internalType": "bool",
              "name": "allowMultiple",
              "type": "bool"
            }
          ],
          "name": "AllowMultipleIntentsUpdated",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "escrowRegistry",
              "type": "address"
            }
          ],
          "name": "EscrowRegistryUpdated",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "intentHash",
              "type": "bytes32"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "fundsTransferredTo",
              "type": "address"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "amount",
              "type": "uint256"
            },
            {
              "indexed": false,
              "internalType": "bool",
              "name": "isManualRelease",
              "type": "bool"
            }
          ],
          "name": "IntentFulfilled",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "intentHash",
              "type": "bytes32"
            }
          ],
          "name": "IntentPruned",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "intentHash",
              "type": "bytes32"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "escrow",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "indexed": false,
              "internalType": "bytes32",
              "name": "paymentMethod",
              "type": "bytes32"
            },
            {
              "indexed": false,
              "internalType": "address",
              "name": "owner",
              "type": "address"
            },
            {
              "indexed": false,
              "internalType": "address",
              "name": "to",
              "type": "address"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "amount",
              "type": "uint256"
            },
            {
              "indexed": false,
              "internalType": "bytes32",
              "name": "fiatCurrency",
              "type": "bytes32"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "conversionRate",
              "type": "uint256"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "timestamp",
              "type": "uint256"
            }
          ],
          "name": "IntentSignaled",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "previousOwner",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "newOwner",
              "type": "address"
            }
          ],
          "name": "OwnershipTransferred",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "partialManualReleaseDelay",
              "type": "uint256"
            }
          ],
          "name": "PartialManualReleaseDelayUpdated",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": false,
              "internalType": "address",
              "name": "account",
              "type": "address"
            }
          ],
          "name": "Paused",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "paymentVerifierRegistry",
              "type": "address"
            }
          ],
          "name": "PaymentVerifierRegistryUpdated",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "postIntentHookRegistry",
              "type": "address"
            }
          ],
          "name": "PostIntentHookRegistryUpdated",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "protocolFeeRecipient",
              "type": "address"
            }
          ],
          "name": "ProtocolFeeRecipientUpdated",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "protocolFee",
              "type": "uint256"
            }
          ],
          "name": "ProtocolFeeUpdated",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "relayerRegistry",
              "type": "address"
            }
          ],
          "name": "RelayerRegistryUpdated",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": false,
              "internalType": "address",
              "name": "account",
              "type": "address"
            }
          ],
          "name": "Unpaused",
          "type": "event"
        },
        {
          "inputs": [],
          "name": "allowMultipleIntents",
          "outputs": [
            {
              "internalType": "bool",
              "name": "",
              "type": "bool"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_intentHash",
              "type": "bytes32"
            }
          ],
          "name": "cancelIntent",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "chainId",
          "outputs": [
            {
              "internalType": "uint256",
              "name": "",
              "type": "uint256"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "escrowRegistry",
          "outputs": [
            {
              "internalType": "contract IEscrowRegistry",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "components": [
                {
                  "internalType": "bytes",
                  "name": "paymentProof",
                  "type": "bytes"
                },
                {
                  "internalType": "bytes32",
                  "name": "intentHash",
                  "type": "bytes32"
                },
                {
                  "internalType": "bytes",
                  "name": "verificationData",
                  "type": "bytes"
                },
                {
                  "internalType": "bytes",
                  "name": "postIntentHookData",
                  "type": "bytes"
                }
              ],
              "internalType": "struct IOrchestrator.FulfillIntentParams",
              "name": "_params",
              "type": "tuple"
            }
          ],
          "name": "fulfillIntent",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_account",
              "type": "address"
            }
          ],
          "name": "getAccountIntents",
          "outputs": [
            {
              "internalType": "bytes32[]",
              "name": "",
              "type": "bytes32[]"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_intentHash",
              "type": "bytes32"
            }
          ],
          "name": "getIntent",
          "outputs": [
            {
              "components": [
                {
                  "internalType": "address",
                  "name": "owner",
                  "type": "address"
                },
                {
                  "internalType": "address",
                  "name": "to",
                  "type": "address"
                },
                {
                  "internalType": "address",
                  "name": "escrow",
                  "type": "address"
                },
                {
                  "internalType": "uint256",
                  "name": "depositId",
                  "type": "uint256"
                },
                {
                  "internalType": "uint256",
                  "name": "amount",
                  "type": "uint256"
                },
                {
                  "internalType": "uint256",
                  "name": "timestamp",
                  "type": "uint256"
                },
                {
                  "internalType": "bytes32",
                  "name": "paymentMethod",
                  "type": "bytes32"
                },
                {
                  "internalType": "bytes32",
                  "name": "fiatCurrency",
                  "type": "bytes32"
                },
                {
                  "internalType": "uint256",
                  "name": "conversionRate",
                  "type": "uint256"
                },
                {
                  "internalType": "bytes32",
                  "name": "payeeId",
                  "type": "bytes32"
                },
                {
                  "internalType": "address",
                  "name": "referrer",
                  "type": "address"
                },
                {
                  "internalType": "uint256",
                  "name": "referrerFee",
                  "type": "uint256"
                },
                {
                  "internalType": "contract IPostIntentHook",
                  "name": "postIntentHook",
                  "type": "address"
                },
                {
                  "internalType": "bytes",
                  "name": "data",
                  "type": "bytes"
                }
              ],
              "internalType": "struct IOrchestrator.Intent",
              "name": "",
              "type": "tuple"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_intentHash",
              "type": "bytes32"
            }
          ],
          "name": "getIntentMinAtSignal",
          "outputs": [
            {
              "internalType": "uint256",
              "name": "",
              "type": "uint256"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "intentCounter",
          "outputs": [
            {
              "internalType": "uint256",
              "name": "",
              "type": "uint256"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "owner",
          "outputs": [
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "pauseOrchestrator",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "paused",
          "outputs": [
            {
              "internalType": "bool",
              "name": "",
              "type": "bool"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "paymentVerifierRegistry",
          "outputs": [
            {
              "internalType": "contract IPaymentVerifierRegistry",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "postIntentHookRegistry",
          "outputs": [
            {
              "internalType": "contract IPostIntentHookRegistry",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "protocolFee",
          "outputs": [
            {
              "internalType": "uint256",
              "name": "",
              "type": "uint256"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "protocolFeeRecipient",
          "outputs": [
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32[]",
              "name": "_intents",
              "type": "bytes32[]"
            }
          ],
          "name": "pruneIntents",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "relayerRegistry",
          "outputs": [
            {
              "internalType": "contract IRelayerRegistry",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_intentHash",
              "type": "bytes32"
            }
          ],
          "name": "releaseFundsToPayer",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "renounceOwnership",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bool",
              "name": "_allowMultiple",
              "type": "bool"
            }
          ],
          "name": "setAllowMultipleIntents",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_escrowRegistry",
              "type": "address"
            }
          ],
          "name": "setEscrowRegistry",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_postIntentHookRegistry",
              "type": "address"
            }
          ],
          "name": "setPostIntentHookRegistry",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_protocolFee",
              "type": "uint256"
            }
          ],
          "name": "setProtocolFee",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_protocolFeeRecipient",
              "type": "address"
            }
          ],
          "name": "setProtocolFeeRecipient",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_relayerRegistry",
              "type": "address"
            }
          ],
          "name": "setRelayerRegistry",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "components": [
                {
                  "internalType": "address",
                  "name": "escrow",
                  "type": "address"
                },
                {
                  "internalType": "uint256",
                  "name": "depositId",
                  "type": "uint256"
                },
                {
                  "internalType": "uint256",
                  "name": "amount",
                  "type": "uint256"
                },
                {
                  "internalType": "address",
                  "name": "to",
                  "type": "address"
                },
                {
                  "internalType": "bytes32",
                  "name": "paymentMethod",
                  "type": "bytes32"
                },
                {
                  "internalType": "bytes32",
                  "name": "fiatCurrency",
                  "type": "bytes32"
                },
                {
                  "internalType": "uint256",
                  "name": "conversionRate",
                  "type": "uint256"
                },
                {
                  "internalType": "address",
                  "name": "referrer",
                  "type": "address"
                },
                {
                  "internalType": "uint256",
                  "name": "referrerFee",
                  "type": "uint256"
                },
                {
                  "internalType": "bytes",
                  "name": "gatingServiceSignature",
                  "type": "bytes"
                },
                {
                  "internalType": "uint256",
                  "name": "signatureExpiration",
                  "type": "uint256"
                },
                {
                  "internalType": "contract IPostIntentHook",
                  "name": "postIntentHook",
                  "type": "address"
                },
                {
                  "internalType": "bytes",
                  "name": "data",
                  "type": "bytes"
                }
              ],
              "internalType": "struct IOrchestrator.SignalIntentParams",
              "name": "_params",
              "type": "tuple"
            }
          ],
          "name": "signalIntent",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "newOwner",
              "type": "address"
            }
          ],
          "name": "transferOwnership",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "unpauseOrchestrator",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        }
      ]
    },
    "OrchestratorRegistry": {
      "address": "0xfA6384EB6176cfEC049540526A3d2126C3666d8A",
      "abi": [
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "orchestrator",
              "type": "address"
            }
          ],
          "name": "OrchestratorAlreadyAdded",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "orchestrator",
              "type": "address"
            }
          ],
          "name": "OrchestratorNotFound",
          "type": "error"
        },
        {
          "inputs": [],
          "name": "ZeroAddress",
          "type": "error"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "orchestrator",
              "type": "address"
            }
          ],
          "name": "OrchestratorAdded",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "orchestrator",
              "type": "address"
            }
          ],
          "name": "OrchestratorRemoved",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "previousOwner",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "newOwner",
              "type": "address"
            }
          ],
          "name": "OwnershipTransferred",
          "type": "event"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_orchestrator",
              "type": "address"
            }
          ],
          "name": "addOrchestrator",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            }
          ],
          "name": "isOrchestrator",
          "outputs": [
            {
              "internalType": "bool",
              "name": "",
              "type": "bool"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "owner",
          "outputs": [
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_orchestrator",
              "type": "address"
            }
          ],
          "name": "removeOrchestrator",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "renounceOwnership",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "newOwner",
              "type": "address"
            }
          ],
          "name": "transferOwnership",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        }
      ]
    },
    "OrchestratorV2": {
      "address": "0xc17a59227B136c45fAa153086a15EF87ED14bE00",
      "abi": [
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_owner",
              "type": "address"
            },
            {
              "internalType": "uint256",
              "name": "_chainId",
              "type": "uint256"
            },
            {
              "internalType": "address",
              "name": "_escrowRegistry",
              "type": "address"
            },
            {
              "internalType": "address",
              "name": "_paymentVerifierRegistry",
              "type": "address"
            },
            {
              "internalType": "address",
              "name": "_relayerRegistry",
              "type": "address"
            },
            {
              "internalType": "uint256",
              "name": "_protocolFee",
              "type": "uint256"
            },
            {
              "internalType": "address",
              "name": "_protocolFeeRecipient",
              "type": "address"
            }
          ],
          "stateMutability": "nonpayable",
          "type": "constructor"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "account",
              "type": "address"
            },
            {
              "internalType": "bytes32",
              "name": "existingIntent",
              "type": "bytes32"
            }
          ],
          "name": "AccountHasActiveIntent",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "amount",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "max",
              "type": "uint256"
            }
          ],
          "name": "AmountAboveMax",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "amount",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "min",
              "type": "uint256"
            }
          ],
          "name": "AmountBelowMin",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "amount",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "limit",
              "type": "uint256"
            }
          ],
          "name": "AmountExceedsLimit",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "paymentMethod",
              "type": "bytes32"
            },
            {
              "internalType": "bytes32",
              "name": "currency",
              "type": "bytes32"
            }
          ],
          "name": "CurrencyNotSupported",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "recipient",
              "type": "address"
            }
          ],
          "name": "DuplicateReferralFeeRecipient",
          "type": "error"
        },
        {
          "inputs": [],
          "name": "EscrowLockFailed",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "escrow",
              "type": "address"
            }
          ],
          "name": "EscrowNotWhitelisted",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "fee",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "maximum",
              "type": "uint256"
            }
          ],
          "name": "FeeExceedsMaximum",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "expected",
              "type": "bytes32"
            },
            {
              "internalType": "bytes32",
              "name": "actual",
              "type": "bytes32"
            }
          ],
          "name": "HashMismatch",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "intentHash",
              "type": "bytes32"
            }
          ],
          "name": "IntentNotFound",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "hook",
              "type": "address"
            }
          ],
          "name": "InvalidPostIntentHook",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "hook",
              "type": "address"
            }
          ],
          "name": "InvalidPreIntentHook",
          "type": "error"
        },
        {
          "inputs": [],
          "name": "InvalidReferralFeeConfiguration",
          "type": "error"
        },
        {
          "inputs": [],
          "name": "InvalidSignature",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "paymentMethod",
              "type": "bytes32"
            }
          ],
          "name": "PaymentMethodDoesNotExist",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "paymentMethod",
              "type": "bytes32"
            }
          ],
          "name": "PaymentMethodNotSupported",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "paymentMethod",
              "type": "bytes32"
            }
          ],
          "name": "PaymentMethodNotWhitelisted",
          "type": "error"
        },
        {
          "inputs": [],
          "name": "PaymentVerificationFailed",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "rate",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "minRate",
              "type": "uint256"
            }
          ],
          "name": "RateBelowMinimum",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "count",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "maximum",
              "type": "uint256"
            }
          ],
          "name": "ReferralFeeCountExceedsMaximum",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "totalFee",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "maximum",
              "type": "uint256"
            }
          ],
          "name": "ReferralFeeExceedsMaximum",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "expiration",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "currentTime",
              "type": "uint256"
            }
          ],
          "name": "SignatureExpired",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "recipient",
              "type": "address"
            },
            {
              "internalType": "uint256",
              "name": "amount",
              "type": "uint256"
            }
          ],
          "name": "TransferFailed",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "caller",
              "type": "address"
            },
            {
              "internalType": "address",
              "name": "authorized",
              "type": "address"
            }
          ],
          "name": "UnauthorizedCaller",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "caller",
              "type": "address"
            },
            {
              "internalType": "address",
              "name": "owner",
              "type": "address"
            },
            {
              "internalType": "address",
              "name": "delegate",
              "type": "address"
            }
          ],
          "name": "UnauthorizedCallerOrDelegate",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "caller",
              "type": "address"
            }
          ],
          "name": "UnauthorizedEscrowCaller",
          "type": "error"
        },
        {
          "inputs": [],
          "name": "ZeroAddress",
          "type": "error"
        },
        {
          "inputs": [],
          "name": "ZeroValue",
          "type": "error"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": false,
              "internalType": "bool",
              "name": "allowMultiple",
              "type": "bool"
            }
          ],
          "name": "AllowMultipleIntentsUpdated",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "escrow",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "hook",
              "type": "address"
            },
            {
              "indexed": false,
              "internalType": "address",
              "name": "setter",
              "type": "address"
            }
          ],
          "name": "DepositPreIntentHookSet",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "escrow",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "hook",
              "type": "address"
            },
            {
              "indexed": false,
              "internalType": "address",
              "name": "setter",
              "type": "address"
            }
          ],
          "name": "DepositWhitelistHookSet",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "escrowRegistry",
              "type": "address"
            }
          ],
          "name": "EscrowRegistryUpdated",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "intentHash",
              "type": "bytes32"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "fundsTransferredTo",
              "type": "address"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "amount",
              "type": "uint256"
            },
            {
              "indexed": false,
              "internalType": "bool",
              "name": "isManualRelease",
              "type": "bool"
            }
          ],
          "name": "IntentFulfilled",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "intentHash",
              "type": "bytes32"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "feeRecipient",
              "type": "address"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "fee",
              "type": "uint256"
            }
          ],
          "name": "IntentManagerFeeSnapshotted",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "intentHash",
              "type": "bytes32"
            }
          ],
          "name": "IntentPruned",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "intentHash",
              "type": "bytes32"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "feeRecipient",
              "type": "address"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "feeAmount",
              "type": "uint256"
            }
          ],
          "name": "IntentReferralFeeDistributed",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "intentHash",
              "type": "bytes32"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "escrow",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "indexed": false,
              "internalType": "bytes32",
              "name": "paymentMethod",
              "type": "bytes32"
            },
            {
              "indexed": false,
              "internalType": "address",
              "name": "owner",
              "type": "address"
            },
            {
              "indexed": false,
              "internalType": "address",
              "name": "to",
              "type": "address"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "amount",
              "type": "uint256"
            },
            {
              "indexed": false,
              "internalType": "bytes32",
              "name": "fiatCurrency",
              "type": "bytes32"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "conversionRate",
              "type": "uint256"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "timestamp",
              "type": "uint256"
            }
          ],
          "name": "IntentSignaled",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "previousOwner",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "newOwner",
              "type": "address"
            }
          ],
          "name": "OwnershipTransferred",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "partialManualReleaseDelay",
              "type": "uint256"
            }
          ],
          "name": "PartialManualReleaseDelayUpdated",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": false,
              "internalType": "address",
              "name": "account",
              "type": "address"
            }
          ],
          "name": "Paused",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "paymentVerifierRegistry",
              "type": "address"
            }
          ],
          "name": "PaymentVerifierRegistryUpdated",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "protocolFeeRecipient",
              "type": "address"
            }
          ],
          "name": "ProtocolFeeRecipientUpdated",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "protocolFee",
              "type": "uint256"
            }
          ],
          "name": "ProtocolFeeUpdated",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "relayerRegistry",
              "type": "address"
            }
          ],
          "name": "RelayerRegistryUpdated",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": false,
              "internalType": "address",
              "name": "account",
              "type": "address"
            }
          ],
          "name": "Unpaused",
          "type": "event"
        },
        {
          "inputs": [],
          "name": "allowMultipleIntents",
          "outputs": [
            {
              "internalType": "bool",
              "name": "",
              "type": "bool"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_intentHash",
              "type": "bytes32"
            }
          ],
          "name": "cancelIntent",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "chainId",
          "outputs": [
            {
              "internalType": "uint256",
              "name": "",
              "type": "uint256"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32[]",
              "name": "_intentHashes",
              "type": "bytes32[]"
            }
          ],
          "name": "cleanupOrphanedIntents",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "escrowRegistry",
          "outputs": [
            {
              "internalType": "contract IEscrowRegistry",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "components": [
                {
                  "internalType": "bytes",
                  "name": "paymentProof",
                  "type": "bytes"
                },
                {
                  "internalType": "bytes32",
                  "name": "intentHash",
                  "type": "bytes32"
                },
                {
                  "internalType": "bytes",
                  "name": "verificationData",
                  "type": "bytes"
                },
                {
                  "internalType": "bytes",
                  "name": "postIntentHookData",
                  "type": "bytes"
                }
              ],
              "internalType": "struct IOrchestratorV2.FulfillIntentParams",
              "name": "_params",
              "type": "tuple"
            }
          ],
          "name": "fulfillIntent",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_account",
              "type": "address"
            }
          ],
          "name": "getAccountIntents",
          "outputs": [
            {
              "internalType": "bytes32[]",
              "name": "",
              "type": "bytes32[]"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_escrow",
              "type": "address"
            },
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            }
          ],
          "name": "getDepositPreIntentHook",
          "outputs": [
            {
              "internalType": "contract IPreIntentHook",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_escrow",
              "type": "address"
            },
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            }
          ],
          "name": "getDepositWhitelistHook",
          "outputs": [
            {
              "internalType": "contract IPreIntentHook",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_intentHash",
              "type": "bytes32"
            }
          ],
          "name": "getIntent",
          "outputs": [
            {
              "components": [
                {
                  "internalType": "address",
                  "name": "owner",
                  "type": "address"
                },
                {
                  "internalType": "address",
                  "name": "to",
                  "type": "address"
                },
                {
                  "internalType": "address",
                  "name": "escrow",
                  "type": "address"
                },
                {
                  "internalType": "uint256",
                  "name": "depositId",
                  "type": "uint256"
                },
                {
                  "internalType": "uint256",
                  "name": "amount",
                  "type": "uint256"
                },
                {
                  "internalType": "uint256",
                  "name": "timestamp",
                  "type": "uint256"
                },
                {
                  "internalType": "bytes32",
                  "name": "paymentMethod",
                  "type": "bytes32"
                },
                {
                  "internalType": "bytes32",
                  "name": "fiatCurrency",
                  "type": "bytes32"
                },
                {
                  "internalType": "uint256",
                  "name": "conversionRate",
                  "type": "uint256"
                },
                {
                  "internalType": "bytes32",
                  "name": "payeeId",
                  "type": "bytes32"
                },
                {
                  "components": [
                    {
                      "internalType": "address",
                      "name": "recipient",
                      "type": "address"
                    },
                    {
                      "internalType": "uint256",
                      "name": "fee",
                      "type": "uint256"
                    }
                  ],
                  "internalType": "struct IReferralFee.ReferralFee[]",
                  "name": "referralFees",
                  "type": "tuple[]"
                },
                {
                  "internalType": "contract IPostIntentHookV2",
                  "name": "postIntentHook",
                  "type": "address"
                },
                {
                  "internalType": "bytes",
                  "name": "data",
                  "type": "bytes"
                }
              ],
              "internalType": "struct IOrchestratorV2.Intent",
              "name": "",
              "type": "tuple"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_intentHash",
              "type": "bytes32"
            }
          ],
          "name": "getIntentMinAtSignal",
          "outputs": [
            {
              "internalType": "uint256",
              "name": "",
              "type": "uint256"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "intentCounter",
          "outputs": [
            {
              "internalType": "uint256",
              "name": "",
              "type": "uint256"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "owner",
          "outputs": [
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "pauseOrchestrator",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "paused",
          "outputs": [
            {
              "internalType": "bool",
              "name": "",
              "type": "bool"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "paymentVerifierRegistry",
          "outputs": [
            {
              "internalType": "contract IPaymentVerifierRegistry",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "protocolFee",
          "outputs": [
            {
              "internalType": "uint256",
              "name": "",
              "type": "uint256"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "protocolFeeRecipient",
          "outputs": [
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32[]",
              "name": "_intents",
              "type": "bytes32[]"
            }
          ],
          "name": "pruneIntents",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "relayerRegistry",
          "outputs": [
            {
              "internalType": "contract IRelayerRegistry",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_intentHash",
              "type": "bytes32"
            }
          ],
          "name": "releaseFundsToPayer",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "renounceOwnership",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bool",
              "name": "_allowMultiple",
              "type": "bool"
            }
          ],
          "name": "setAllowMultipleIntents",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_escrow",
              "type": "address"
            },
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "contract IPreIntentHook",
              "name": "_hook",
              "type": "address"
            }
          ],
          "name": "setDepositPreIntentHook",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_escrow",
              "type": "address"
            },
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "contract IPreIntentHook",
              "name": "_hook",
              "type": "address"
            }
          ],
          "name": "setDepositWhitelistHook",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_escrowRegistry",
              "type": "address"
            }
          ],
          "name": "setEscrowRegistry",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_protocolFee",
              "type": "uint256"
            }
          ],
          "name": "setProtocolFee",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_protocolFeeRecipient",
              "type": "address"
            }
          ],
          "name": "setProtocolFeeRecipient",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_relayerRegistry",
              "type": "address"
            }
          ],
          "name": "setRelayerRegistry",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "components": [
                {
                  "internalType": "address",
                  "name": "escrow",
                  "type": "address"
                },
                {
                  "internalType": "uint256",
                  "name": "depositId",
                  "type": "uint256"
                },
                {
                  "internalType": "uint256",
                  "name": "amount",
                  "type": "uint256"
                },
                {
                  "internalType": "address",
                  "name": "to",
                  "type": "address"
                },
                {
                  "internalType": "bytes32",
                  "name": "paymentMethod",
                  "type": "bytes32"
                },
                {
                  "internalType": "bytes32",
                  "name": "fiatCurrency",
                  "type": "bytes32"
                },
                {
                  "internalType": "uint256",
                  "name": "conversionRate",
                  "type": "uint256"
                },
                {
                  "components": [
                    {
                      "internalType": "address",
                      "name": "recipient",
                      "type": "address"
                    },
                    {
                      "internalType": "uint256",
                      "name": "fee",
                      "type": "uint256"
                    }
                  ],
                  "internalType": "struct IReferralFee.ReferralFee[]",
                  "name": "referralFees",
                  "type": "tuple[]"
                },
                {
                  "internalType": "bytes",
                  "name": "gatingServiceSignature",
                  "type": "bytes"
                },
                {
                  "internalType": "uint256",
                  "name": "signatureExpiration",
                  "type": "uint256"
                },
                {
                  "internalType": "contract IPostIntentHookV2",
                  "name": "postIntentHook",
                  "type": "address"
                },
                {
                  "internalType": "bytes",
                  "name": "preIntentHookData",
                  "type": "bytes"
                },
                {
                  "internalType": "bytes",
                  "name": "data",
                  "type": "bytes"
                }
              ],
              "internalType": "struct IOrchestratorV2.SignalIntentParams",
              "name": "_params",
              "type": "tuple"
            }
          ],
          "name": "signalIntent",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "newOwner",
              "type": "address"
            }
          ],
          "name": "transferOwnership",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "unpauseOrchestrator",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        }
      ]
    },
    "OrchestratorV3": {
      "address": "0x6Db9dDb38a19Be0c614C0Ad9e78Baf73f93c35dF",
      "abi": [
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_owner",
              "type": "address"
            },
            {
              "internalType": "uint256",
              "name": "_chainId",
              "type": "uint256"
            },
            {
              "internalType": "address",
              "name": "_escrowRegistry",
              "type": "address"
            },
            {
              "internalType": "address",
              "name": "_paymentVerifierRegistry",
              "type": "address"
            },
            {
              "internalType": "address",
              "name": "_relayerRegistry",
              "type": "address"
            },
            {
              "internalType": "uint256",
              "name": "_protocolFee",
              "type": "uint256"
            },
            {
              "internalType": "address",
              "name": "_protocolFeeRecipient",
              "type": "address"
            }
          ],
          "stateMutability": "nonpayable",
          "type": "constructor"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "account",
              "type": "address"
            },
            {
              "internalType": "bytes32",
              "name": "existingIntent",
              "type": "bytes32"
            }
          ],
          "name": "AccountHasActiveIntent",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "amount",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "max",
              "type": "uint256"
            }
          ],
          "name": "AmountAboveMax",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "amount",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "min",
              "type": "uint256"
            }
          ],
          "name": "AmountBelowMin",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "amount",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "limit",
              "type": "uint256"
            }
          ],
          "name": "AmountExceedsLimit",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "paymentMethod",
              "type": "bytes32"
            },
            {
              "internalType": "bytes32",
              "name": "currency",
              "type": "bytes32"
            }
          ],
          "name": "CurrencyNotSupported",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "recipient",
              "type": "address"
            }
          ],
          "name": "DuplicateReferralFeeRecipient",
          "type": "error"
        },
        {
          "inputs": [],
          "name": "EscrowLockFailed",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "escrow",
              "type": "address"
            }
          ],
          "name": "EscrowNotWhitelisted",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "fee",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "maximum",
              "type": "uint256"
            }
          ],
          "name": "FeeExceedsMaximum",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "expected",
              "type": "bytes32"
            },
            {
              "internalType": "bytes32",
              "name": "actual",
              "type": "bytes32"
            }
          ],
          "name": "HashMismatch",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "intentHash",
              "type": "bytes32"
            }
          ],
          "name": "IntentNotFound",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "hook",
              "type": "address"
            }
          ],
          "name": "InvalidLifecycleHook",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "hook",
              "type": "address"
            }
          ],
          "name": "InvalidPostIntentHook",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "hook",
              "type": "address"
            }
          ],
          "name": "InvalidPreIntentHook",
          "type": "error"
        },
        {
          "inputs": [],
          "name": "InvalidReferralFeeConfiguration",
          "type": "error"
        },
        {
          "inputs": [],
          "name": "InvalidSignature",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "paymentMethod",
              "type": "bytes32"
            }
          ],
          "name": "PaymentMethodDoesNotExist",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "paymentMethod",
              "type": "bytes32"
            }
          ],
          "name": "PaymentMethodNotSupported",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "paymentMethod",
              "type": "bytes32"
            }
          ],
          "name": "PaymentMethodNotWhitelisted",
          "type": "error"
        },
        {
          "inputs": [],
          "name": "PaymentVerificationFailed",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "rate",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "minRate",
              "type": "uint256"
            }
          ],
          "name": "RateBelowMinimum",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "count",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "maximum",
              "type": "uint256"
            }
          ],
          "name": "ReferralFeeCountExceedsMaximum",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "totalFee",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "maximum",
              "type": "uint256"
            }
          ],
          "name": "ReferralFeeExceedsMaximum",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "expiration",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "currentTime",
              "type": "uint256"
            }
          ],
          "name": "SignatureExpired",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "recipient",
              "type": "address"
            },
            {
              "internalType": "uint256",
              "name": "amount",
              "type": "uint256"
            }
          ],
          "name": "TransferFailed",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "caller",
              "type": "address"
            },
            {
              "internalType": "address",
              "name": "authorized",
              "type": "address"
            }
          ],
          "name": "UnauthorizedCaller",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "caller",
              "type": "address"
            },
            {
              "internalType": "address",
              "name": "owner",
              "type": "address"
            },
            {
              "internalType": "address",
              "name": "delegate",
              "type": "address"
            }
          ],
          "name": "UnauthorizedCallerOrDelegate",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "caller",
              "type": "address"
            }
          ],
          "name": "UnauthorizedEscrowCaller",
          "type": "error"
        },
        {
          "inputs": [],
          "name": "ZeroAddress",
          "type": "error"
        },
        {
          "inputs": [],
          "name": "ZeroValue",
          "type": "error"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": false,
              "internalType": "bool",
              "name": "allowMultiple",
              "type": "bool"
            }
          ],
          "name": "AllowMultipleIntentsUpdated",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "escrow",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "hook",
              "type": "address"
            },
            {
              "indexed": false,
              "internalType": "address",
              "name": "setter",
              "type": "address"
            }
          ],
          "name": "DepositPreIntentHookSet",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "escrowRegistry",
              "type": "address"
            }
          ],
          "name": "EscrowRegistryUpdated",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "intentHash",
              "type": "bytes32"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "fundsTransferredTo",
              "type": "address"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "amount",
              "type": "uint256"
            },
            {
              "indexed": false,
              "internalType": "bool",
              "name": "isManualRelease",
              "type": "bool"
            }
          ],
          "name": "IntentFulfilled",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "intentHash",
              "type": "bytes32"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "lifecycleHook",
              "type": "address"
            }
          ],
          "name": "IntentLifecycleHookSnapshotted",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "intentHash",
              "type": "bytes32"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "feeRecipient",
              "type": "address"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "fee",
              "type": "uint256"
            }
          ],
          "name": "IntentManagerFeeSnapshotted",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "intentHash",
              "type": "bytes32"
            }
          ],
          "name": "IntentPruned",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "intentHash",
              "type": "bytes32"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "feeRecipient",
              "type": "address"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "feeAmount",
              "type": "uint256"
            }
          ],
          "name": "IntentReferralFeeDistributed",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "intentHash",
              "type": "bytes32"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "escrow",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "indexed": false,
              "internalType": "bytes32",
              "name": "paymentMethod",
              "type": "bytes32"
            },
            {
              "indexed": false,
              "internalType": "address",
              "name": "owner",
              "type": "address"
            },
            {
              "indexed": false,
              "internalType": "address",
              "name": "to",
              "type": "address"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "amount",
              "type": "uint256"
            },
            {
              "indexed": false,
              "internalType": "bytes32",
              "name": "fiatCurrency",
              "type": "bytes32"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "conversionRate",
              "type": "uint256"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "timestamp",
              "type": "uint256"
            }
          ],
          "name": "IntentSignaled",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "previousHook",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "newHook",
              "type": "address"
            }
          ],
          "name": "LifecycleHookUpdated",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "previousOwner",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "newOwner",
              "type": "address"
            }
          ],
          "name": "OwnershipTransferred",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "partialManualReleaseDelay",
              "type": "uint256"
            }
          ],
          "name": "PartialManualReleaseDelayUpdated",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": false,
              "internalType": "address",
              "name": "account",
              "type": "address"
            }
          ],
          "name": "Paused",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "paymentVerifierRegistry",
              "type": "address"
            }
          ],
          "name": "PaymentVerifierRegistryUpdated",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "protocolFeeRecipient",
              "type": "address"
            }
          ],
          "name": "ProtocolFeeRecipientUpdated",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "protocolFee",
              "type": "uint256"
            }
          ],
          "name": "ProtocolFeeUpdated",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "relayerRegistry",
              "type": "address"
            }
          ],
          "name": "RelayerRegistryUpdated",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": false,
              "internalType": "address",
              "name": "account",
              "type": "address"
            }
          ],
          "name": "Unpaused",
          "type": "event"
        },
        {
          "inputs": [],
          "name": "allowMultipleIntents",
          "outputs": [
            {
              "internalType": "bool",
              "name": "",
              "type": "bool"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_intentHash",
              "type": "bytes32"
            }
          ],
          "name": "cancelIntent",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "chainId",
          "outputs": [
            {
              "internalType": "uint256",
              "name": "",
              "type": "uint256"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32[]",
              "name": "_intentHashes",
              "type": "bytes32[]"
            }
          ],
          "name": "cleanupOrphanedIntents",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "escrowRegistry",
          "outputs": [
            {
              "internalType": "contract IEscrowRegistry",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "components": [
                {
                  "internalType": "bytes",
                  "name": "paymentProof",
                  "type": "bytes"
                },
                {
                  "internalType": "bytes32",
                  "name": "intentHash",
                  "type": "bytes32"
                },
                {
                  "internalType": "bytes",
                  "name": "verificationData",
                  "type": "bytes"
                },
                {
                  "internalType": "bytes",
                  "name": "postIntentHookData",
                  "type": "bytes"
                }
              ],
              "internalType": "struct IOrchestratorV3.FulfillIntentParams",
              "name": "_params",
              "type": "tuple"
            }
          ],
          "name": "fulfillIntent",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_account",
              "type": "address"
            }
          ],
          "name": "getAccountIntents",
          "outputs": [
            {
              "internalType": "bytes32[]",
              "name": "",
              "type": "bytes32[]"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_escrow",
              "type": "address"
            },
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            }
          ],
          "name": "getDepositPreIntentHook",
          "outputs": [
            {
              "internalType": "contract IPreIntentHook",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_intentHash",
              "type": "bytes32"
            }
          ],
          "name": "getIntent",
          "outputs": [
            {
              "components": [
                {
                  "internalType": "address",
                  "name": "owner",
                  "type": "address"
                },
                {
                  "internalType": "address",
                  "name": "to",
                  "type": "address"
                },
                {
                  "internalType": "address",
                  "name": "escrow",
                  "type": "address"
                },
                {
                  "internalType": "uint256",
                  "name": "depositId",
                  "type": "uint256"
                },
                {
                  "internalType": "uint256",
                  "name": "amount",
                  "type": "uint256"
                },
                {
                  "internalType": "uint256",
                  "name": "timestamp",
                  "type": "uint256"
                },
                {
                  "internalType": "bytes32",
                  "name": "paymentMethod",
                  "type": "bytes32"
                },
                {
                  "internalType": "bytes32",
                  "name": "fiatCurrency",
                  "type": "bytes32"
                },
                {
                  "internalType": "uint256",
                  "name": "conversionRate",
                  "type": "uint256"
                },
                {
                  "internalType": "bytes32",
                  "name": "payeeId",
                  "type": "bytes32"
                },
                {
                  "components": [
                    {
                      "internalType": "address",
                      "name": "recipient",
                      "type": "address"
                    },
                    {
                      "internalType": "uint256",
                      "name": "fee",
                      "type": "uint256"
                    }
                  ],
                  "internalType": "struct IReferralFee.ReferralFee[]",
                  "name": "referralFees",
                  "type": "tuple[]"
                },
                {
                  "internalType": "contract IPostIntentHookV2",
                  "name": "postIntentHook",
                  "type": "address"
                },
                {
                  "internalType": "bytes",
                  "name": "data",
                  "type": "bytes"
                }
              ],
              "internalType": "struct IOrchestratorV3.Intent",
              "name": "",
              "type": "tuple"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_intentHash",
              "type": "bytes32"
            }
          ],
          "name": "getIntentLifecycleHook",
          "outputs": [
            {
              "internalType": "contract IIntentLifecycleHook",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_intentHash",
              "type": "bytes32"
            }
          ],
          "name": "getIntentMinAtSignal",
          "outputs": [
            {
              "internalType": "uint256",
              "name": "",
              "type": "uint256"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "intentCounter",
          "outputs": [
            {
              "internalType": "uint256",
              "name": "",
              "type": "uint256"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "lifecycleHook",
          "outputs": [
            {
              "internalType": "contract IIntentLifecycleHook",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "owner",
          "outputs": [
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "pauseOrchestrator",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "paused",
          "outputs": [
            {
              "internalType": "bool",
              "name": "",
              "type": "bool"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "paymentVerifierRegistry",
          "outputs": [
            {
              "internalType": "contract IPaymentVerifierRegistry",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "protocolFee",
          "outputs": [
            {
              "internalType": "uint256",
              "name": "",
              "type": "uint256"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "protocolFeeRecipient",
          "outputs": [
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32[]",
              "name": "_intents",
              "type": "bytes32[]"
            }
          ],
          "name": "pruneIntents",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "relayerRegistry",
          "outputs": [
            {
              "internalType": "contract IRelayerRegistry",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_intentHash",
              "type": "bytes32"
            }
          ],
          "name": "releaseFundsToPayer",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "renounceOwnership",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bool",
              "name": "_allowMultiple",
              "type": "bool"
            }
          ],
          "name": "setAllowMultipleIntents",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_escrow",
              "type": "address"
            },
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "contract IPreIntentHook",
              "name": "_hook",
              "type": "address"
            }
          ],
          "name": "setDepositPreIntentHook",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_escrowRegistry",
              "type": "address"
            }
          ],
          "name": "setEscrowRegistry",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "contract IIntentLifecycleHook",
              "name": "_hook",
              "type": "address"
            }
          ],
          "name": "setLifecycleHook",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_protocolFee",
              "type": "uint256"
            }
          ],
          "name": "setProtocolFee",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_protocolFeeRecipient",
              "type": "address"
            }
          ],
          "name": "setProtocolFeeRecipient",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_relayerRegistry",
              "type": "address"
            }
          ],
          "name": "setRelayerRegistry",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "components": [
                {
                  "internalType": "address",
                  "name": "escrow",
                  "type": "address"
                },
                {
                  "internalType": "uint256",
                  "name": "depositId",
                  "type": "uint256"
                },
                {
                  "internalType": "uint256",
                  "name": "amount",
                  "type": "uint256"
                },
                {
                  "internalType": "address",
                  "name": "to",
                  "type": "address"
                },
                {
                  "internalType": "bytes32",
                  "name": "paymentMethod",
                  "type": "bytes32"
                },
                {
                  "internalType": "bytes32",
                  "name": "fiatCurrency",
                  "type": "bytes32"
                },
                {
                  "internalType": "uint256",
                  "name": "conversionRate",
                  "type": "uint256"
                },
                {
                  "components": [
                    {
                      "internalType": "address",
                      "name": "recipient",
                      "type": "address"
                    },
                    {
                      "internalType": "uint256",
                      "name": "fee",
                      "type": "uint256"
                    }
                  ],
                  "internalType": "struct IReferralFee.ReferralFee[]",
                  "name": "referralFees",
                  "type": "tuple[]"
                },
                {
                  "internalType": "bytes",
                  "name": "gatingServiceSignature",
                  "type": "bytes"
                },
                {
                  "internalType": "uint256",
                  "name": "signatureExpiration",
                  "type": "uint256"
                },
                {
                  "internalType": "contract IPostIntentHookV2",
                  "name": "postIntentHook",
                  "type": "address"
                },
                {
                  "internalType": "bytes",
                  "name": "preIntentHookData",
                  "type": "bytes"
                },
                {
                  "internalType": "bytes",
                  "name": "data",
                  "type": "bytes"
                }
              ],
              "internalType": "struct IOrchestratorV3.SignalIntentParams",
              "name": "_params",
              "type": "tuple"
            }
          ],
          "name": "signalIntent",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "newOwner",
              "type": "address"
            }
          ],
          "name": "transferOwnership",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "unpauseOrchestrator",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        }
      ]
    },
    "PaymentVerifierRegistry": {
      "address": "0x2261416DA54C85f975C73FA56EF4D2D6b0aEF7Cc",
      "abi": [
        {
          "inputs": [],
          "stateMutability": "nonpayable",
          "type": "constructor"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "paymentMethod",
              "type": "bytes32"
            },
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "currencyCode",
              "type": "bytes32"
            }
          ],
          "name": "CurrencyAdded",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "paymentMethod",
              "type": "bytes32"
            },
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "currencyCode",
              "type": "bytes32"
            }
          ],
          "name": "CurrencyRemoved",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "previousOwner",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "newOwner",
              "type": "address"
            }
          ],
          "name": "OwnershipTransferred",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "paymentMethod",
              "type": "bytes32"
            }
          ],
          "name": "PaymentMethodAdded",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "paymentMethod",
              "type": "bytes32"
            }
          ],
          "name": "PaymentMethodRemoved",
          "type": "event"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_paymentMethod",
              "type": "bytes32"
            },
            {
              "internalType": "bytes32[]",
              "name": "_currencies",
              "type": "bytes32[]"
            }
          ],
          "name": "addCurrencies",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_paymentMethod",
              "type": "bytes32"
            },
            {
              "internalType": "address",
              "name": "_verifier",
              "type": "address"
            },
            {
              "internalType": "bytes32[]",
              "name": "_currencies",
              "type": "bytes32[]"
            }
          ],
          "name": "addPaymentMethod",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_paymentMethod",
              "type": "bytes32"
            }
          ],
          "name": "getCurrencies",
          "outputs": [
            {
              "internalType": "bytes32[]",
              "name": "",
              "type": "bytes32[]"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "getPaymentMethods",
          "outputs": [
            {
              "internalType": "bytes32[]",
              "name": "",
              "type": "bytes32[]"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_paymentMethod",
              "type": "bytes32"
            }
          ],
          "name": "getVerifier",
          "outputs": [
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_paymentMethod",
              "type": "bytes32"
            },
            {
              "internalType": "bytes32",
              "name": "_currencyCode",
              "type": "bytes32"
            }
          ],
          "name": "isCurrency",
          "outputs": [
            {
              "internalType": "bool",
              "name": "",
              "type": "bool"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_paymentMethod",
              "type": "bytes32"
            }
          ],
          "name": "isPaymentMethod",
          "outputs": [
            {
              "internalType": "bool",
              "name": "",
              "type": "bool"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "owner",
          "outputs": [
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "",
              "type": "uint256"
            }
          ],
          "name": "paymentMethods",
          "outputs": [
            {
              "internalType": "bytes32",
              "name": "",
              "type": "bytes32"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_paymentMethod",
              "type": "bytes32"
            },
            {
              "internalType": "bytes32[]",
              "name": "_currencies",
              "type": "bytes32[]"
            }
          ],
          "name": "removeCurrencies",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_paymentMethod",
              "type": "bytes32"
            }
          ],
          "name": "removePaymentMethod",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "renounceOwnership",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "",
              "type": "bytes32"
            }
          ],
          "name": "store",
          "outputs": [
            {
              "internalType": "bool",
              "name": "initialized",
              "type": "bool"
            },
            {
              "internalType": "address",
              "name": "verifier",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "newOwner",
              "type": "address"
            }
          ],
          "name": "transferOwnership",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        }
      ]
    },
    "PostIntentHookRegistry": {
      "address": "0xA4745c8F735B07fa77cD6EC64A2C77cb787fD0cd",
      "abi": [
        {
          "inputs": [],
          "stateMutability": "nonpayable",
          "type": "constructor"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "previousOwner",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "newOwner",
              "type": "address"
            }
          ],
          "name": "OwnershipTransferred",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "hook",
              "type": "address"
            }
          ],
          "name": "PostIntentHookAdded",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "hook",
              "type": "address"
            }
          ],
          "name": "PostIntentHookRemoved",
          "type": "event"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_hook",
              "type": "address"
            }
          ],
          "name": "addPostIntentHook",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "getWhitelistedHooks",
          "outputs": [
            {
              "internalType": "address[]",
              "name": "",
              "type": "address[]"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "",
              "type": "uint256"
            }
          ],
          "name": "hooks",
          "outputs": [
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_hook",
              "type": "address"
            }
          ],
          "name": "isWhitelistedHook",
          "outputs": [
            {
              "internalType": "bool",
              "name": "",
              "type": "bool"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "owner",
          "outputs": [
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_hook",
              "type": "address"
            }
          ],
          "name": "removePostIntentHook",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "renounceOwnership",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "newOwner",
              "type": "address"
            }
          ],
          "name": "transferOwnership",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            }
          ],
          "name": "whitelistedHooks",
          "outputs": [
            {
              "internalType": "bool",
              "name": "",
              "type": "bool"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        }
      ]
    },
    "ProtocolViewer": {
      "address": "0x1b2FE4FF7530143f38b7D7f4ccd83a3f1a022840",
      "abi": [
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_escrow",
              "type": "address"
            },
            {
              "internalType": "address",
              "name": "_orchestrator",
              "type": "address"
            }
          ],
          "stateMutability": "nonpayable",
          "type": "constructor"
        },
        {
          "inputs": [],
          "name": "escrowContract",
          "outputs": [
            {
              "internalType": "contract IEscrow",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_account",
              "type": "address"
            }
          ],
          "name": "getAccountDeposits",
          "outputs": [
            {
              "components": [
                {
                  "internalType": "uint256",
                  "name": "depositId",
                  "type": "uint256"
                },
                {
                  "components": [
                    {
                      "internalType": "address",
                      "name": "depositor",
                      "type": "address"
                    },
                    {
                      "internalType": "address",
                      "name": "delegate",
                      "type": "address"
                    },
                    {
                      "internalType": "contract IERC20",
                      "name": "token",
                      "type": "address"
                    },
                    {
                      "components": [
                        {
                          "internalType": "uint256",
                          "name": "min",
                          "type": "uint256"
                        },
                        {
                          "internalType": "uint256",
                          "name": "max",
                          "type": "uint256"
                        }
                      ],
                      "internalType": "struct IEscrow.Range",
                      "name": "intentAmountRange",
                      "type": "tuple"
                    },
                    {
                      "internalType": "bool",
                      "name": "acceptingIntents",
                      "type": "bool"
                    },
                    {
                      "internalType": "uint256",
                      "name": "remainingDeposits",
                      "type": "uint256"
                    },
                    {
                      "internalType": "uint256",
                      "name": "outstandingIntentAmount",
                      "type": "uint256"
                    },
                    {
                      "internalType": "address",
                      "name": "intentGuardian",
                      "type": "address"
                    },
                    {
                      "internalType": "bool",
                      "name": "retainOnEmpty",
                      "type": "bool"
                    }
                  ],
                  "internalType": "struct IEscrow.Deposit",
                  "name": "deposit",
                  "type": "tuple"
                },
                {
                  "internalType": "uint256",
                  "name": "availableLiquidity",
                  "type": "uint256"
                },
                {
                  "components": [
                    {
                      "internalType": "bytes32",
                      "name": "paymentMethod",
                      "type": "bytes32"
                    },
                    {
                      "components": [
                        {
                          "internalType": "address",
                          "name": "intentGatingService",
                          "type": "address"
                        },
                        {
                          "internalType": "bytes32",
                          "name": "payeeDetails",
                          "type": "bytes32"
                        },
                        {
                          "internalType": "bytes",
                          "name": "data",
                          "type": "bytes"
                        }
                      ],
                      "internalType": "struct IEscrow.DepositPaymentMethodData",
                      "name": "verificationData",
                      "type": "tuple"
                    },
                    {
                      "components": [
                        {
                          "internalType": "bytes32",
                          "name": "code",
                          "type": "bytes32"
                        },
                        {
                          "internalType": "uint256",
                          "name": "minConversionRate",
                          "type": "uint256"
                        }
                      ],
                      "internalType": "struct IEscrow.Currency[]",
                      "name": "currencies",
                      "type": "tuple[]"
                    }
                  ],
                  "internalType": "struct IProtocolViewer.PaymentMethodDataView[]",
                  "name": "paymentMethods",
                  "type": "tuple[]"
                },
                {
                  "internalType": "bytes32[]",
                  "name": "intentHashes",
                  "type": "bytes32[]"
                }
              ],
              "internalType": "struct IProtocolViewer.DepositView[]",
              "name": "depositArray",
              "type": "tuple[]"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_account",
              "type": "address"
            }
          ],
          "name": "getAccountIntents",
          "outputs": [
            {
              "components": [
                {
                  "internalType": "bytes32",
                  "name": "intentHash",
                  "type": "bytes32"
                },
                {
                  "components": [
                    {
                      "internalType": "address",
                      "name": "owner",
                      "type": "address"
                    },
                    {
                      "internalType": "address",
                      "name": "to",
                      "type": "address"
                    },
                    {
                      "internalType": "address",
                      "name": "escrow",
                      "type": "address"
                    },
                    {
                      "internalType": "uint256",
                      "name": "depositId",
                      "type": "uint256"
                    },
                    {
                      "internalType": "uint256",
                      "name": "amount",
                      "type": "uint256"
                    },
                    {
                      "internalType": "uint256",
                      "name": "timestamp",
                      "type": "uint256"
                    },
                    {
                      "internalType": "bytes32",
                      "name": "paymentMethod",
                      "type": "bytes32"
                    },
                    {
                      "internalType": "bytes32",
                      "name": "fiatCurrency",
                      "type": "bytes32"
                    },
                    {
                      "internalType": "uint256",
                      "name": "conversionRate",
                      "type": "uint256"
                    },
                    {
                      "internalType": "bytes32",
                      "name": "payeeId",
                      "type": "bytes32"
                    },
                    {
                      "internalType": "address",
                      "name": "referrer",
                      "type": "address"
                    },
                    {
                      "internalType": "uint256",
                      "name": "referrerFee",
                      "type": "uint256"
                    },
                    {
                      "internalType": "contract IPostIntentHook",
                      "name": "postIntentHook",
                      "type": "address"
                    },
                    {
                      "internalType": "bytes",
                      "name": "data",
                      "type": "bytes"
                    }
                  ],
                  "internalType": "struct IOrchestrator.Intent",
                  "name": "intent",
                  "type": "tuple"
                },
                {
                  "components": [
                    {
                      "internalType": "uint256",
                      "name": "depositId",
                      "type": "uint256"
                    },
                    {
                      "components": [
                        {
                          "internalType": "address",
                          "name": "depositor",
                          "type": "address"
                        },
                        {
                          "internalType": "address",
                          "name": "delegate",
                          "type": "address"
                        },
                        {
                          "internalType": "contract IERC20",
                          "name": "token",
                          "type": "address"
                        },
                        {
                          "components": [
                            {
                              "internalType": "uint256",
                              "name": "min",
                              "type": "uint256"
                            },
                            {
                              "internalType": "uint256",
                              "name": "max",
                              "type": "uint256"
                            }
                          ],
                          "internalType": "struct IEscrow.Range",
                          "name": "intentAmountRange",
                          "type": "tuple"
                        },
                        {
                          "internalType": "bool",
                          "name": "acceptingIntents",
                          "type": "bool"
                        },
                        {
                          "internalType": "uint256",
                          "name": "remainingDeposits",
                          "type": "uint256"
                        },
                        {
                          "internalType": "uint256",
                          "name": "outstandingIntentAmount",
                          "type": "uint256"
                        },
                        {
                          "internalType": "address",
                          "name": "intentGuardian",
                          "type": "address"
                        },
                        {
                          "internalType": "bool",
                          "name": "retainOnEmpty",
                          "type": "bool"
                        }
                      ],
                      "internalType": "struct IEscrow.Deposit",
                      "name": "deposit",
                      "type": "tuple"
                    },
                    {
                      "internalType": "uint256",
                      "name": "availableLiquidity",
                      "type": "uint256"
                    },
                    {
                      "components": [
                        {
                          "internalType": "bytes32",
                          "name": "paymentMethod",
                          "type": "bytes32"
                        },
                        {
                          "components": [
                            {
                              "internalType": "address",
                              "name": "intentGatingService",
                              "type": "address"
                            },
                            {
                              "internalType": "bytes32",
                              "name": "payeeDetails",
                              "type": "bytes32"
                            },
                            {
                              "internalType": "bytes",
                              "name": "data",
                              "type": "bytes"
                            }
                          ],
                          "internalType": "struct IEscrow.DepositPaymentMethodData",
                          "name": "verificationData",
                          "type": "tuple"
                        },
                        {
                          "components": [
                            {
                              "internalType": "bytes32",
                              "name": "code",
                              "type": "bytes32"
                            },
                            {
                              "internalType": "uint256",
                              "name": "minConversionRate",
                              "type": "uint256"
                            }
                          ],
                          "internalType": "struct IEscrow.Currency[]",
                          "name": "currencies",
                          "type": "tuple[]"
                        }
                      ],
                      "internalType": "struct IProtocolViewer.PaymentMethodDataView[]",
                      "name": "paymentMethods",
                      "type": "tuple[]"
                    },
                    {
                      "internalType": "bytes32[]",
                      "name": "intentHashes",
                      "type": "bytes32[]"
                    }
                  ],
                  "internalType": "struct IProtocolViewer.DepositView",
                  "name": "deposit",
                  "type": "tuple"
                }
              ],
              "internalType": "struct IProtocolViewer.IntentView[]",
              "name": "intentViews",
              "type": "tuple[]"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            }
          ],
          "name": "getDeposit",
          "outputs": [
            {
              "components": [
                {
                  "internalType": "uint256",
                  "name": "depositId",
                  "type": "uint256"
                },
                {
                  "components": [
                    {
                      "internalType": "address",
                      "name": "depositor",
                      "type": "address"
                    },
                    {
                      "internalType": "address",
                      "name": "delegate",
                      "type": "address"
                    },
                    {
                      "internalType": "contract IERC20",
                      "name": "token",
                      "type": "address"
                    },
                    {
                      "components": [
                        {
                          "internalType": "uint256",
                          "name": "min",
                          "type": "uint256"
                        },
                        {
                          "internalType": "uint256",
                          "name": "max",
                          "type": "uint256"
                        }
                      ],
                      "internalType": "struct IEscrow.Range",
                      "name": "intentAmountRange",
                      "type": "tuple"
                    },
                    {
                      "internalType": "bool",
                      "name": "acceptingIntents",
                      "type": "bool"
                    },
                    {
                      "internalType": "uint256",
                      "name": "remainingDeposits",
                      "type": "uint256"
                    },
                    {
                      "internalType": "uint256",
                      "name": "outstandingIntentAmount",
                      "type": "uint256"
                    },
                    {
                      "internalType": "address",
                      "name": "intentGuardian",
                      "type": "address"
                    },
                    {
                      "internalType": "bool",
                      "name": "retainOnEmpty",
                      "type": "bool"
                    }
                  ],
                  "internalType": "struct IEscrow.Deposit",
                  "name": "deposit",
                  "type": "tuple"
                },
                {
                  "internalType": "uint256",
                  "name": "availableLiquidity",
                  "type": "uint256"
                },
                {
                  "components": [
                    {
                      "internalType": "bytes32",
                      "name": "paymentMethod",
                      "type": "bytes32"
                    },
                    {
                      "components": [
                        {
                          "internalType": "address",
                          "name": "intentGatingService",
                          "type": "address"
                        },
                        {
                          "internalType": "bytes32",
                          "name": "payeeDetails",
                          "type": "bytes32"
                        },
                        {
                          "internalType": "bytes",
                          "name": "data",
                          "type": "bytes"
                        }
                      ],
                      "internalType": "struct IEscrow.DepositPaymentMethodData",
                      "name": "verificationData",
                      "type": "tuple"
                    },
                    {
                      "components": [
                        {
                          "internalType": "bytes32",
                          "name": "code",
                          "type": "bytes32"
                        },
                        {
                          "internalType": "uint256",
                          "name": "minConversionRate",
                          "type": "uint256"
                        }
                      ],
                      "internalType": "struct IEscrow.Currency[]",
                      "name": "currencies",
                      "type": "tuple[]"
                    }
                  ],
                  "internalType": "struct IProtocolViewer.PaymentMethodDataView[]",
                  "name": "paymentMethods",
                  "type": "tuple[]"
                },
                {
                  "internalType": "bytes32[]",
                  "name": "intentHashes",
                  "type": "bytes32[]"
                }
              ],
              "internalType": "struct IProtocolViewer.DepositView",
              "name": "depositView",
              "type": "tuple"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256[]",
              "name": "_depositIds",
              "type": "uint256[]"
            }
          ],
          "name": "getDepositFromIds",
          "outputs": [
            {
              "components": [
                {
                  "internalType": "uint256",
                  "name": "depositId",
                  "type": "uint256"
                },
                {
                  "components": [
                    {
                      "internalType": "address",
                      "name": "depositor",
                      "type": "address"
                    },
                    {
                      "internalType": "address",
                      "name": "delegate",
                      "type": "address"
                    },
                    {
                      "internalType": "contract IERC20",
                      "name": "token",
                      "type": "address"
                    },
                    {
                      "components": [
                        {
                          "internalType": "uint256",
                          "name": "min",
                          "type": "uint256"
                        },
                        {
                          "internalType": "uint256",
                          "name": "max",
                          "type": "uint256"
                        }
                      ],
                      "internalType": "struct IEscrow.Range",
                      "name": "intentAmountRange",
                      "type": "tuple"
                    },
                    {
                      "internalType": "bool",
                      "name": "acceptingIntents",
                      "type": "bool"
                    },
                    {
                      "internalType": "uint256",
                      "name": "remainingDeposits",
                      "type": "uint256"
                    },
                    {
                      "internalType": "uint256",
                      "name": "outstandingIntentAmount",
                      "type": "uint256"
                    },
                    {
                      "internalType": "address",
                      "name": "intentGuardian",
                      "type": "address"
                    },
                    {
                      "internalType": "bool",
                      "name": "retainOnEmpty",
                      "type": "bool"
                    }
                  ],
                  "internalType": "struct IEscrow.Deposit",
                  "name": "deposit",
                  "type": "tuple"
                },
                {
                  "internalType": "uint256",
                  "name": "availableLiquidity",
                  "type": "uint256"
                },
                {
                  "components": [
                    {
                      "internalType": "bytes32",
                      "name": "paymentMethod",
                      "type": "bytes32"
                    },
                    {
                      "components": [
                        {
                          "internalType": "address",
                          "name": "intentGatingService",
                          "type": "address"
                        },
                        {
                          "internalType": "bytes32",
                          "name": "payeeDetails",
                          "type": "bytes32"
                        },
                        {
                          "internalType": "bytes",
                          "name": "data",
                          "type": "bytes"
                        }
                      ],
                      "internalType": "struct IEscrow.DepositPaymentMethodData",
                      "name": "verificationData",
                      "type": "tuple"
                    },
                    {
                      "components": [
                        {
                          "internalType": "bytes32",
                          "name": "code",
                          "type": "bytes32"
                        },
                        {
                          "internalType": "uint256",
                          "name": "minConversionRate",
                          "type": "uint256"
                        }
                      ],
                      "internalType": "struct IEscrow.Currency[]",
                      "name": "currencies",
                      "type": "tuple[]"
                    }
                  ],
                  "internalType": "struct IProtocolViewer.PaymentMethodDataView[]",
                  "name": "paymentMethods",
                  "type": "tuple[]"
                },
                {
                  "internalType": "bytes32[]",
                  "name": "intentHashes",
                  "type": "bytes32[]"
                }
              ],
              "internalType": "struct IProtocolViewer.DepositView[]",
              "name": "depositArray",
              "type": "tuple[]"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_intentHash",
              "type": "bytes32"
            }
          ],
          "name": "getIntent",
          "outputs": [
            {
              "components": [
                {
                  "internalType": "bytes32",
                  "name": "intentHash",
                  "type": "bytes32"
                },
                {
                  "components": [
                    {
                      "internalType": "address",
                      "name": "owner",
                      "type": "address"
                    },
                    {
                      "internalType": "address",
                      "name": "to",
                      "type": "address"
                    },
                    {
                      "internalType": "address",
                      "name": "escrow",
                      "type": "address"
                    },
                    {
                      "internalType": "uint256",
                      "name": "depositId",
                      "type": "uint256"
                    },
                    {
                      "internalType": "uint256",
                      "name": "amount",
                      "type": "uint256"
                    },
                    {
                      "internalType": "uint256",
                      "name": "timestamp",
                      "type": "uint256"
                    },
                    {
                      "internalType": "bytes32",
                      "name": "paymentMethod",
                      "type": "bytes32"
                    },
                    {
                      "internalType": "bytes32",
                      "name": "fiatCurrency",
                      "type": "bytes32"
                    },
                    {
                      "internalType": "uint256",
                      "name": "conversionRate",
                      "type": "uint256"
                    },
                    {
                      "internalType": "bytes32",
                      "name": "payeeId",
                      "type": "bytes32"
                    },
                    {
                      "internalType": "address",
                      "name": "referrer",
                      "type": "address"
                    },
                    {
                      "internalType": "uint256",
                      "name": "referrerFee",
                      "type": "uint256"
                    },
                    {
                      "internalType": "contract IPostIntentHook",
                      "name": "postIntentHook",
                      "type": "address"
                    },
                    {
                      "internalType": "bytes",
                      "name": "data",
                      "type": "bytes"
                    }
                  ],
                  "internalType": "struct IOrchestrator.Intent",
                  "name": "intent",
                  "type": "tuple"
                },
                {
                  "components": [
                    {
                      "internalType": "uint256",
                      "name": "depositId",
                      "type": "uint256"
                    },
                    {
                      "components": [
                        {
                          "internalType": "address",
                          "name": "depositor",
                          "type": "address"
                        },
                        {
                          "internalType": "address",
                          "name": "delegate",
                          "type": "address"
                        },
                        {
                          "internalType": "contract IERC20",
                          "name": "token",
                          "type": "address"
                        },
                        {
                          "components": [
                            {
                              "internalType": "uint256",
                              "name": "min",
                              "type": "uint256"
                            },
                            {
                              "internalType": "uint256",
                              "name": "max",
                              "type": "uint256"
                            }
                          ],
                          "internalType": "struct IEscrow.Range",
                          "name": "intentAmountRange",
                          "type": "tuple"
                        },
                        {
                          "internalType": "bool",
                          "name": "acceptingIntents",
                          "type": "bool"
                        },
                        {
                          "internalType": "uint256",
                          "name": "remainingDeposits",
                          "type": "uint256"
                        },
                        {
                          "internalType": "uint256",
                          "name": "outstandingIntentAmount",
                          "type": "uint256"
                        },
                        {
                          "internalType": "address",
                          "name": "intentGuardian",
                          "type": "address"
                        },
                        {
                          "internalType": "bool",
                          "name": "retainOnEmpty",
                          "type": "bool"
                        }
                      ],
                      "internalType": "struct IEscrow.Deposit",
                      "name": "deposit",
                      "type": "tuple"
                    },
                    {
                      "internalType": "uint256",
                      "name": "availableLiquidity",
                      "type": "uint256"
                    },
                    {
                      "components": [
                        {
                          "internalType": "bytes32",
                          "name": "paymentMethod",
                          "type": "bytes32"
                        },
                        {
                          "components": [
                            {
                              "internalType": "address",
                              "name": "intentGatingService",
                              "type": "address"
                            },
                            {
                              "internalType": "bytes32",
                              "name": "payeeDetails",
                              "type": "bytes32"
                            },
                            {
                              "internalType": "bytes",
                              "name": "data",
                              "type": "bytes"
                            }
                          ],
                          "internalType": "struct IEscrow.DepositPaymentMethodData",
                          "name": "verificationData",
                          "type": "tuple"
                        },
                        {
                          "components": [
                            {
                              "internalType": "bytes32",
                              "name": "code",
                              "type": "bytes32"
                            },
                            {
                              "internalType": "uint256",
                              "name": "minConversionRate",
                              "type": "uint256"
                            }
                          ],
                          "internalType": "struct IEscrow.Currency[]",
                          "name": "currencies",
                          "type": "tuple[]"
                        }
                      ],
                      "internalType": "struct IProtocolViewer.PaymentMethodDataView[]",
                      "name": "paymentMethods",
                      "type": "tuple[]"
                    },
                    {
                      "internalType": "bytes32[]",
                      "name": "intentHashes",
                      "type": "bytes32[]"
                    }
                  ],
                  "internalType": "struct IProtocolViewer.DepositView",
                  "name": "deposit",
                  "type": "tuple"
                }
              ],
              "internalType": "struct IProtocolViewer.IntentView",
              "name": "intentView",
              "type": "tuple"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32[]",
              "name": "_intentHashes",
              "type": "bytes32[]"
            }
          ],
          "name": "getIntents",
          "outputs": [
            {
              "components": [
                {
                  "internalType": "bytes32",
                  "name": "intentHash",
                  "type": "bytes32"
                },
                {
                  "components": [
                    {
                      "internalType": "address",
                      "name": "owner",
                      "type": "address"
                    },
                    {
                      "internalType": "address",
                      "name": "to",
                      "type": "address"
                    },
                    {
                      "internalType": "address",
                      "name": "escrow",
                      "type": "address"
                    },
                    {
                      "internalType": "uint256",
                      "name": "depositId",
                      "type": "uint256"
                    },
                    {
                      "internalType": "uint256",
                      "name": "amount",
                      "type": "uint256"
                    },
                    {
                      "internalType": "uint256",
                      "name": "timestamp",
                      "type": "uint256"
                    },
                    {
                      "internalType": "bytes32",
                      "name": "paymentMethod",
                      "type": "bytes32"
                    },
                    {
                      "internalType": "bytes32",
                      "name": "fiatCurrency",
                      "type": "bytes32"
                    },
                    {
                      "internalType": "uint256",
                      "name": "conversionRate",
                      "type": "uint256"
                    },
                    {
                      "internalType": "bytes32",
                      "name": "payeeId",
                      "type": "bytes32"
                    },
                    {
                      "internalType": "address",
                      "name": "referrer",
                      "type": "address"
                    },
                    {
                      "internalType": "uint256",
                      "name": "referrerFee",
                      "type": "uint256"
                    },
                    {
                      "internalType": "contract IPostIntentHook",
                      "name": "postIntentHook",
                      "type": "address"
                    },
                    {
                      "internalType": "bytes",
                      "name": "data",
                      "type": "bytes"
                    }
                  ],
                  "internalType": "struct IOrchestrator.Intent",
                  "name": "intent",
                  "type": "tuple"
                },
                {
                  "components": [
                    {
                      "internalType": "uint256",
                      "name": "depositId",
                      "type": "uint256"
                    },
                    {
                      "components": [
                        {
                          "internalType": "address",
                          "name": "depositor",
                          "type": "address"
                        },
                        {
                          "internalType": "address",
                          "name": "delegate",
                          "type": "address"
                        },
                        {
                          "internalType": "contract IERC20",
                          "name": "token",
                          "type": "address"
                        },
                        {
                          "components": [
                            {
                              "internalType": "uint256",
                              "name": "min",
                              "type": "uint256"
                            },
                            {
                              "internalType": "uint256",
                              "name": "max",
                              "type": "uint256"
                            }
                          ],
                          "internalType": "struct IEscrow.Range",
                          "name": "intentAmountRange",
                          "type": "tuple"
                        },
                        {
                          "internalType": "bool",
                          "name": "acceptingIntents",
                          "type": "bool"
                        },
                        {
                          "internalType": "uint256",
                          "name": "remainingDeposits",
                          "type": "uint256"
                        },
                        {
                          "internalType": "uint256",
                          "name": "outstandingIntentAmount",
                          "type": "uint256"
                        },
                        {
                          "internalType": "address",
                          "name": "intentGuardian",
                          "type": "address"
                        },
                        {
                          "internalType": "bool",
                          "name": "retainOnEmpty",
                          "type": "bool"
                        }
                      ],
                      "internalType": "struct IEscrow.Deposit",
                      "name": "deposit",
                      "type": "tuple"
                    },
                    {
                      "internalType": "uint256",
                      "name": "availableLiquidity",
                      "type": "uint256"
                    },
                    {
                      "components": [
                        {
                          "internalType": "bytes32",
                          "name": "paymentMethod",
                          "type": "bytes32"
                        },
                        {
                          "components": [
                            {
                              "internalType": "address",
                              "name": "intentGatingService",
                              "type": "address"
                            },
                            {
                              "internalType": "bytes32",
                              "name": "payeeDetails",
                              "type": "bytes32"
                            },
                            {
                              "internalType": "bytes",
                              "name": "data",
                              "type": "bytes"
                            }
                          ],
                          "internalType": "struct IEscrow.DepositPaymentMethodData",
                          "name": "verificationData",
                          "type": "tuple"
                        },
                        {
                          "components": [
                            {
                              "internalType": "bytes32",
                              "name": "code",
                              "type": "bytes32"
                            },
                            {
                              "internalType": "uint256",
                              "name": "minConversionRate",
                              "type": "uint256"
                            }
                          ],
                          "internalType": "struct IEscrow.Currency[]",
                          "name": "currencies",
                          "type": "tuple[]"
                        }
                      ],
                      "internalType": "struct IProtocolViewer.PaymentMethodDataView[]",
                      "name": "paymentMethods",
                      "type": "tuple[]"
                    },
                    {
                      "internalType": "bytes32[]",
                      "name": "intentHashes",
                      "type": "bytes32[]"
                    }
                  ],
                  "internalType": "struct IProtocolViewer.DepositView",
                  "name": "deposit",
                  "type": "tuple"
                }
              ],
              "internalType": "struct IProtocolViewer.IntentView[]",
              "name": "intentArray",
              "type": "tuple[]"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "orchestrator",
          "outputs": [
            {
              "internalType": "contract IOrchestrator",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        }
      ]
    },
    "ProtocolViewerV2": {
      "address": "0x5079E5aD9aF58E0B7F512C977720106A1494f684",
      "abi": [
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "escrow",
              "type": "address"
            }
          ],
          "name": "InvalidEscrow",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "orchestrator",
              "type": "address"
            }
          ],
          "name": "InvalidOrchestrator",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_orchestrator",
              "type": "address"
            },
            {
              "internalType": "address",
              "name": "_account",
              "type": "address"
            }
          ],
          "name": "getAccountIntents",
          "outputs": [
            {
              "components": [
                {
                  "internalType": "bytes32",
                  "name": "intentHash",
                  "type": "bytes32"
                },
                {
                  "components": [
                    {
                      "internalType": "address",
                      "name": "owner",
                      "type": "address"
                    },
                    {
                      "internalType": "address",
                      "name": "to",
                      "type": "address"
                    },
                    {
                      "internalType": "address",
                      "name": "escrow",
                      "type": "address"
                    },
                    {
                      "internalType": "uint256",
                      "name": "depositId",
                      "type": "uint256"
                    },
                    {
                      "internalType": "uint256",
                      "name": "amount",
                      "type": "uint256"
                    },
                    {
                      "internalType": "uint256",
                      "name": "timestamp",
                      "type": "uint256"
                    },
                    {
                      "internalType": "bytes32",
                      "name": "paymentMethod",
                      "type": "bytes32"
                    },
                    {
                      "internalType": "bytes32",
                      "name": "fiatCurrency",
                      "type": "bytes32"
                    },
                    {
                      "internalType": "uint256",
                      "name": "conversionRate",
                      "type": "uint256"
                    },
                    {
                      "internalType": "bytes32",
                      "name": "payeeId",
                      "type": "bytes32"
                    },
                    {
                      "components": [
                        {
                          "internalType": "address",
                          "name": "recipient",
                          "type": "address"
                        },
                        {
                          "internalType": "uint256",
                          "name": "fee",
                          "type": "uint256"
                        }
                      ],
                      "internalType": "struct IReferralFee.ReferralFee[]",
                      "name": "referralFees",
                      "type": "tuple[]"
                    },
                    {
                      "internalType": "contract IPostIntentHookV2",
                      "name": "postIntentHook",
                      "type": "address"
                    },
                    {
                      "internalType": "bytes",
                      "name": "data",
                      "type": "bytes"
                    }
                  ],
                  "internalType": "struct IOrchestratorV2.Intent",
                  "name": "intent",
                  "type": "tuple"
                },
                {
                  "components": [
                    {
                      "internalType": "uint256",
                      "name": "depositId",
                      "type": "uint256"
                    },
                    {
                      "components": [
                        {
                          "internalType": "address",
                          "name": "depositor",
                          "type": "address"
                        },
                        {
                          "internalType": "address",
                          "name": "delegate",
                          "type": "address"
                        },
                        {
                          "internalType": "contract IERC20",
                          "name": "token",
                          "type": "address"
                        },
                        {
                          "components": [
                            {
                              "internalType": "uint256",
                              "name": "min",
                              "type": "uint256"
                            },
                            {
                              "internalType": "uint256",
                              "name": "max",
                              "type": "uint256"
                            }
                          ],
                          "internalType": "struct IEscrow.Range",
                          "name": "intentAmountRange",
                          "type": "tuple"
                        },
                        {
                          "internalType": "bool",
                          "name": "acceptingIntents",
                          "type": "bool"
                        },
                        {
                          "internalType": "uint256",
                          "name": "remainingDeposits",
                          "type": "uint256"
                        },
                        {
                          "internalType": "uint256",
                          "name": "outstandingIntentAmount",
                          "type": "uint256"
                        },
                        {
                          "internalType": "address",
                          "name": "intentGuardian",
                          "type": "address"
                        },
                        {
                          "internalType": "bool",
                          "name": "retainOnEmpty",
                          "type": "bool"
                        }
                      ],
                      "internalType": "struct IEscrow.Deposit",
                      "name": "deposit",
                      "type": "tuple"
                    },
                    {
                      "internalType": "uint256",
                      "name": "availableLiquidity",
                      "type": "uint256"
                    },
                    {
                      "components": [
                        {
                          "internalType": "bytes32",
                          "name": "paymentMethod",
                          "type": "bytes32"
                        },
                        {
                          "components": [
                            {
                              "internalType": "address",
                              "name": "intentGatingService",
                              "type": "address"
                            },
                            {
                              "internalType": "bytes32",
                              "name": "payeeDetails",
                              "type": "bytes32"
                            },
                            {
                              "internalType": "bytes",
                              "name": "data",
                              "type": "bytes"
                            }
                          ],
                          "internalType": "struct IEscrow.DepositPaymentMethodData",
                          "name": "verificationData",
                          "type": "tuple"
                        },
                        {
                          "components": [
                            {
                              "internalType": "bytes32",
                              "name": "code",
                              "type": "bytes32"
                            },
                            {
                              "internalType": "uint256",
                              "name": "minConversionRate",
                              "type": "uint256"
                            }
                          ],
                          "internalType": "struct IEscrow.Currency[]",
                          "name": "currencies",
                          "type": "tuple[]"
                        }
                      ],
                      "internalType": "struct IProtocolViewerV2.PaymentMethodDataView[]",
                      "name": "paymentMethods",
                      "type": "tuple[]"
                    },
                    {
                      "internalType": "bytes32[]",
                      "name": "intentHashes",
                      "type": "bytes32[]"
                    }
                  ],
                  "internalType": "struct IProtocolViewerV2.DepositView",
                  "name": "deposit",
                  "type": "tuple"
                }
              ],
              "internalType": "struct IProtocolViewerV2.IntentView[]",
              "name": "intentViews",
              "type": "tuple[]"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_escrow",
              "type": "address"
            },
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            }
          ],
          "name": "getDeposit",
          "outputs": [
            {
              "components": [
                {
                  "internalType": "uint256",
                  "name": "depositId",
                  "type": "uint256"
                },
                {
                  "components": [
                    {
                      "internalType": "address",
                      "name": "depositor",
                      "type": "address"
                    },
                    {
                      "internalType": "address",
                      "name": "delegate",
                      "type": "address"
                    },
                    {
                      "internalType": "contract IERC20",
                      "name": "token",
                      "type": "address"
                    },
                    {
                      "components": [
                        {
                          "internalType": "uint256",
                          "name": "min",
                          "type": "uint256"
                        },
                        {
                          "internalType": "uint256",
                          "name": "max",
                          "type": "uint256"
                        }
                      ],
                      "internalType": "struct IEscrow.Range",
                      "name": "intentAmountRange",
                      "type": "tuple"
                    },
                    {
                      "internalType": "bool",
                      "name": "acceptingIntents",
                      "type": "bool"
                    },
                    {
                      "internalType": "uint256",
                      "name": "remainingDeposits",
                      "type": "uint256"
                    },
                    {
                      "internalType": "uint256",
                      "name": "outstandingIntentAmount",
                      "type": "uint256"
                    },
                    {
                      "internalType": "address",
                      "name": "intentGuardian",
                      "type": "address"
                    },
                    {
                      "internalType": "bool",
                      "name": "retainOnEmpty",
                      "type": "bool"
                    }
                  ],
                  "internalType": "struct IEscrow.Deposit",
                  "name": "deposit",
                  "type": "tuple"
                },
                {
                  "internalType": "uint256",
                  "name": "availableLiquidity",
                  "type": "uint256"
                },
                {
                  "components": [
                    {
                      "internalType": "bytes32",
                      "name": "paymentMethod",
                      "type": "bytes32"
                    },
                    {
                      "components": [
                        {
                          "internalType": "address",
                          "name": "intentGatingService",
                          "type": "address"
                        },
                        {
                          "internalType": "bytes32",
                          "name": "payeeDetails",
                          "type": "bytes32"
                        },
                        {
                          "internalType": "bytes",
                          "name": "data",
                          "type": "bytes"
                        }
                      ],
                      "internalType": "struct IEscrow.DepositPaymentMethodData",
                      "name": "verificationData",
                      "type": "tuple"
                    },
                    {
                      "components": [
                        {
                          "internalType": "bytes32",
                          "name": "code",
                          "type": "bytes32"
                        },
                        {
                          "internalType": "uint256",
                          "name": "minConversionRate",
                          "type": "uint256"
                        }
                      ],
                      "internalType": "struct IEscrow.Currency[]",
                      "name": "currencies",
                      "type": "tuple[]"
                    }
                  ],
                  "internalType": "struct IProtocolViewerV2.PaymentMethodDataView[]",
                  "name": "paymentMethods",
                  "type": "tuple[]"
                },
                {
                  "internalType": "bytes32[]",
                  "name": "intentHashes",
                  "type": "bytes32[]"
                }
              ],
              "internalType": "struct IProtocolViewerV2.DepositView",
              "name": "depositView",
              "type": "tuple"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_escrow",
              "type": "address"
            },
            {
              "internalType": "uint256[]",
              "name": "_depositIds",
              "type": "uint256[]"
            }
          ],
          "name": "getDepositFromIds",
          "outputs": [
            {
              "components": [
                {
                  "internalType": "uint256",
                  "name": "depositId",
                  "type": "uint256"
                },
                {
                  "components": [
                    {
                      "internalType": "address",
                      "name": "depositor",
                      "type": "address"
                    },
                    {
                      "internalType": "address",
                      "name": "delegate",
                      "type": "address"
                    },
                    {
                      "internalType": "contract IERC20",
                      "name": "token",
                      "type": "address"
                    },
                    {
                      "components": [
                        {
                          "internalType": "uint256",
                          "name": "min",
                          "type": "uint256"
                        },
                        {
                          "internalType": "uint256",
                          "name": "max",
                          "type": "uint256"
                        }
                      ],
                      "internalType": "struct IEscrow.Range",
                      "name": "intentAmountRange",
                      "type": "tuple"
                    },
                    {
                      "internalType": "bool",
                      "name": "acceptingIntents",
                      "type": "bool"
                    },
                    {
                      "internalType": "uint256",
                      "name": "remainingDeposits",
                      "type": "uint256"
                    },
                    {
                      "internalType": "uint256",
                      "name": "outstandingIntentAmount",
                      "type": "uint256"
                    },
                    {
                      "internalType": "address",
                      "name": "intentGuardian",
                      "type": "address"
                    },
                    {
                      "internalType": "bool",
                      "name": "retainOnEmpty",
                      "type": "bool"
                    }
                  ],
                  "internalType": "struct IEscrow.Deposit",
                  "name": "deposit",
                  "type": "tuple"
                },
                {
                  "internalType": "uint256",
                  "name": "availableLiquidity",
                  "type": "uint256"
                },
                {
                  "components": [
                    {
                      "internalType": "bytes32",
                      "name": "paymentMethod",
                      "type": "bytes32"
                    },
                    {
                      "components": [
                        {
                          "internalType": "address",
                          "name": "intentGatingService",
                          "type": "address"
                        },
                        {
                          "internalType": "bytes32",
                          "name": "payeeDetails",
                          "type": "bytes32"
                        },
                        {
                          "internalType": "bytes",
                          "name": "data",
                          "type": "bytes"
                        }
                      ],
                      "internalType": "struct IEscrow.DepositPaymentMethodData",
                      "name": "verificationData",
                      "type": "tuple"
                    },
                    {
                      "components": [
                        {
                          "internalType": "bytes32",
                          "name": "code",
                          "type": "bytes32"
                        },
                        {
                          "internalType": "uint256",
                          "name": "minConversionRate",
                          "type": "uint256"
                        }
                      ],
                      "internalType": "struct IEscrow.Currency[]",
                      "name": "currencies",
                      "type": "tuple[]"
                    }
                  ],
                  "internalType": "struct IProtocolViewerV2.PaymentMethodDataView[]",
                  "name": "paymentMethods",
                  "type": "tuple[]"
                },
                {
                  "internalType": "bytes32[]",
                  "name": "intentHashes",
                  "type": "bytes32[]"
                }
              ],
              "internalType": "struct IProtocolViewerV2.DepositView[]",
              "name": "depositArray",
              "type": "tuple[]"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_orchestrator",
              "type": "address"
            },
            {
              "internalType": "bytes32",
              "name": "_intentHash",
              "type": "bytes32"
            }
          ],
          "name": "getIntent",
          "outputs": [
            {
              "components": [
                {
                  "internalType": "bytes32",
                  "name": "intentHash",
                  "type": "bytes32"
                },
                {
                  "components": [
                    {
                      "internalType": "address",
                      "name": "owner",
                      "type": "address"
                    },
                    {
                      "internalType": "address",
                      "name": "to",
                      "type": "address"
                    },
                    {
                      "internalType": "address",
                      "name": "escrow",
                      "type": "address"
                    },
                    {
                      "internalType": "uint256",
                      "name": "depositId",
                      "type": "uint256"
                    },
                    {
                      "internalType": "uint256",
                      "name": "amount",
                      "type": "uint256"
                    },
                    {
                      "internalType": "uint256",
                      "name": "timestamp",
                      "type": "uint256"
                    },
                    {
                      "internalType": "bytes32",
                      "name": "paymentMethod",
                      "type": "bytes32"
                    },
                    {
                      "internalType": "bytes32",
                      "name": "fiatCurrency",
                      "type": "bytes32"
                    },
                    {
                      "internalType": "uint256",
                      "name": "conversionRate",
                      "type": "uint256"
                    },
                    {
                      "internalType": "bytes32",
                      "name": "payeeId",
                      "type": "bytes32"
                    },
                    {
                      "components": [
                        {
                          "internalType": "address",
                          "name": "recipient",
                          "type": "address"
                        },
                        {
                          "internalType": "uint256",
                          "name": "fee",
                          "type": "uint256"
                        }
                      ],
                      "internalType": "struct IReferralFee.ReferralFee[]",
                      "name": "referralFees",
                      "type": "tuple[]"
                    },
                    {
                      "internalType": "contract IPostIntentHookV2",
                      "name": "postIntentHook",
                      "type": "address"
                    },
                    {
                      "internalType": "bytes",
                      "name": "data",
                      "type": "bytes"
                    }
                  ],
                  "internalType": "struct IOrchestratorV2.Intent",
                  "name": "intent",
                  "type": "tuple"
                },
                {
                  "components": [
                    {
                      "internalType": "uint256",
                      "name": "depositId",
                      "type": "uint256"
                    },
                    {
                      "components": [
                        {
                          "internalType": "address",
                          "name": "depositor",
                          "type": "address"
                        },
                        {
                          "internalType": "address",
                          "name": "delegate",
                          "type": "address"
                        },
                        {
                          "internalType": "contract IERC20",
                          "name": "token",
                          "type": "address"
                        },
                        {
                          "components": [
                            {
                              "internalType": "uint256",
                              "name": "min",
                              "type": "uint256"
                            },
                            {
                              "internalType": "uint256",
                              "name": "max",
                              "type": "uint256"
                            }
                          ],
                          "internalType": "struct IEscrow.Range",
                          "name": "intentAmountRange",
                          "type": "tuple"
                        },
                        {
                          "internalType": "bool",
                          "name": "acceptingIntents",
                          "type": "bool"
                        },
                        {
                          "internalType": "uint256",
                          "name": "remainingDeposits",
                          "type": "uint256"
                        },
                        {
                          "internalType": "uint256",
                          "name": "outstandingIntentAmount",
                          "type": "uint256"
                        },
                        {
                          "internalType": "address",
                          "name": "intentGuardian",
                          "type": "address"
                        },
                        {
                          "internalType": "bool",
                          "name": "retainOnEmpty",
                          "type": "bool"
                        }
                      ],
                      "internalType": "struct IEscrow.Deposit",
                      "name": "deposit",
                      "type": "tuple"
                    },
                    {
                      "internalType": "uint256",
                      "name": "availableLiquidity",
                      "type": "uint256"
                    },
                    {
                      "components": [
                        {
                          "internalType": "bytes32",
                          "name": "paymentMethod",
                          "type": "bytes32"
                        },
                        {
                          "components": [
                            {
                              "internalType": "address",
                              "name": "intentGatingService",
                              "type": "address"
                            },
                            {
                              "internalType": "bytes32",
                              "name": "payeeDetails",
                              "type": "bytes32"
                            },
                            {
                              "internalType": "bytes",
                              "name": "data",
                              "type": "bytes"
                            }
                          ],
                          "internalType": "struct IEscrow.DepositPaymentMethodData",
                          "name": "verificationData",
                          "type": "tuple"
                        },
                        {
                          "components": [
                            {
                              "internalType": "bytes32",
                              "name": "code",
                              "type": "bytes32"
                            },
                            {
                              "internalType": "uint256",
                              "name": "minConversionRate",
                              "type": "uint256"
                            }
                          ],
                          "internalType": "struct IEscrow.Currency[]",
                          "name": "currencies",
                          "type": "tuple[]"
                        }
                      ],
                      "internalType": "struct IProtocolViewerV2.PaymentMethodDataView[]",
                      "name": "paymentMethods",
                      "type": "tuple[]"
                    },
                    {
                      "internalType": "bytes32[]",
                      "name": "intentHashes",
                      "type": "bytes32[]"
                    }
                  ],
                  "internalType": "struct IProtocolViewerV2.DepositView",
                  "name": "deposit",
                  "type": "tuple"
                }
              ],
              "internalType": "struct IProtocolViewerV2.IntentView",
              "name": "intentView",
              "type": "tuple"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_orchestrator",
              "type": "address"
            },
            {
              "internalType": "bytes32[]",
              "name": "_intentHashes",
              "type": "bytes32[]"
            }
          ],
          "name": "getIntents",
          "outputs": [
            {
              "components": [
                {
                  "internalType": "bytes32",
                  "name": "intentHash",
                  "type": "bytes32"
                },
                {
                  "components": [
                    {
                      "internalType": "address",
                      "name": "owner",
                      "type": "address"
                    },
                    {
                      "internalType": "address",
                      "name": "to",
                      "type": "address"
                    },
                    {
                      "internalType": "address",
                      "name": "escrow",
                      "type": "address"
                    },
                    {
                      "internalType": "uint256",
                      "name": "depositId",
                      "type": "uint256"
                    },
                    {
                      "internalType": "uint256",
                      "name": "amount",
                      "type": "uint256"
                    },
                    {
                      "internalType": "uint256",
                      "name": "timestamp",
                      "type": "uint256"
                    },
                    {
                      "internalType": "bytes32",
                      "name": "paymentMethod",
                      "type": "bytes32"
                    },
                    {
                      "internalType": "bytes32",
                      "name": "fiatCurrency",
                      "type": "bytes32"
                    },
                    {
                      "internalType": "uint256",
                      "name": "conversionRate",
                      "type": "uint256"
                    },
                    {
                      "internalType": "bytes32",
                      "name": "payeeId",
                      "type": "bytes32"
                    },
                    {
                      "components": [
                        {
                          "internalType": "address",
                          "name": "recipient",
                          "type": "address"
                        },
                        {
                          "internalType": "uint256",
                          "name": "fee",
                          "type": "uint256"
                        }
                      ],
                      "internalType": "struct IReferralFee.ReferralFee[]",
                      "name": "referralFees",
                      "type": "tuple[]"
                    },
                    {
                      "internalType": "contract IPostIntentHookV2",
                      "name": "postIntentHook",
                      "type": "address"
                    },
                    {
                      "internalType": "bytes",
                      "name": "data",
                      "type": "bytes"
                    }
                  ],
                  "internalType": "struct IOrchestratorV2.Intent",
                  "name": "intent",
                  "type": "tuple"
                },
                {
                  "components": [
                    {
                      "internalType": "uint256",
                      "name": "depositId",
                      "type": "uint256"
                    },
                    {
                      "components": [
                        {
                          "internalType": "address",
                          "name": "depositor",
                          "type": "address"
                        },
                        {
                          "internalType": "address",
                          "name": "delegate",
                          "type": "address"
                        },
                        {
                          "internalType": "contract IERC20",
                          "name": "token",
                          "type": "address"
                        },
                        {
                          "components": [
                            {
                              "internalType": "uint256",
                              "name": "min",
                              "type": "uint256"
                            },
                            {
                              "internalType": "uint256",
                              "name": "max",
                              "type": "uint256"
                            }
                          ],
                          "internalType": "struct IEscrow.Range",
                          "name": "intentAmountRange",
                          "type": "tuple"
                        },
                        {
                          "internalType": "bool",
                          "name": "acceptingIntents",
                          "type": "bool"
                        },
                        {
                          "internalType": "uint256",
                          "name": "remainingDeposits",
                          "type": "uint256"
                        },
                        {
                          "internalType": "uint256",
                          "name": "outstandingIntentAmount",
                          "type": "uint256"
                        },
                        {
                          "internalType": "address",
                          "name": "intentGuardian",
                          "type": "address"
                        },
                        {
                          "internalType": "bool",
                          "name": "retainOnEmpty",
                          "type": "bool"
                        }
                      ],
                      "internalType": "struct IEscrow.Deposit",
                      "name": "deposit",
                      "type": "tuple"
                    },
                    {
                      "internalType": "uint256",
                      "name": "availableLiquidity",
                      "type": "uint256"
                    },
                    {
                      "components": [
                        {
                          "internalType": "bytes32",
                          "name": "paymentMethod",
                          "type": "bytes32"
                        },
                        {
                          "components": [
                            {
                              "internalType": "address",
                              "name": "intentGatingService",
                              "type": "address"
                            },
                            {
                              "internalType": "bytes32",
                              "name": "payeeDetails",
                              "type": "bytes32"
                            },
                            {
                              "internalType": "bytes",
                              "name": "data",
                              "type": "bytes"
                            }
                          ],
                          "internalType": "struct IEscrow.DepositPaymentMethodData",
                          "name": "verificationData",
                          "type": "tuple"
                        },
                        {
                          "components": [
                            {
                              "internalType": "bytes32",
                              "name": "code",
                              "type": "bytes32"
                            },
                            {
                              "internalType": "uint256",
                              "name": "minConversionRate",
                              "type": "uint256"
                            }
                          ],
                          "internalType": "struct IEscrow.Currency[]",
                          "name": "currencies",
                          "type": "tuple[]"
                        }
                      ],
                      "internalType": "struct IProtocolViewerV2.PaymentMethodDataView[]",
                      "name": "paymentMethods",
                      "type": "tuple[]"
                    },
                    {
                      "internalType": "bytes32[]",
                      "name": "intentHashes",
                      "type": "bytes32[]"
                    }
                  ],
                  "internalType": "struct IProtocolViewerV2.DepositView",
                  "name": "deposit",
                  "type": "tuple"
                }
              ],
              "internalType": "struct IProtocolViewerV2.IntentView[]",
              "name": "intentArray",
              "type": "tuple[]"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        }
      ]
    },
    "PythOracleAdapter": {
      "address": "0xaa2bBDa3072bD37af76613846268Ec48bd0bB885",
      "abi": [
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_pyth",
              "type": "address"
            }
          ],
          "stateMutability": "nonpayable",
          "type": "constructor"
        },
        {
          "inputs": [
            {
              "internalType": "bytes",
              "name": "normalizedConfig",
              "type": "bytes"
            }
          ],
          "name": "getRate",
          "outputs": [
            {
              "internalType": "bool",
              "name": "valid",
              "type": "bool"
            },
            {
              "internalType": "uint256",
              "name": "rate",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "updatedAt",
              "type": "uint256"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "pyth",
          "outputs": [
            {
              "internalType": "contract IPyth",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes",
              "name": "rawConfig",
              "type": "bytes"
            }
          ],
          "name": "validateConfig",
          "outputs": [
            {
              "internalType": "bytes",
              "name": "normalizedConfig",
              "type": "bytes"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        }
      ]
    },
    "RateManagerV1": {
      "address": "0x9d773Af159538369b4842e40510562016E3eD3d7",
      "abi": [
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_escrowRegistry",
              "type": "address"
            }
          ],
          "stateMutability": "nonpayable",
          "type": "constructor"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "length1",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "length2",
              "type": "uint256"
            }
          ],
          "name": "ArrayLengthMismatch",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "totalLiquidity",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "required",
              "type": "uint256"
            }
          ],
          "name": "BelowMinLiquidity",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "fee",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "maximum",
              "type": "uint256"
            }
          ],
          "name": "FeeExceedsMaximum",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "rateManagerId",
              "type": "bytes32"
            }
          ],
          "name": "RateManagerNotFound",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "caller",
              "type": "address"
            },
            {
              "internalType": "address",
              "name": "authorized",
              "type": "address"
            }
          ],
          "name": "UnauthorizedCaller",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "escrow",
              "type": "address"
            }
          ],
          "name": "UnauthorizedEscrow",
          "type": "error"
        },
        {
          "inputs": [],
          "name": "ZeroAddress",
          "type": "error"
        },
        {
          "inputs": [],
          "name": "ZeroValue",
          "type": "error"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "escrowRegistry",
              "type": "address"
            }
          ],
          "name": "EscrowRegistryUpdated",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "rateManagerId",
              "type": "bytes32"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "minLiquidity",
              "type": "uint256"
            }
          ],
          "name": "MinLiquidityUpdated",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "previousOwner",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "newOwner",
              "type": "address"
            }
          ],
          "name": "OwnershipTransferred",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "rateManagerId",
              "type": "bytes32"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "manager",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "feeRecipient",
              "type": "address"
            },
            {
              "indexed": false,
              "internalType": "string",
              "name": "name",
              "type": "string"
            },
            {
              "indexed": false,
              "internalType": "string",
              "name": "uri",
              "type": "string"
            }
          ],
          "name": "RateManagerConfigUpdated",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "rateManagerId",
              "type": "bytes32"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "manager",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "feeRecipient",
              "type": "address"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "maxFee",
              "type": "uint256"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "fee",
              "type": "uint256"
            },
            {
              "indexed": false,
              "internalType": "string",
              "name": "name",
              "type": "string"
            },
            {
              "indexed": false,
              "internalType": "string",
              "name": "uri",
              "type": "string"
            }
          ],
          "name": "RateManagerCreated",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "rateManagerId",
              "type": "bytes32"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "fee",
              "type": "uint256"
            }
          ],
          "name": "RateManagerFeeUpdated",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "rateManagerId",
              "type": "bytes32"
            },
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "paymentMethod",
              "type": "bytes32"
            },
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "currencyCode",
              "type": "bytes32"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "rate",
              "type": "uint256"
            }
          ],
          "name": "RateManagerRateUpdated",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "rateManagerId",
              "type": "bytes32"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "totalUpdated",
              "type": "uint256"
            }
          ],
          "name": "RateManagerRatesBatchUpdated",
          "type": "event"
        },
        {
          "inputs": [],
          "name": "GLOBAL_MAX_MANAGER_FEE",
          "outputs": [
            {
              "internalType": "uint256",
              "name": "",
              "type": "uint256"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "components": [
                {
                  "internalType": "address",
                  "name": "manager",
                  "type": "address"
                },
                {
                  "internalType": "address",
                  "name": "feeRecipient",
                  "type": "address"
                },
                {
                  "internalType": "uint256",
                  "name": "maxFee",
                  "type": "uint256"
                },
                {
                  "internalType": "uint256",
                  "name": "fee",
                  "type": "uint256"
                },
                {
                  "internalType": "uint256",
                  "name": "minLiquidity",
                  "type": "uint256"
                },
                {
                  "internalType": "string",
                  "name": "name",
                  "type": "string"
                },
                {
                  "internalType": "string",
                  "name": "uri",
                  "type": "string"
                }
              ],
              "internalType": "struct RateManagerV1.RateManagerConfig",
              "name": "_config",
              "type": "tuple"
            }
          ],
          "name": "createRateManager",
          "outputs": [
            {
              "internalType": "bytes32",
              "name": "rateManagerId",
              "type": "bytes32"
            }
          ],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "escrowRegistry",
          "outputs": [
            {
              "internalType": "contract IEscrowRegistry",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_rateManagerId",
              "type": "bytes32"
            }
          ],
          "name": "getFee",
          "outputs": [
            {
              "internalType": "address",
              "name": "recipient",
              "type": "address"
            },
            {
              "internalType": "uint256",
              "name": "fee",
              "type": "uint256"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_rateManagerId",
              "type": "bytes32"
            },
            {
              "internalType": "bytes32",
              "name": "_paymentMethod",
              "type": "bytes32"
            },
            {
              "internalType": "bytes32",
              "name": "_currencyCode",
              "type": "bytes32"
            }
          ],
          "name": "getManagerRate",
          "outputs": [
            {
              "internalType": "uint256",
              "name": "rate",
              "type": "uint256"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_rateManagerId",
              "type": "bytes32"
            },
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            },
            {
              "internalType": "uint256",
              "name": "",
              "type": "uint256"
            },
            {
              "internalType": "bytes32",
              "name": "_paymentMethod",
              "type": "bytes32"
            },
            {
              "internalType": "bytes32",
              "name": "_currencyCode",
              "type": "bytes32"
            }
          ],
          "name": "getRate",
          "outputs": [
            {
              "internalType": "uint256",
              "name": "rate",
              "type": "uint256"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_rateManagerId",
              "type": "bytes32"
            }
          ],
          "name": "getRateManager",
          "outputs": [
            {
              "components": [
                {
                  "internalType": "address",
                  "name": "manager",
                  "type": "address"
                },
                {
                  "internalType": "address",
                  "name": "feeRecipient",
                  "type": "address"
                },
                {
                  "internalType": "uint256",
                  "name": "maxFee",
                  "type": "uint256"
                },
                {
                  "internalType": "uint256",
                  "name": "fee",
                  "type": "uint256"
                },
                {
                  "internalType": "uint256",
                  "name": "minLiquidity",
                  "type": "uint256"
                },
                {
                  "internalType": "string",
                  "name": "name",
                  "type": "string"
                },
                {
                  "internalType": "string",
                  "name": "uri",
                  "type": "string"
                }
              ],
              "internalType": "struct RateManagerV1.RateManagerConfig",
              "name": "config",
              "type": "tuple"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_rateManagerId",
              "type": "bytes32"
            }
          ],
          "name": "isRateManager",
          "outputs": [
            {
              "internalType": "bool",
              "name": "exists",
              "type": "bool"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "bytes32",
              "name": "_rateManagerId",
              "type": "bytes32"
            }
          ],
          "name": "onDepositOptIn",
          "outputs": [],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "owner",
          "outputs": [
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "renounceOwnership",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_escrowRegistry",
              "type": "address"
            }
          ],
          "name": "setEscrowRegistry",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_rateManagerId",
              "type": "bytes32"
            },
            {
              "internalType": "uint256",
              "name": "_fee",
              "type": "uint256"
            }
          ],
          "name": "setFee",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_rateManagerId",
              "type": "bytes32"
            },
            {
              "internalType": "uint256",
              "name": "_minLiquidity",
              "type": "uint256"
            }
          ],
          "name": "setMinLiquidity",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_rateManagerId",
              "type": "bytes32"
            },
            {
              "internalType": "bytes32",
              "name": "_paymentMethod",
              "type": "bytes32"
            },
            {
              "internalType": "bytes32",
              "name": "_currencyCode",
              "type": "bytes32"
            },
            {
              "internalType": "uint256",
              "name": "_rate",
              "type": "uint256"
            }
          ],
          "name": "setRate",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_rateManagerId",
              "type": "bytes32"
            },
            {
              "internalType": "bytes32[]",
              "name": "_paymentMethods",
              "type": "bytes32[]"
            },
            {
              "internalType": "bytes32[][]",
              "name": "_currencyCodes",
              "type": "bytes32[][]"
            },
            {
              "internalType": "uint256[][]",
              "name": "_rates",
              "type": "uint256[][]"
            }
          ],
          "name": "setRateBatch",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_rateManagerId",
              "type": "bytes32"
            },
            {
              "internalType": "address",
              "name": "_manager",
              "type": "address"
            },
            {
              "internalType": "address",
              "name": "_feeRecipient",
              "type": "address"
            },
            {
              "internalType": "string",
              "name": "_name",
              "type": "string"
            },
            {
              "internalType": "string",
              "name": "_uri",
              "type": "string"
            }
          ],
          "name": "setRateManagerConfig",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "newOwner",
              "type": "address"
            }
          ],
          "name": "transferOwnership",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        }
      ]
    },
    "RelayerRegistry": {
      "address": "0xB214650b424E6b5fdcB1259566eB7A512D8Bd25E",
      "abi": [
        {
          "inputs": [],
          "stateMutability": "nonpayable",
          "type": "constructor"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "previousOwner",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "newOwner",
              "type": "address"
            }
          ],
          "name": "OwnershipTransferred",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "relayer",
              "type": "address"
            }
          ],
          "name": "RelayerAdded",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "relayer",
              "type": "address"
            }
          ],
          "name": "RelayerRemoved",
          "type": "event"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_relayer",
              "type": "address"
            }
          ],
          "name": "addRelayer",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "getWhitelistedRelayers",
          "outputs": [
            {
              "internalType": "address[]",
              "name": "",
              "type": "address[]"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            }
          ],
          "name": "isWhitelistedRelayer",
          "outputs": [
            {
              "internalType": "bool",
              "name": "",
              "type": "bool"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "owner",
          "outputs": [
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "",
              "type": "uint256"
            }
          ],
          "name": "relayers",
          "outputs": [
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_relayer",
              "type": "address"
            }
          ],
          "name": "removeRelayer",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "renounceOwnership",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "newOwner",
              "type": "address"
            }
          ],
          "name": "transferOwnership",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        }
      ]
    },
    "SignatureGatingPreIntentHook": {
      "address": "0x6c5144D1710fb152cFa582b9592D8935c0Bd0261",
      "abi": [
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_orchestratorRegistry",
              "type": "address"
            },
            {
              "internalType": "uint256",
              "name": "_chainId",
              "type": "uint256"
            }
          ],
          "stateMutability": "nonpayable",
          "type": "constructor"
        },
        {
          "inputs": [],
          "name": "InvalidSignature",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "expiration",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "currentTime",
              "type": "uint256"
            }
          ],
          "name": "SignatureExpired",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "escrow",
              "type": "address"
            },
            {
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            }
          ],
          "name": "SignerNotSet",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "caller",
              "type": "address"
            },
            {
              "internalType": "address",
              "name": "owner",
              "type": "address"
            },
            {
              "internalType": "address",
              "name": "delegate",
              "type": "address"
            }
          ],
          "name": "UnauthorizedCallerOrDelegate",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "caller",
              "type": "address"
            }
          ],
          "name": "UnauthorizedOrchestratorCaller",
          "type": "error"
        },
        {
          "inputs": [],
          "name": "ZeroAddress",
          "type": "error"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "escrow",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "signer",
              "type": "address"
            },
            {
              "indexed": false,
              "internalType": "address",
              "name": "setter",
              "type": "address"
            }
          ],
          "name": "DepositSignerSet",
          "type": "event"
        },
        {
          "inputs": [],
          "name": "chainId",
          "outputs": [
            {
              "internalType": "uint256",
              "name": "",
              "type": "uint256"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            },
            {
              "internalType": "uint256",
              "name": "",
              "type": "uint256"
            }
          ],
          "name": "depositSigner",
          "outputs": [
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_escrow",
              "type": "address"
            },
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            }
          ],
          "name": "getDepositSigner",
          "outputs": [
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "orchestratorRegistry",
          "outputs": [
            {
              "internalType": "contract IOrchestratorRegistry",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_escrow",
              "type": "address"
            },
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "address",
              "name": "_signer",
              "type": "address"
            }
          ],
          "name": "setDepositSigner",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "components": [
                {
                  "internalType": "address",
                  "name": "taker",
                  "type": "address"
                },
                {
                  "internalType": "address",
                  "name": "escrow",
                  "type": "address"
                },
                {
                  "internalType": "uint256",
                  "name": "depositId",
                  "type": "uint256"
                },
                {
                  "internalType": "uint256",
                  "name": "amount",
                  "type": "uint256"
                },
                {
                  "internalType": "address",
                  "name": "to",
                  "type": "address"
                },
                {
                  "internalType": "bytes32",
                  "name": "paymentMethod",
                  "type": "bytes32"
                },
                {
                  "internalType": "bytes32",
                  "name": "fiatCurrency",
                  "type": "bytes32"
                },
                {
                  "internalType": "uint256",
                  "name": "conversionRate",
                  "type": "uint256"
                },
                {
                  "components": [
                    {
                      "internalType": "address",
                      "name": "recipient",
                      "type": "address"
                    },
                    {
                      "internalType": "uint256",
                      "name": "fee",
                      "type": "uint256"
                    }
                  ],
                  "internalType": "struct IReferralFee.ReferralFee[]",
                  "name": "referralFees",
                  "type": "tuple[]"
                },
                {
                  "internalType": "bytes",
                  "name": "preIntentHookData",
                  "type": "bytes"
                }
              ],
              "internalType": "struct IPreIntentHook.PreIntentContext",
              "name": "_ctx",
              "type": "tuple"
            }
          ],
          "name": "validateSignalIntent",
          "outputs": [],
          "stateMutability": "view",
          "type": "function"
        }
      ]
    },
    "SimpleAttestationVerifier": {
      "address": "0x1540c12858Ad8D45EE9DAF8DFf2f28B28F047772",
      "abi": [
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_witness",
              "type": "address"
            }
          ],
          "stateMutability": "nonpayable",
          "type": "constructor"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "previousOwner",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "newOwner",
              "type": "address"
            }
          ],
          "name": "OwnershipTransferred",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "oldWitness",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "newWitness",
              "type": "address"
            }
          ],
          "name": "WitnessUpdated",
          "type": "event"
        },
        {
          "inputs": [],
          "name": "MIN_WITNESS_SIGNATURES",
          "outputs": [
            {
              "internalType": "uint256",
              "name": "",
              "type": "uint256"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "owner",
          "outputs": [
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "renounceOwnership",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_newWitness",
              "type": "address"
            }
          ],
          "name": "setWitness",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "newOwner",
              "type": "address"
            }
          ],
          "name": "transferOwnership",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_digest",
              "type": "bytes32"
            },
            {
              "internalType": "bytes[]",
              "name": "_sigs",
              "type": "bytes[]"
            },
            {
              "internalType": "bytes",
              "name": "",
              "type": "bytes"
            }
          ],
          "name": "verify",
          "outputs": [
            {
              "internalType": "bool",
              "name": "isValid",
              "type": "bool"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "witness",
          "outputs": [
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        }
      ]
    },
    "StakeVault": {
      "address": "0xE86126a9ce0E85C2d32e4DF028c390588763F43B",
      "abi": [
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_owner",
              "type": "address"
            },
            {
              "internalType": "contract IERC20",
              "name": "_stakeToken",
              "type": "address"
            },
            {
              "internalType": "address",
              "name": "_controller",
              "type": "address"
            },
            {
              "internalType": "uint64",
              "name": "_controllerChangeDelay",
              "type": "uint64"
            }
          ],
          "stateMutability": "nonpayable",
          "type": "constructor"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "lockAmount",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "claimsAmount",
              "type": "uint256"
            }
          ],
          "name": "ClaimsExceedLock",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "controller",
              "type": "address"
            }
          ],
          "name": "ControllerAlreadyInitialized",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "totalStaked",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "totalClaimable",
              "type": "uint256"
            }
          ],
          "name": "ControllerInitializationWithLiabilities",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint64",
              "name": "validAt",
              "type": "uint64"
            },
            {
              "internalType": "uint64",
              "name": "currentTime",
              "type": "uint64"
            }
          ],
          "name": "ControllerProposalNotReady",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "stakeOwner",
              "type": "address"
            },
            {
              "internalType": "uint256",
              "name": "available",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "required",
              "type": "uint256"
            }
          ],
          "name": "InsufficientFreeStake",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "available",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "required",
              "type": "uint256"
            }
          ],
          "name": "InsufficientUnaccountedTokens",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "beneficiary",
              "type": "address"
            },
            {
              "internalType": "uint256",
              "name": "amount",
              "type": "uint256"
            }
          ],
          "name": "InvalidClaim",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint64",
              "name": "suppliedDelay",
              "type": "uint64"
            }
          ],
          "name": "InvalidControllerChangeDelay",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "newAmount",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "currentAmount",
              "type": "uint256"
            }
          ],
          "name": "InvalidLockAmount",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint64",
              "name": "maturity",
              "type": "uint64"
            },
            {
              "internalType": "uint64",
              "name": "currentTime",
              "type": "uint64"
            }
          ],
          "name": "InvalidMaturity",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "expected",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "received",
              "type": "uint256"
            }
          ],
          "name": "InvalidReceivedAmount",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "taker",
              "type": "address"
            }
          ],
          "name": "InvalidTaker",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "lockId",
              "type": "bytes32"
            }
          ],
          "name": "LockAlreadyExists",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "lockId",
              "type": "bytes32"
            },
            {
              "internalType": "uint64",
              "name": "maturesAt",
              "type": "uint64"
            },
            {
              "internalType": "uint64",
              "name": "currentTime",
              "type": "uint64"
            }
          ],
          "name": "LockAlreadyMatured",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "lockId",
              "type": "bytes32"
            }
          ],
          "name": "LockNotFound",
          "type": "error"
        },
        {
          "inputs": [],
          "name": "NoPendingController",
          "type": "error"
        },
        {
          "inputs": [],
          "name": "OwnershipRenunciationDisabled",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "timestamp",
              "type": "uint256"
            }
          ],
          "name": "TimestampOverflow",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "caller",
              "type": "address"
            }
          ],
          "name": "UnauthorizedController",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "caller",
              "type": "address"
            },
            {
              "internalType": "address",
              "name": "pendingController",
              "type": "address"
            }
          ],
          "name": "UnauthorizedPendingController",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "taker",
              "type": "address"
            },
            {
              "internalType": "address",
              "name": "stakeOwner",
              "type": "address"
            }
          ],
          "name": "UnauthorizedStakeOwner",
          "type": "error"
        },
        {
          "inputs": [],
          "name": "ZeroAddress",
          "type": "error"
        },
        {
          "inputs": [],
          "name": "ZeroAmount",
          "type": "error"
        },
        {
          "inputs": [],
          "name": "ZeroLockId",
          "type": "error"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "lockId",
              "type": "bytes32"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "beneficiary",
              "type": "address"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "amount",
              "type": "uint256"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "newClaimableBalance",
              "type": "uint256"
            }
          ],
          "name": "ClaimCreated",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "beneficiary",
              "type": "address"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "amount",
              "type": "uint256"
            }
          ],
          "name": "ClaimWithdrawn",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "previousController",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "newController",
              "type": "address"
            }
          ],
          "name": "ControllerAccepted",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "controller",
              "type": "address"
            }
          ],
          "name": "ControllerInitialized",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "pendingController",
              "type": "address"
            }
          ],
          "name": "ControllerProposalCancelled",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "currentController",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "pendingController",
              "type": "address"
            },
            {
              "indexed": false,
              "internalType": "uint64",
              "name": "validAt",
              "type": "uint64"
            }
          ],
          "name": "ControllerProposed",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "lockId",
              "type": "bytes32"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "stakeOwner",
              "type": "address"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "amount",
              "type": "uint256"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "newStakeBalance",
              "type": "uint256"
            }
          ],
          "name": "LockFunded",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "previousOwner",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "newOwner",
              "type": "address"
            }
          ],
          "name": "OwnershipTransferStarted",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "previousOwner",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "newOwner",
              "type": "address"
            }
          ],
          "name": "OwnershipTransferred",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "stakeOwner",
              "type": "address"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "amount",
              "type": "uint256"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "newStakeBalance",
              "type": "uint256"
            }
          ],
          "name": "StakeDeposited",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "lockId",
              "type": "bytes32"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "stakeOwner",
              "type": "address"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "previousAmount",
              "type": "uint256"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "newAmount",
              "type": "uint256"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "totalLockedStake",
              "type": "uint256"
            }
          ],
          "name": "StakeLockIncreased",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "lockId",
              "type": "bytes32"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "stakeOwner",
              "type": "address"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "previousAmount",
              "type": "uint256"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "newAmount",
              "type": "uint256"
            },
            {
              "indexed": false,
              "internalType": "uint64",
              "name": "previousMaturity",
              "type": "uint64"
            },
            {
              "indexed": false,
              "internalType": "uint64",
              "name": "newMaturity",
              "type": "uint64"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "totalLockedStake",
              "type": "uint256"
            }
          ],
          "name": "StakeLockResized",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "lockId",
              "type": "bytes32"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "stakeOwner",
              "type": "address"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "lockAmount",
              "type": "uint256"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "unlockedAmount",
              "type": "uint256"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "claimedAmount",
              "type": "uint256"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "totalLockedStake",
              "type": "uint256"
            }
          ],
          "name": "StakeLockResolved",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "lockId",
              "type": "bytes32"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "stakeOwner",
              "type": "address"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "amount",
              "type": "uint256"
            },
            {
              "indexed": false,
              "internalType": "uint64",
              "name": "maturesAt",
              "type": "uint64"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "totalLockedStake",
              "type": "uint256"
            }
          ],
          "name": "StakeLocked",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "taker",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "previousStakeOwner",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "newStakeOwner",
              "type": "address"
            }
          ],
          "name": "StakeOwnerSelected",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "lockId",
              "type": "bytes32"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "stakeOwner",
              "type": "address"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "amount",
              "type": "uint256"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "totalLockedStake",
              "type": "uint256"
            }
          ],
          "name": "StakeUnlocked",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "stakeOwner",
              "type": "address"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "amount",
              "type": "uint256"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "newStakeBalance",
              "type": "uint256"
            }
          ],
          "name": "StakeWithdrawn",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "stakeOwner",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "taker",
              "type": "address"
            },
            {
              "indexed": false,
              "internalType": "bool",
              "name": "authorized",
              "type": "bool"
            }
          ],
          "name": "TakerAuthorizationUpdated",
          "type": "event"
        },
        {
          "inputs": [],
          "name": "MIN_CONTROLLER_CHANGE_DELAY",
          "outputs": [
            {
              "internalType": "uint64",
              "name": "",
              "type": "uint64"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "NEVER_MATURES",
          "outputs": [
            {
              "internalType": "uint64",
              "name": "",
              "type": "uint64"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "acceptController",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "acceptOwnership",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            },
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            }
          ],
          "name": "authorizedTakers",
          "outputs": [
            {
              "internalType": "bool",
              "name": "",
              "type": "bool"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "cancelControllerProposal",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "claim",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            }
          ],
          "name": "claimable",
          "outputs": [
            {
              "internalType": "uint256",
              "name": "",
              "type": "uint256"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "clearStakeOwner",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "controller",
          "outputs": [
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "controllerChangeDelay",
          "outputs": [
            {
              "internalType": "uint64",
              "name": "",
              "type": "uint64"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_amount",
              "type": "uint256"
            }
          ],
          "name": "depositStake",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_stakeOwner",
              "type": "address"
            }
          ],
          "name": "freeStake",
          "outputs": [
            {
              "internalType": "uint256",
              "name": "",
              "type": "uint256"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_stakeOwner",
              "type": "address"
            },
            {
              "internalType": "bytes32",
              "name": "_lockId",
              "type": "bytes32"
            },
            {
              "internalType": "uint256",
              "name": "_amount",
              "type": "uint256"
            },
            {
              "internalType": "uint64",
              "name": "_maturesAt",
              "type": "uint64"
            }
          ],
          "name": "fundLock",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_taker",
              "type": "address"
            }
          ],
          "name": "getTakerState",
          "outputs": [
            {
              "internalType": "address",
              "name": "stakeOwner",
              "type": "address"
            },
            {
              "internalType": "uint256",
              "name": "totalStake",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "lockedStakeAmount",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "freeStakeAmount",
              "type": "uint256"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_lockId",
              "type": "bytes32"
            },
            {
              "internalType": "uint256",
              "name": "_additionalAmount",
              "type": "uint256"
            }
          ],
          "name": "increaseLock",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_controller",
              "type": "address"
            }
          ],
          "name": "initializeController",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_lockId",
              "type": "bytes32"
            }
          ],
          "name": "isLockMature",
          "outputs": [
            {
              "internalType": "bool",
              "name": "",
              "type": "bool"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_stakeOwner",
              "type": "address"
            },
            {
              "internalType": "bytes32",
              "name": "_lockId",
              "type": "bytes32"
            },
            {
              "internalType": "uint256",
              "name": "_amount",
              "type": "uint256"
            },
            {
              "internalType": "uint64",
              "name": "_maturesAt",
              "type": "uint64"
            }
          ],
          "name": "lockStake",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            }
          ],
          "name": "lockedStake",
          "outputs": [
            {
              "internalType": "uint256",
              "name": "",
              "type": "uint256"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "",
              "type": "bytes32"
            }
          ],
          "name": "locks",
          "outputs": [
            {
              "internalType": "address",
              "name": "stakeOwner",
              "type": "address"
            },
            {
              "internalType": "uint256",
              "name": "amount",
              "type": "uint256"
            },
            {
              "internalType": "uint64",
              "name": "maturesAt",
              "type": "uint64"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "owner",
          "outputs": [
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "pendingController",
          "outputs": [
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "pendingControllerValidAt",
          "outputs": [
            {
              "internalType": "uint64",
              "name": "",
              "type": "uint64"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "pendingOwner",
          "outputs": [
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_controller",
              "type": "address"
            }
          ],
          "name": "proposeController",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "renounceOwnership",
          "outputs": [],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_lockId",
              "type": "bytes32"
            },
            {
              "internalType": "uint256",
              "name": "_newAmount",
              "type": "uint256"
            },
            {
              "internalType": "uint64",
              "name": "_newMaturesAt",
              "type": "uint64"
            }
          ],
          "name": "resizeLock",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_lockId",
              "type": "bytes32"
            },
            {
              "components": [
                {
                  "internalType": "address",
                  "name": "beneficiary",
                  "type": "address"
                },
                {
                  "internalType": "uint256",
                  "name": "amount",
                  "type": "uint256"
                }
              ],
              "internalType": "struct IStakeVault.Claim[]",
              "name": "_claims",
              "type": "tuple[]"
            }
          ],
          "name": "resolveLock",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_stakeOwner",
              "type": "address"
            }
          ],
          "name": "selectStakeOwner",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            }
          ],
          "name": "selectedStakeOwner",
          "outputs": [
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_taker",
              "type": "address"
            },
            {
              "internalType": "bool",
              "name": "_authorized",
              "type": "bool"
            }
          ],
          "name": "setTakerAuthorization",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            }
          ],
          "name": "stakeBalance",
          "outputs": [
            {
              "internalType": "uint256",
              "name": "",
              "type": "uint256"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_taker",
              "type": "address"
            }
          ],
          "name": "stakeOwnerOf",
          "outputs": [
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "stakeToken",
          "outputs": [
            {
              "internalType": "contract IERC20",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "totalAccounted",
          "outputs": [
            {
              "internalType": "uint256",
              "name": "",
              "type": "uint256"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "totalClaimable",
          "outputs": [
            {
              "internalType": "uint256",
              "name": "",
              "type": "uint256"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "totalStaked",
          "outputs": [
            {
              "internalType": "uint256",
              "name": "",
              "type": "uint256"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "newOwner",
              "type": "address"
            }
          ],
          "name": "transferOwnership",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "unaccountedBalance",
          "outputs": [
            {
              "internalType": "uint256",
              "name": "",
              "type": "uint256"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_lockId",
              "type": "bytes32"
            }
          ],
          "name": "unlockStake",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "_amount",
              "type": "uint256"
            }
          ],
          "name": "withdrawStake",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        }
      ]
    },
    "UnifiedPaymentVerifier": {
      "address": "0xfFf74adAE1fb470d49cA37772C9859C4a6dBcc03",
      "abi": [
        {
          "inputs": [
            {
              "internalType": "contract IOrchestrator",
              "name": "_orchestrator",
              "type": "address"
            },
            {
              "internalType": "contract INullifierRegistry",
              "name": "_nullifierRegistry",
              "type": "address"
            },
            {
              "internalType": "contract IAttestationVerifier",
              "name": "_attestationVerifier",
              "type": "address"
            }
          ],
          "stateMutability": "nonpayable",
          "type": "constructor"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "oldVerifier",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "newVerifier",
              "type": "address"
            }
          ],
          "name": "AttestationVerifierUpdated",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "previousOwner",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "newOwner",
              "type": "address"
            }
          ],
          "name": "OwnershipTransferred",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "paymentMethod",
              "type": "bytes32"
            }
          ],
          "name": "PaymentMethodAdded",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "paymentMethod",
              "type": "bytes32"
            }
          ],
          "name": "PaymentMethodRemoved",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "intentHash",
              "type": "bytes32"
            },
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "method",
              "type": "bytes32"
            },
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "currency",
              "type": "bytes32"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "amount",
              "type": "uint256"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "timestamp",
              "type": "uint256"
            },
            {
              "indexed": false,
              "internalType": "bytes32",
              "name": "paymentId",
              "type": "bytes32"
            },
            {
              "indexed": false,
              "internalType": "bytes32",
              "name": "payeeId",
              "type": "bytes32"
            }
          ],
          "name": "PaymentVerified",
          "type": "event"
        },
        {
          "inputs": [],
          "name": "DOMAIN_SEPARATOR",
          "outputs": [
            {
              "internalType": "bytes32",
              "name": "",
              "type": "bytes32"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_paymentMethod",
              "type": "bytes32"
            }
          ],
          "name": "addPaymentMethod",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "attestationVerifier",
          "outputs": [
            {
              "internalType": "contract IAttestationVerifier",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "getPaymentMethods",
          "outputs": [
            {
              "internalType": "bytes32[]",
              "name": "",
              "type": "bytes32[]"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "",
              "type": "bytes32"
            }
          ],
          "name": "isPaymentMethod",
          "outputs": [
            {
              "internalType": "bool",
              "name": "",
              "type": "bool"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "nullifierRegistry",
          "outputs": [
            {
              "internalType": "contract INullifierRegistry",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "orchestrator",
          "outputs": [
            {
              "internalType": "contract IOrchestrator",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "owner",
          "outputs": [
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "",
              "type": "uint256"
            }
          ],
          "name": "paymentMethods",
          "outputs": [
            {
              "internalType": "bytes32",
              "name": "",
              "type": "bytes32"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_paymentMethod",
              "type": "bytes32"
            }
          ],
          "name": "removePaymentMethod",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "renounceOwnership",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_newVerifier",
              "type": "address"
            }
          ],
          "name": "setAttestationVerifier",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "newOwner",
              "type": "address"
            }
          ],
          "name": "transferOwnership",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "components": [
                {
                  "internalType": "bytes32",
                  "name": "intentHash",
                  "type": "bytes32"
                },
                {
                  "internalType": "bytes",
                  "name": "paymentProof",
                  "type": "bytes"
                },
                {
                  "internalType": "bytes",
                  "name": "data",
                  "type": "bytes"
                }
              ],
              "internalType": "struct IPaymentVerifier.VerifyPaymentData",
              "name": "_verifyPaymentData",
              "type": "tuple"
            }
          ],
          "name": "verifyPayment",
          "outputs": [
            {
              "components": [
                {
                  "internalType": "bool",
                  "name": "success",
                  "type": "bool"
                },
                {
                  "internalType": "bytes32",
                  "name": "intentHash",
                  "type": "bytes32"
                },
                {
                  "internalType": "uint256",
                  "name": "releaseAmount",
                  "type": "uint256"
                }
              ],
              "internalType": "struct IPaymentVerifier.PaymentVerificationResult",
              "name": "result",
              "type": "tuple"
            }
          ],
          "stateMutability": "nonpayable",
          "type": "function"
        }
      ]
    },
    "UnifiedPaymentVerifierV2": {
      "address": "0x7750f8Cc276f21B7Db1477FA044Bf3FD4951Bf20",
      "abi": [
        {
          "inputs": [
            {
              "internalType": "contract IOrchestratorRegistry",
              "name": "_orchestratorRegistry",
              "type": "address"
            },
            {
              "internalType": "contract INullifierRegistry",
              "name": "_nullifierRegistry",
              "type": "address"
            },
            {
              "internalType": "contract IAttestationVerifier",
              "name": "_attestationVerifier",
              "type": "address"
            }
          ],
          "stateMutability": "nonpayable",
          "type": "constructor"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "oldVerifier",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "newVerifier",
              "type": "address"
            }
          ],
          "name": "AttestationVerifierUpdated",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "previousOwner",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "newOwner",
              "type": "address"
            }
          ],
          "name": "OwnershipTransferred",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "paymentMethod",
              "type": "bytes32"
            }
          ],
          "name": "PaymentMethodAdded",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "paymentMethod",
              "type": "bytes32"
            }
          ],
          "name": "PaymentMethodRemoved",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "intentHash",
              "type": "bytes32"
            },
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "method",
              "type": "bytes32"
            },
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "currency",
              "type": "bytes32"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "amount",
              "type": "uint256"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "timestamp",
              "type": "uint256"
            },
            {
              "indexed": false,
              "internalType": "bytes32",
              "name": "paymentId",
              "type": "bytes32"
            },
            {
              "indexed": false,
              "internalType": "bytes32",
              "name": "payeeId",
              "type": "bytes32"
            }
          ],
          "name": "PaymentVerified",
          "type": "event"
        },
        {
          "inputs": [],
          "name": "DOMAIN_SEPARATOR",
          "outputs": [
            {
              "internalType": "bytes32",
              "name": "",
              "type": "bytes32"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_paymentMethod",
              "type": "bytes32"
            }
          ],
          "name": "addPaymentMethod",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "attestationVerifier",
          "outputs": [
            {
              "internalType": "contract IAttestationVerifier",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "getPaymentMethods",
          "outputs": [
            {
              "internalType": "bytes32[]",
              "name": "",
              "type": "bytes32[]"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "",
              "type": "bytes32"
            }
          ],
          "name": "isPaymentMethod",
          "outputs": [
            {
              "internalType": "bool",
              "name": "",
              "type": "bool"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "nullifierRegistry",
          "outputs": [
            {
              "internalType": "contract INullifierRegistry",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "orchestratorRegistry",
          "outputs": [
            {
              "internalType": "contract IOrchestratorRegistry",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "owner",
          "outputs": [
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "",
              "type": "uint256"
            }
          ],
          "name": "paymentMethods",
          "outputs": [
            {
              "internalType": "bytes32",
              "name": "",
              "type": "bytes32"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_paymentMethod",
              "type": "bytes32"
            }
          ],
          "name": "removePaymentMethod",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "renounceOwnership",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_newVerifier",
              "type": "address"
            }
          ],
          "name": "setAttestationVerifier",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "newOwner",
              "type": "address"
            }
          ],
          "name": "transferOwnership",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "components": [
                {
                  "internalType": "bytes32",
                  "name": "intentHash",
                  "type": "bytes32"
                },
                {
                  "internalType": "bytes",
                  "name": "paymentProof",
                  "type": "bytes"
                },
                {
                  "internalType": "bytes",
                  "name": "data",
                  "type": "bytes"
                }
              ],
              "internalType": "struct IPaymentVerifier.VerifyPaymentData",
              "name": "_verifyPaymentData",
              "type": "tuple"
            }
          ],
          "name": "verifyPayment",
          "outputs": [
            {
              "components": [
                {
                  "internalType": "bool",
                  "name": "success",
                  "type": "bool"
                },
                {
                  "internalType": "bytes32",
                  "name": "intentHash",
                  "type": "bytes32"
                },
                {
                  "internalType": "uint256",
                  "name": "releaseAmount",
                  "type": "uint256"
                }
              ],
              "internalType": "struct IPaymentVerifier.PaymentVerificationResult",
              "name": "result",
              "type": "tuple"
            }
          ],
          "stateMutability": "nonpayable",
          "type": "function"
        }
      ]
    },
    "UnifiedPaymentVerifierV3": {
      "address": "0x4c62E99649c8Ba745E67018f5c8a483D77c429C4",
      "abi": [
        {
          "inputs": [
            {
              "internalType": "contract IOrchestratorRegistry",
              "name": "_orchestratorRegistry",
              "type": "address"
            },
            {
              "internalType": "contract INullifierRegistryV2",
              "name": "_nullifierRegistry",
              "type": "address"
            },
            {
              "internalType": "contract IAttestationVerifier",
              "name": "_attestationVerifier",
              "type": "address"
            }
          ],
          "stateMutability": "nonpayable",
          "type": "constructor"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "oldVerifier",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "newVerifier",
              "type": "address"
            }
          ],
          "name": "AttestationVerifierUpdated",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "previousOwner",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "newOwner",
              "type": "address"
            }
          ],
          "name": "OwnershipTransferred",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "paymentMethod",
              "type": "bytes32"
            }
          ],
          "name": "PaymentMethodAdded",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "paymentMethod",
              "type": "bytes32"
            }
          ],
          "name": "PaymentMethodRemoved",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "intentHash",
              "type": "bytes32"
            },
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "method",
              "type": "bytes32"
            },
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "currency",
              "type": "bytes32"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "amount",
              "type": "uint256"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "timestamp",
              "type": "uint256"
            },
            {
              "indexed": false,
              "internalType": "bytes32",
              "name": "paymentId",
              "type": "bytes32"
            },
            {
              "indexed": false,
              "internalType": "bytes32",
              "name": "payeeId",
              "type": "bytes32"
            }
          ],
          "name": "PaymentVerified",
          "type": "event"
        },
        {
          "inputs": [],
          "name": "DOMAIN_SEPARATOR",
          "outputs": [
            {
              "internalType": "bytes32",
              "name": "",
              "type": "bytes32"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_paymentMethod",
              "type": "bytes32"
            }
          ],
          "name": "addPaymentMethod",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "attestationVerifier",
          "outputs": [
            {
              "internalType": "contract IAttestationVerifier",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "getPaymentMethods",
          "outputs": [
            {
              "internalType": "bytes32[]",
              "name": "",
              "type": "bytes32[]"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "",
              "type": "bytes32"
            }
          ],
          "name": "isPaymentMethod",
          "outputs": [
            {
              "internalType": "bool",
              "name": "",
              "type": "bool"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "nullifierRegistry",
          "outputs": [
            {
              "internalType": "contract INullifierRegistryV2",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "orchestratorRegistry",
          "outputs": [
            {
              "internalType": "contract IOrchestratorRegistry",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "owner",
          "outputs": [
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "",
              "type": "uint256"
            }
          ],
          "name": "paymentMethods",
          "outputs": [
            {
              "internalType": "bytes32",
              "name": "",
              "type": "bytes32"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "_paymentMethod",
              "type": "bytes32"
            }
          ],
          "name": "removePaymentMethod",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "renounceOwnership",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_newVerifier",
              "type": "address"
            }
          ],
          "name": "setAttestationVerifier",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "newOwner",
              "type": "address"
            }
          ],
          "name": "transferOwnership",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "components": [
                {
                  "internalType": "bytes32",
                  "name": "intentHash",
                  "type": "bytes32"
                },
                {
                  "internalType": "bytes",
                  "name": "paymentProof",
                  "type": "bytes"
                },
                {
                  "internalType": "bytes",
                  "name": "data",
                  "type": "bytes"
                }
              ],
              "internalType": "struct IPaymentVerifier.VerifyPaymentData",
              "name": "_verifyPaymentData",
              "type": "tuple"
            }
          ],
          "name": "verifyPayment",
          "outputs": [
            {
              "components": [
                {
                  "internalType": "bool",
                  "name": "success",
                  "type": "bool"
                },
                {
                  "internalType": "bytes32",
                  "name": "intentHash",
                  "type": "bytes32"
                },
                {
                  "internalType": "uint256",
                  "name": "releaseAmount",
                  "type": "uint256"
                }
              ],
              "internalType": "struct IPaymentVerifier.PaymentVerificationResult",
              "name": "result",
              "type": "tuple"
            }
          ],
          "stateMutability": "nonpayable",
          "type": "function"
        }
      ]
    },
    "WhitelistPolicy": {
      "address": "0xe3d3E798AbF1c021730d951d0589bCa63d9CB3F0",
      "abi": [
        {
          "inputs": [
            {
              "internalType": "contract IAddressGroupRegistry",
              "name": "_groupRegistry",
              "type": "address"
            },
            {
              "internalType": "contract IEscrowRegistry",
              "name": "_escrowRegistry",
              "type": "address"
            },
            {
              "internalType": "contract IOrchestratorRegistry",
              "name": "_orchestratorRegistry",
              "type": "address"
            }
          ],
          "stateMutability": "nonpayable",
          "type": "constructor"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "escrow",
              "type": "address"
            },
            {
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            }
          ],
          "name": "DepositNotFound",
          "type": "error"
        },
        {
          "inputs": [],
          "name": "EmptyArray",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "escrow",
              "type": "address"
            }
          ],
          "name": "EscrowNotWhitelisted",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "bytes32",
              "name": "groupId",
              "type": "bytes32"
            }
          ],
          "name": "GroupDoesNotExist",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "dependency",
              "type": "address"
            }
          ],
          "name": "InvalidDependency",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "escrow",
              "type": "address"
            },
            {
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "internalType": "address",
              "name": "caller",
              "type": "address"
            }
          ],
          "name": "NotDepositor",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "taker",
              "type": "address"
            },
            {
              "internalType": "address",
              "name": "escrow",
              "type": "address"
            },
            {
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            }
          ],
          "name": "TakerNotWhitelisted",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "attempted",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "maximum",
              "type": "uint256"
            }
          ],
          "name": "TooManyGroups",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "caller",
              "type": "address"
            }
          ],
          "name": "UnauthorizedOrchestratorCaller",
          "type": "error"
        },
        {
          "inputs": [],
          "name": "ZeroAddress",
          "type": "error"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "escrow",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "taker",
              "type": "address"
            }
          ],
          "name": "AddressRemovedFromWhitelist",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "escrow",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "taker",
              "type": "address"
            }
          ],
          "name": "AddressWhitelisted",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "escrow",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "groupId",
              "type": "bytes32"
            }
          ],
          "name": "AllowedGroupAdded",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "escrow",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "indexed": true,
              "internalType": "bytes32",
              "name": "groupId",
              "type": "bytes32"
            }
          ],
          "name": "AllowedGroupRemoved",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "escrow",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "indexed": false,
              "internalType": "bool",
              "name": "enabled",
              "type": "bool"
            }
          ],
          "name": "EnabledUpdated",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "escrowRegistry",
              "type": "address"
            }
          ],
          "name": "EscrowRegistryUpdated",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "previousOwner",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "newOwner",
              "type": "address"
            }
          ],
          "name": "OwnershipTransferred",
          "type": "event"
        },
        {
          "inputs": [],
          "name": "MAX_GROUPS_PER_DEPOSIT",
          "outputs": [
            {
              "internalType": "uint256",
              "name": "",
              "type": "uint256"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_escrow",
              "type": "address"
            },
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "bytes32[]",
              "name": "_groupIds",
              "type": "bytes32[]"
            }
          ],
          "name": "addAllowedGroups",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_escrow",
              "type": "address"
            },
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "address[]",
              "name": "_takers",
              "type": "address[]"
            }
          ],
          "name": "addWhitelistedAddresses",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_escrow",
              "type": "address"
            },
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "bool",
              "name": "_enabled",
              "type": "bool"
            },
            {
              "internalType": "bytes32[]",
              "name": "_groupIds",
              "type": "bytes32[]"
            },
            {
              "internalType": "address[]",
              "name": "_takers",
              "type": "address[]"
            }
          ],
          "name": "configureDeposit",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            },
            {
              "internalType": "uint256",
              "name": "",
              "type": "uint256"
            }
          ],
          "name": "enabled",
          "outputs": [
            {
              "internalType": "bool",
              "name": "",
              "type": "bool"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "escrowRegistry",
          "outputs": [
            {
              "internalType": "contract IEscrowRegistry",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_escrow",
              "type": "address"
            },
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            }
          ],
          "name": "getAllowedGroups",
          "outputs": [
            {
              "internalType": "bytes32[]",
              "name": "",
              "type": "bytes32[]"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "groupRegistry",
          "outputs": [
            {
              "internalType": "contract IAddressGroupRegistry",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_escrow",
              "type": "address"
            },
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "bytes32",
              "name": "_groupId",
              "type": "bytes32"
            }
          ],
          "name": "isGroupAllowed",
          "outputs": [
            {
              "internalType": "bool",
              "name": "",
              "type": "bool"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_escrow",
              "type": "address"
            },
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "address",
              "name": "_taker",
              "type": "address"
            }
          ],
          "name": "isTakerAllowed",
          "outputs": [
            {
              "internalType": "bool",
              "name": "",
              "type": "bool"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            },
            {
              "internalType": "uint256",
              "name": "",
              "type": "uint256"
            },
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            }
          ],
          "name": "isWhitelisted",
          "outputs": [
            {
              "internalType": "bool",
              "name": "",
              "type": "bool"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "orchestratorRegistry",
          "outputs": [
            {
              "internalType": "contract IOrchestratorRegistry",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "owner",
          "outputs": [
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_escrow",
              "type": "address"
            },
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "bytes32[]",
              "name": "_groupIds",
              "type": "bytes32[]"
            }
          ],
          "name": "removeAllowedGroups",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_escrow",
              "type": "address"
            },
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "address[]",
              "name": "_takers",
              "type": "address[]"
            }
          ],
          "name": "removeWhitelistedAddresses",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "renounceOwnership",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_escrow",
              "type": "address"
            },
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "bool",
              "name": "_enabled",
              "type": "bool"
            }
          ],
          "name": "setEnabled",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "contract IEscrowRegistry",
              "name": "_escrowRegistry",
              "type": "address"
            }
          ],
          "name": "setEscrowRegistry",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "newOwner",
              "type": "address"
            }
          ],
          "name": "transferOwnership",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "components": [
                {
                  "internalType": "address",
                  "name": "taker",
                  "type": "address"
                },
                {
                  "internalType": "address",
                  "name": "escrow",
                  "type": "address"
                },
                {
                  "internalType": "uint256",
                  "name": "depositId",
                  "type": "uint256"
                },
                {
                  "internalType": "uint256",
                  "name": "amount",
                  "type": "uint256"
                },
                {
                  "internalType": "address",
                  "name": "to",
                  "type": "address"
                },
                {
                  "internalType": "bytes32",
                  "name": "paymentMethod",
                  "type": "bytes32"
                },
                {
                  "internalType": "bytes32",
                  "name": "fiatCurrency",
                  "type": "bytes32"
                },
                {
                  "internalType": "uint256",
                  "name": "conversionRate",
                  "type": "uint256"
                },
                {
                  "components": [
                    {
                      "internalType": "address",
                      "name": "recipient",
                      "type": "address"
                    },
                    {
                      "internalType": "uint256",
                      "name": "fee",
                      "type": "uint256"
                    }
                  ],
                  "internalType": "struct IReferralFee.ReferralFee[]",
                  "name": "referralFees",
                  "type": "tuple[]"
                },
                {
                  "internalType": "bytes",
                  "name": "preIntentHookData",
                  "type": "bytes"
                }
              ],
              "internalType": "struct IPreIntentHook.PreIntentContext",
              "name": "_ctx",
              "type": "tuple"
            }
          ],
          "name": "validateSignalIntent",
          "outputs": [],
          "stateMutability": "view",
          "type": "function"
        }
      ]
    },
    "WhitelistPreIntentHook": {
      "address": "0xABE7AFC4C7bE9c4Eed5F465a98e124ee7860C005",
      "abi": [
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_orchestratorRegistry",
              "type": "address"
            }
          ],
          "stateMutability": "nonpayable",
          "type": "constructor"
        },
        {
          "inputs": [],
          "name": "EmptyArray",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "taker",
              "type": "address"
            },
            {
              "internalType": "address",
              "name": "escrow",
              "type": "address"
            },
            {
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            }
          ],
          "name": "TakerNotInWhitelist",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "taker",
              "type": "address"
            },
            {
              "internalType": "address",
              "name": "escrow",
              "type": "address"
            },
            {
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            }
          ],
          "name": "TakerNotWhitelisted",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "caller",
              "type": "address"
            },
            {
              "internalType": "address",
              "name": "owner",
              "type": "address"
            },
            {
              "internalType": "address",
              "name": "delegate",
              "type": "address"
            }
          ],
          "name": "UnauthorizedCallerOrDelegate",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "caller",
              "type": "address"
            }
          ],
          "name": "UnauthorizedOrchestratorCaller",
          "type": "error"
        },
        {
          "inputs": [],
          "name": "ZeroAddress",
          "type": "error"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "escrow",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "taker",
              "type": "address"
            }
          ],
          "name": "TakerRemovedFromWhitelist",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "escrow",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "uint256",
              "name": "depositId",
              "type": "uint256"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "taker",
              "type": "address"
            }
          ],
          "name": "TakerWhitelisted",
          "type": "event"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_escrow",
              "type": "address"
            },
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "address[]",
              "name": "_takers",
              "type": "address[]"
            }
          ],
          "name": "addToWhitelist",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_escrow",
              "type": "address"
            },
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "address",
              "name": "_taker",
              "type": "address"
            }
          ],
          "name": "isWhitelisted",
          "outputs": [
            {
              "internalType": "bool",
              "name": "",
              "type": "bool"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "orchestratorRegistry",
          "outputs": [
            {
              "internalType": "contract IOrchestratorRegistry",
              "name": "",
              "type": "address"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_escrow",
              "type": "address"
            },
            {
              "internalType": "uint256",
              "name": "_depositId",
              "type": "uint256"
            },
            {
              "internalType": "address[]",
              "name": "_takers",
              "type": "address[]"
            }
          ],
          "name": "removeFromWhitelist",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "components": [
                {
                  "internalType": "address",
                  "name": "taker",
                  "type": "address"
                },
                {
                  "internalType": "address",
                  "name": "escrow",
                  "type": "address"
                },
                {
                  "internalType": "uint256",
                  "name": "depositId",
                  "type": "uint256"
                },
                {
                  "internalType": "uint256",
                  "name": "amount",
                  "type": "uint256"
                },
                {
                  "internalType": "address",
                  "name": "to",
                  "type": "address"
                },
                {
                  "internalType": "bytes32",
                  "name": "paymentMethod",
                  "type": "bytes32"
                },
                {
                  "internalType": "bytes32",
                  "name": "fiatCurrency",
                  "type": "bytes32"
                },
                {
                  "internalType": "uint256",
                  "name": "conversionRate",
                  "type": "uint256"
                },
                {
                  "components": [
                    {
                      "internalType": "address",
                      "name": "recipient",
                      "type": "address"
                    },
                    {
                      "internalType": "uint256",
                      "name": "fee",
                      "type": "uint256"
                    }
                  ],
                  "internalType": "struct IReferralFee.ReferralFee[]",
                  "name": "referralFees",
                  "type": "tuple[]"
                },
                {
                  "internalType": "bytes",
                  "name": "preIntentHookData",
                  "type": "bytes"
                }
              ],
              "internalType": "struct IPreIntentHook.PreIntentContext",
              "name": "_ctx",
              "type": "tuple"
            }
          ],
          "name": "validateSignalIntent",
          "outputs": [],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            },
            {
              "internalType": "uint256",
              "name": "",
              "type": "uint256"
            },
            {
              "internalType": "address",
              "name": "",
              "type": "address"
            }
          ],
          "name": "whitelist",
          "outputs": [
            {
              "internalType": "bool",
              "name": "",
              "type": "bool"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        }
      ]
    }
  }
} as const;
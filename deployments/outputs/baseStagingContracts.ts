export default {
  "name": "base_staging",
  "chainId": "8453",
  "contracts": {
    "AcrossBridgeHook": {
      "address": "0x68095A73455973c30D7ef44413441C1Ef47B8Dd9",
      "abi": [
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_inputToken",
              "type": "address"
            },
            {
              "internalType": "address",
              "name": "_orchestrator",
              "type": "address"
            },
            {
              "internalType": "address",
              "name": "_spokePool",
              "type": "address"
            }
          ],
          "stateMutability": "nonpayable",
          "type": "constructor"
        },
        {
          "inputs": [
            {
              "internalType": "uint32",
              "name": "fillDeadline",
              "type": "uint32"
            }
          ],
          "name": "FillDeadlineOutOfRange",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "destinationChainId",
              "type": "uint256"
            }
          ],
          "name": "InvalidDestinationChainId",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "outputToken",
              "type": "address"
            }
          ],
          "name": "InvalidOutputToken",
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
          "name": "InvalidRecipient",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "to",
              "type": "address"
            },
            {
              "internalType": "uint256",
              "name": "amount",
              "type": "uint256"
            }
          ],
          "name": "NativeTransferFailed",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "outputAmount",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "minimum",
              "type": "uint256"
            }
          ],
          "name": "OutputBelowMinimum",
          "type": "error"
        },
        {
          "inputs": [
            {
              "internalType": "uint32",
              "name": "quoteTimestamp",
              "type": "uint32"
            }
          ],
          "name": "QuoteTimestampOutOfRange",
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
          "name": "UnauthorizedCaller",
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
              "name": "intentHash",
              "type": "bytes32"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "destinationChainId",
              "type": "uint256"
            },
            {
              "indexed": false,
              "internalType": "address",
              "name": "outputToken",
              "type": "address"
            },
            {
              "indexed": false,
              "internalType": "address",
              "name": "recipient",
              "type": "address"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "inputAmount",
              "type": "uint256"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "outputAmount",
              "type": "uint256"
            },
            {
              "indexed": false,
              "internalType": "uint32",
              "name": "quoteTimestamp",
              "type": "uint32"
            },
            {
              "indexed": false,
              "internalType": "uint32",
              "name": "fillDeadline",
              "type": "uint32"
            }
          ],
          "name": "AcrossBridgeInitiated",
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
              "name": "token",
              "type": "address"
            },
            {
              "indexed": true,
              "internalType": "address",
              "name": "to",
              "type": "address"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "amount",
              "type": "uint256"
            }
          ],
          "name": "RescueERC20",
          "type": "event"
        },
        {
          "anonymous": false,
          "inputs": [
            {
              "indexed": true,
              "internalType": "address",
              "name": "to",
              "type": "address"
            },
            {
              "indexed": false,
              "internalType": "uint256",
              "name": "amount",
              "type": "uint256"
            }
          ],
          "name": "RescueNative",
          "type": "event"
        },
        {
          "inputs": [
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
              "name": "_intent",
              "type": "tuple"
            },
            {
              "internalType": "uint256",
              "name": "_amountNetFees",
              "type": "uint256"
            },
            {
              "internalType": "bytes",
              "name": "_fulfillIntentData",
              "type": "bytes"
            }
          ],
          "name": "execute",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "inputToken",
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
          "name": "orchestrator",
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
              "name": "_token",
              "type": "address"
            },
            {
              "internalType": "address",
              "name": "_to",
              "type": "address"
            },
            {
              "internalType": "uint256",
              "name": "_amount",
              "type": "uint256"
            }
          ],
          "name": "rescueERC20",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address payable",
              "name": "_to",
              "type": "address"
            },
            {
              "internalType": "uint256",
              "name": "_amount",
              "type": "uint256"
            }
          ],
          "name": "rescueNative",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "spokePool",
          "outputs": [
            {
              "internalType": "contract IAcrossSpokePool",
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
          "stateMutability": "payable",
          "type": "receive"
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
    }
  }
} as const;
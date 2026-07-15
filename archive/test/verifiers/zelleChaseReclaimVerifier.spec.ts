import "module-alias/register";
import { ethers } from "hardhat";
import { BigNumber, BytesLike } from "ethers";
import hre from "hardhat";

import { NullifierRegistry, ZelleChaseReclaimVerifier, USDCMock, ZelleBaseVerifier } from "@utils/contracts";
import { Account } from "@utils/test/types";
import { Address, ReclaimProof } from "@utils/types";
import DeployHelper from "@utils/deploys";
import { Currency } from "@utils/protocolUtils";
import { getIdentifierFromClaimInfo, createSignDataForClaim, encodeProof, parseExtensionProof, encodeTwoProofs } from "@utils/reclaimUtils";
import { Blockchain, usdc, ether } from "@utils/common";
import { ZERO_BYTES32 } from "@utils/constants";

import {
  getWaffleExpect,
  getAccounts
} from "@utils/test/index";

const expect = getWaffleExpect();

const chaseListDeliveredProof = {
  "claim": {
    "provider": "http",
    "parameters": "{\"body\":\"pageId=&sortBy=PROCESS_DATE&orderBy=DESC\",\"headers\":{\"Accept\":\"*/*\",\"Accept-Language\":\"en-US,en;q=0.9\",\"Content-Type\":\"application/x-www-form-urlencoded; charset=UTF-8\",\"Origin\":\"https://secure.chase.com\",\"Referer\":\"https://secure.chase.com/web/auth/dashboard\",\"Sec-Fetch-Dest\":\"empty\",\"Sec-Fetch-Mode\":\"cors\",\"Sec-Fetch-Site\":\"same-origin\",\"User-Agent\":\"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36\",\"sec-ch-ua\":\"\\\"Chromium\\\";v=\\\"136\\\", \\\"Google Chrome\\\";v=\\\"136\\\", \\\"Not.A/Brand\\\";v=\\\"99\\\"\",\"sec-ch-ua-arch\":\"\\\"arm\\\"\",\"sec-ch-ua-bitness\":\"\\\"64\\\"\",\"sec-ch-ua-full-version-list\":\"\\\"Chromium\\\";v=\\\"136.0.7103.48\\\", \\\"Google Chrome\\\";v=\\\"136.0.7103.48\\\", \\\"Not.A/Brand\\\";v=\\\"99.0.0.0\\\"\",\"sec-ch-ua-mobile\":\"?0\",\"sec-ch-ua-model\":\"\\\"\\\"\",\"sec-ch-ua-platform\":\"\\\"macOS\\\"\",\"sec-ch-ua-platform-version\":\"\\\"15.4.1\\\"\",\"sec-ch-ua-wow64\":\"?0\",\"x-jpmc-client-request-id\":\"2e352685-05f7-41ee-aa22-ae732fc29e8c\"},\"method\":\"POST\",\"paramValues\":{},\"responseMatches\":[{\"type\":\"regex\",\"value\":\"\\\"id\\\":(?<id>[0-9]+)\"},{\"type\":\"regex\",\"value\":\"\\\"verboseStatus\\\":\\\"(?<verboseStatus>[^\\\"]+)\\\"\"},{\"type\":\"regex\",\"value\":\"\\\"date\\\":\\\"(?<date>[^\\\"]+)\\\"\"},{\"type\":\"regex\",\"value\":\"\\\"amount\\\":(?<amount>[0-9\\\\.]+)\"}],\"responseRedactions\":[{\"jsonPath\":\"$.listItems[0].id\",\"xPath\":\"\"},{\"jsonPath\":\"$.listItems[0].verboseStatus\",\"xPath\":\"\"},{\"jsonPath\":\"$.listItems[0].date\",\"xPath\":\"\"},{\"jsonPath\":\"$.listItems[0].amount\",\"xPath\":\"\"}],\"url\":\"https://secure.chase.com/svc/rr/payments/secure/v1/quickpay/payment/activity/list\"}",
    "owner": "0xf9f25d1b846625674901ace47d6313d1ac795265",
    "timestampS": 1746403585,
    "context": "{\"contextAddress\":\"0x0\",\"contextMessage\":\"0x0000000000000000000000000000000000000000000000000000000000000000\",\"extractedParameters\":{\"amount\":\"10\",\"date\":\"20250504\",\"id\":\"24648754807\",\"verboseStatus\":\"DELIVERED\"},\"providerHash\":\"0xc472a6b6bace68cef2750c5a713a9649b3a89965d2e7a7c81d8301987f281200\"}",
    "identifier": "0xe08d79d2e4b6226dc35f3e531835b9d03bf848761c6d6c17205ead880fef08f7",
    "epoch": 1
  },
  "signatures": {
    "attestorAddress": "0x0636c417755e3ae25c6c166d181c0607f4c572a3",
    "claimSignature": {
      "0": 122,
      "1": 142,
      "2": 217,
      "3": 132,
      "4": 26,
      "5": 12,
      "6": 232,
      "7": 164,
      "8": 178,
      "9": 139,
      "10": 181,
      "11": 155,
      "12": 48,
      "13": 197,
      "14": 50,
      "15": 243,
      "16": 210,
      "17": 187,
      "18": 60,
      "19": 80,
      "20": 219,
      "21": 14,
      "22": 213,
      "23": 80,
      "24": 226,
      "25": 206,
      "26": 6,
      "27": 225,
      "28": 174,
      "29": 10,
      "30": 171,
      "31": 174,
      "32": 32,
      "33": 203,
      "34": 214,
      "35": 14,
      "36": 7,
      "37": 204,
      "38": 11,
      "39": 243,
      "40": 178,
      "41": 144,
      "42": 235,
      "43": 149,
      "44": 128,
      "45": 178,
      "46": 52,
      "47": 55,
      "48": 195,
      "49": 25,
      "50": 36,
      "51": 197,
      "52": 248,
      "53": 81,
      "54": 208,
      "55": 103,
      "56": 144,
      "57": 166,
      "58": 13,
      "59": 243,
      "60": 111,
      "61": 219,
      "62": 76,
      "63": 31,
      "64": 27
    },
    "resultSignature": {
      "0": 1,
      "1": 204,
      "2": 224,
      "3": 139,
      "4": 130,
      "5": 24,
      "6": 243,
      "7": 156,
      "8": 99,
      "9": 224,
      "10": 133,
      "11": 200,
      "12": 190,
      "13": 217,
      "14": 116,
      "15": 101,
      "16": 215,
      "17": 90,
      "18": 117,
      "19": 85,
      "20": 237,
      "21": 200,
      "22": 245,
      "23": 248,
      "24": 183,
      "25": 20,
      "26": 164,
      "27": 183,
      "28": 122,
      "29": 108,
      "30": 116,
      "31": 132,
      "32": 90,
      "33": 117,
      "34": 172,
      "35": 118,
      "36": 184,
      "37": 254,
      "38": 74,
      "39": 211,
      "40": 103,
      "41": 193,
      "42": 214,
      "43": 155,
      "44": 20,
      "45": 117,
      "46": 254,
      "47": 211,
      "48": 151,
      "49": 232,
      "50": 69,
      "51": 99,
      "52": 66,
      "53": 194,
      "54": 27,
      "55": 205,
      "56": 18,
      "57": 218,
      "58": 72,
      "59": 226,
      "60": 105,
      "61": 201,
      "62": 242,
      "63": 153,
      "64": 27
    }
  }
};

const chaseListCompletedProof = {
  "claim": {
    "provider": "http",
    "parameters": "{\"body\":\"pageId=&sortBy=PROCESS_DATE&orderBy=DESC\",\"headers\":{\"Accept\":\"*/*\",\"Accept-Language\":\"en-US,en;q=0.9\",\"Content-Type\":\"application/x-www-form-urlencoded; charset=UTF-8\",\"Origin\":\"https://secure.chase.com\",\"Referer\":\"https://secure.chase.com/web/auth/dashboard\",\"Sec-Fetch-Dest\":\"empty\",\"Sec-Fetch-Mode\":\"cors\",\"Sec-Fetch-Site\":\"same-origin\",\"User-Agent\":\"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36\",\"sec-ch-ua\":\"\\\"Chromium\\\";v=\\\"136\\\", \\\"Google Chrome\\\";v=\\\"136\\\", \\\"Not.A/Brand\\\";v=\\\"99\\\"\",\"sec-ch-ua-arch\":\"\\\"arm\\\"\",\"sec-ch-ua-bitness\":\"\\\"64\\\"\",\"sec-ch-ua-full-version-list\":\"\\\"Chromium\\\";v=\\\"136.0.7103.48\\\", \\\"Google Chrome\\\";v=\\\"136.0.7103.48\\\", \\\"Not.A/Brand\\\";v=\\\"99.0.0.0\\\"\",\"sec-ch-ua-mobile\":\"?0\",\"sec-ch-ua-model\":\"\\\"\\\"\",\"sec-ch-ua-platform\":\"\\\"macOS\\\"\",\"sec-ch-ua-platform-version\":\"\\\"15.4.1\\\"\",\"sec-ch-ua-wow64\":\"?0\",\"x-jpmc-client-request-id\":\"7d9a760f-93f1-4c79-90a9-1f7f5fe3cf4d\"},\"method\":\"POST\",\"paramValues\":{},\"responseMatches\":[{\"type\":\"regex\",\"value\":\"\\\"id\\\":(?<id>[0-9]+)\"},{\"type\":\"regex\",\"value\":\"\\\"verboseStatus\\\":\\\"(?<verboseStatus>[^\\\"]+)\\\"\"},{\"type\":\"regex\",\"value\":\"\\\"date\\\":\\\"(?<date>[^\\\"]+)\\\"\"},{\"type\":\"regex\",\"value\":\"\\\"amount\\\":(?<amount>[0-9\\\\.]+)\"}],\"responseRedactions\":[{\"jsonPath\":\"$.listItems[2].id\",\"xPath\":\"\"},{\"jsonPath\":\"$.listItems[2].verboseStatus\",\"xPath\":\"\"},{\"jsonPath\":\"$.listItems[2].date\",\"xPath\":\"\"},{\"jsonPath\":\"$.listItems[2].amount\",\"xPath\":\"\"}],\"url\":\"https://secure.chase.com/svc/rr/payments/secure/v1/quickpay/payment/activity/list\"}",
    "owner": "0xf9f25d1b846625674901ace47d6313d1ac795265",
    "timestampS": 1746403777,
    "context": "{\"contextAddress\":\"0x0\",\"contextMessage\":\"0x0000000000000000000000000000000000000000000000000000000000000000\",\"extractedParameters\":{\"amount\":\"10\",\"date\":\"20250428\",\"id\":\"24569221649\",\"verboseStatus\":\"COMPLETED\"},\"providerHash\":\"0xd7615f705f999e8db7b0c9c2a16849559b88f3b95d6bdeed8a8c106bee870046\"}",
    "identifier": "0x4fa32890e7f7ae631445d2d962b75b0b69cc39c3e1e8daee57d2183da4e31877",
    "epoch": 1
  },
  "signatures": {
    "attestorAddress": "0x0636c417755e3ae25c6c166d181c0607f4c572a3",
    "claimSignature": {
      "0": 211,
      "1": 19,
      "2": 199,
      "3": 20,
      "4": 154,
      "5": 56,
      "6": 40,
      "7": 141,
      "8": 253,
      "9": 183,
      "10": 65,
      "11": 222,
      "12": 178,
      "13": 241,
      "14": 112,
      "15": 161,
      "16": 80,
      "17": 165,
      "18": 180,
      "19": 40,
      "20": 253,
      "21": 89,
      "22": 249,
      "23": 109,
      "24": 243,
      "25": 175,
      "26": 108,
      "27": 212,
      "28": 220,
      "29": 50,
      "30": 129,
      "31": 122,
      "32": 67,
      "33": 246,
      "34": 175,
      "35": 6,
      "36": 133,
      "37": 28,
      "38": 211,
      "39": 10,
      "40": 180,
      "41": 34,
      "42": 222,
      "43": 211,
      "44": 2,
      "45": 9,
      "46": 131,
      "47": 138,
      "48": 152,
      "49": 158,
      "50": 102,
      "51": 74,
      "52": 222,
      "53": 32,
      "54": 71,
      "55": 22,
      "56": 54,
      "57": 248,
      "58": 4,
      "59": 16,
      "60": 64,
      "61": 229,
      "62": 245,
      "63": 99,
      "64": 27
    },
    "resultSignature": {
      "0": 227,
      "1": 129,
      "2": 195,
      "3": 251,
      "4": 68,
      "5": 44,
      "6": 46,
      "7": 141,
      "8": 203,
      "9": 190,
      "10": 96,
      "11": 80,
      "12": 245,
      "13": 165,
      "14": 172,
      "15": 136,
      "16": 156,
      "17": 83,
      "18": 228,
      "19": 98,
      "20": 68,
      "21": 118,
      "22": 123,
      "23": 22,
      "24": 174,
      "25": 140,
      "26": 163,
      "27": 171,
      "28": 179,
      "29": 208,
      "30": 98,
      "31": 6,
      "32": 23,
      "33": 207,
      "34": 163,
      "35": 22,
      "36": 164,
      "37": 95,
      "38": 144,
      "39": 151,
      "40": 77,
      "41": 231,
      "42": 206,
      "43": 120,
      "44": 72,
      "45": 156,
      "46": 244,
      "47": 90,
      "48": 43,
      "49": 211,
      "50": 30,
      "51": 162,
      "52": 77,
      "53": 22,
      "54": 65,
      "55": 144,
      "56": 123,
      "57": 214,
      "58": 183,
      "59": 136,
      "60": 34,
      "61": 175,
      "62": 46,
      "63": 48,
      "64": 28
    }
  }
};

const chaseDetailDeliveredProof = {
  "claim": {
    "provider": "http",
    "parameters": "{\"body\":\"paymentId={{PAYMENT_ID}}\",\"headers\":{\"Accept\":\"*/*\",\"Accept-Language\":\"en-US,en;q=0.9\",\"Content-Type\":\"application/x-www-form-urlencoded; charset=UTF-8\",\"Origin\":\"https://secure.chase.com\",\"Referer\":\"https://secure.chase.com/web/auth/dashboard\",\"Sec-Fetch-Dest\":\"empty\",\"Sec-Fetch-Mode\":\"cors\",\"Sec-Fetch-Site\":\"same-origin\",\"User-Agent\":\"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36\",\"sec-ch-ua\":\"\\\"Chromium\\\";v=\\\"136\\\", \\\"Google Chrome\\\";v=\\\"136\\\", \\\"Not.A/Brand\\\";v=\\\"99\\\"\",\"sec-ch-ua-arch\":\"\\\"arm\\\"\",\"sec-ch-ua-bitness\":\"\\\"64\\\"\",\"sec-ch-ua-full-version-list\":\"\\\"Chromium\\\";v=\\\"136.0.7103.48\\\", \\\"Google Chrome\\\";v=\\\"136.0.7103.48\\\", \\\"Not.A/Brand\\\";v=\\\"99.0.0.0\\\"\",\"sec-ch-ua-mobile\":\"?0\",\"sec-ch-ua-model\":\"\\\"\\\"\",\"sec-ch-ua-platform\":\"\\\"macOS\\\"\",\"sec-ch-ua-platform-version\":\"\\\"15.4.1\\\"\",\"sec-ch-ua-wow64\":\"?0\",\"x-jpmc-client-request-id\":\"f02ea12a-8fa6-4aad-8828-b299403dd267\"},\"method\":\"POST\",\"paramValues\":{\"PAYMENT_ID\":\"24648754807\"},\"responseMatches\":[{\"hash\":true,\"type\":\"regex\",\"value\":\"\\\"recipientEmail\\\":\\\"(?<recipientEmail>[^\\\"]+)\\\"\"}],\"responseRedactions\":[{\"jsonPath\":\"$.recipientEmail\",\"xPath\":\"\"}],\"url\":\"https://secure.chase.com/svc/rr/payments/secure/v1/quickpay/payment/activity/detail/list\"}",
    "owner": "0xf9f25d1b846625674901ace47d6313d1ac795265",
    "timestampS": 1746404764,
    "context": "{\"contextAddress\":\"0x0\",\"contextMessage\":\"0x0000000000000000000000000000000000000000000000000000000000000000\",\"extractedParameters\":{\"PAYMENT_ID\":\"24648754807\",\"recipientEmail\":\"0x829bf7a59c5884cda204d6932e01e010a0b609e16dcef6da89b571a30b8b7cbb\"},\"providerHash\":\"0x21eb240c8a3131b258efceb330081cc0f8ca3e6e9e715e95fa0841ffe6a88dbe\"}",
    "identifier": "0x52b83ca3b19640d51b838d69301732d9c5d126176b8de12cb5957aefba983de5",
    "epoch": 1
  },
  "signatures": {
    "attestorAddress": "0x0636c417755e3ae25c6c166d181c0607f4c572a3",
    "claimSignature": {
      "0": 240,
      "1": 213,
      "2": 153,
      "3": 129,
      "4": 29,
      "5": 229,
      "6": 12,
      "7": 236,
      "8": 90,
      "9": 153,
      "10": 149,
      "11": 124,
      "12": 8,
      "13": 9,
      "14": 206,
      "15": 190,
      "16": 169,
      "17": 82,
      "18": 170,
      "19": 81,
      "20": 213,
      "21": 56,
      "22": 211,
      "23": 74,
      "24": 4,
      "25": 125,
      "26": 228,
      "27": 63,
      "28": 50,
      "29": 39,
      "30": 67,
      "31": 154,
      "32": 81,
      "33": 202,
      "34": 180,
      "35": 91,
      "36": 255,
      "37": 109,
      "38": 192,
      "39": 251,
      "40": 59,
      "41": 163,
      "42": 73,
      "43": 248,
      "44": 55,
      "45": 88,
      "46": 191,
      "47": 122,
      "48": 240,
      "49": 98,
      "50": 70,
      "51": 242,
      "52": 123,
      "53": 234,
      "54": 16,
      "55": 77,
      "56": 163,
      "57": 168,
      "58": 225,
      "59": 151,
      "60": 222,
      "61": 111,
      "62": 254,
      "63": 40,
      "64": 28
    },
    "resultSignature": {
      "0": 164,
      "1": 193,
      "2": 115,
      "3": 82,
      "4": 53,
      "5": 65,
      "6": 244,
      "7": 23,
      "8": 123,
      "9": 133,
      "10": 127,
      "11": 128,
      "12": 52,
      "13": 71,
      "14": 226,
      "15": 159,
      "16": 242,
      "17": 4,
      "18": 18,
      "19": 185,
      "20": 13,
      "21": 215,
      "22": 142,
      "23": 111,
      "24": 158,
      "25": 52,
      "26": 214,
      "27": 130,
      "28": 49,
      "29": 221,
      "30": 95,
      "31": 143,
      "32": 7,
      "33": 164,
      "34": 183,
      "35": 29,
      "36": 26,
      "37": 118,
      "38": 139,
      "39": 74,
      "40": 248,
      "41": 55,
      "42": 130,
      "43": 63,
      "44": 37,
      "45": 59,
      "46": 228,
      "47": 151,
      "48": 3,
      "49": 135,
      "50": 165,
      "51": 242,
      "52": 199,
      "53": 16,
      "54": 188,
      "55": 13,
      "56": 241,
      "57": 110,
      "58": 195,
      "59": 103,
      "60": 210,
      "61": 66,
      "62": 169,
      "63": 51,
      "64": 27
    }
  }
}

const chaseDetailCompletedProof = {
  "claim": {
    "provider": "http",
    "parameters": "{\"body\":\"paymentId={{PAYMENT_ID}}\",\"headers\":{\"Accept\":\"*/*\",\"Accept-Language\":\"en-US,en;q=0.9\",\"Content-Type\":\"application/x-www-form-urlencoded; charset=UTF-8\",\"Origin\":\"https://secure.chase.com\",\"Referer\":\"https://secure.chase.com/web/auth/dashboard\",\"Sec-Fetch-Dest\":\"empty\",\"Sec-Fetch-Mode\":\"cors\",\"Sec-Fetch-Site\":\"same-origin\",\"User-Agent\":\"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36\",\"sec-ch-ua\":\"\\\"Chromium\\\";v=\\\"136\\\", \\\"Google Chrome\\\";v=\\\"136\\\", \\\"Not.A/Brand\\\";v=\\\"99\\\"\",\"sec-ch-ua-arch\":\"\\\"arm\\\"\",\"sec-ch-ua-bitness\":\"\\\"64\\\"\",\"sec-ch-ua-full-version-list\":\"\\\"Chromium\\\";v=\\\"136.0.7103.48\\\", \\\"Google Chrome\\\";v=\\\"136.0.7103.48\\\", \\\"Not.A/Brand\\\";v=\\\"99.0.0.0\\\"\",\"sec-ch-ua-mobile\":\"?0\",\"sec-ch-ua-model\":\"\\\"\\\"\",\"sec-ch-ua-platform\":\"\\\"macOS\\\"\",\"sec-ch-ua-platform-version\":\"\\\"15.4.1\\\"\",\"sec-ch-ua-wow64\":\"?0\",\"x-jpmc-client-request-id\":\"f02ea12a-8fa6-4aad-8828-b299403dd267\"},\"method\":\"POST\",\"paramValues\":{\"PAYMENT_ID\":\"24569221649\"},\"responseMatches\":[{\"hash\":true,\"type\":\"regex\",\"value\":\"\\\"recipientEmail\\\":\\\"(?<recipientEmail>[^\\\"]+)\\\"\"}],\"responseRedactions\":[{\"jsonPath\":\"$.recipientEmail\",\"xPath\":\"\"}],\"url\":\"https://secure.chase.com/svc/rr/payments/secure/v1/quickpay/payment/activity/detail/list\"}",
    "owner": "0xf9f25d1b846625674901ace47d6313d1ac795265",
    "timestampS": 1746404775,
    "context": "{\"contextAddress\":\"0x0\",\"contextMessage\":\"0x0000000000000000000000000000000000000000000000000000000000000000\",\"extractedParameters\":{\"PAYMENT_ID\":\"24569221649\",\"recipientEmail\":\"0x829bf7a59c5884cda204d6932e01e010a0b609e16dcef6da89b571a30b8b7cbb\"},\"providerHash\":\"0x21eb240c8a3131b258efceb330081cc0f8ca3e6e9e715e95fa0841ffe6a88dbe\"}",
    "identifier": "0x7229a848b8a960f033ddab97942600df55cecc59c65f71ad08a6ad0bb7c8b122",
    "epoch": 1
  },
  "signatures": {
    "attestorAddress": "0x0636c417755e3ae25c6c166d181c0607f4c572a3",
    "claimSignature": {
      "0": 248,
      "1": 70,
      "2": 42,
      "3": 21,
      "4": 94,
      "5": 10,
      "6": 74,
      "7": 135,
      "8": 166,
      "9": 225,
      "10": 81,
      "11": 179,
      "12": 70,
      "13": 238,
      "14": 131,
      "15": 131,
      "16": 218,
      "17": 159,
      "18": 18,
      "19": 147,
      "20": 232,
      "21": 136,
      "22": 24,
      "23": 244,
      "24": 240,
      "25": 184,
      "26": 248,
      "27": 161,
      "28": 240,
      "29": 40,
      "30": 69,
      "31": 169,
      "32": 20,
      "33": 98,
      "34": 90,
      "35": 121,
      "36": 27,
      "37": 19,
      "38": 97,
      "39": 202,
      "40": 132,
      "41": 61,
      "42": 247,
      "43": 99,
      "44": 35,
      "45": 181,
      "46": 53,
      "47": 216,
      "48": 107,
      "49": 136,
      "50": 59,
      "51": 62,
      "52": 190,
      "53": 196,
      "54": 89,
      "55": 223,
      "56": 180,
      "57": 0,
      "58": 56,
      "59": 63,
      "60": 254,
      "61": 101,
      "62": 123,
      "63": 67,
      "64": 28
    },
    "resultSignature": {
      "0": 5,
      "1": 39,
      "2": 178,
      "3": 4,
      "4": 132,
      "5": 77,
      "6": 234,
      "7": 232,
      "8": 161,
      "9": 37,
      "10": 224,
      "11": 10,
      "12": 12,
      "13": 16,
      "14": 231,
      "15": 172,
      "16": 104,
      "17": 81,
      "18": 187,
      "19": 227,
      "20": 27,
      "21": 238,
      "22": 214,
      "23": 169,
      "24": 252,
      "25": 59,
      "26": 111,
      "27": 6,
      "28": 42,
      "29": 165,
      "30": 102,
      "31": 77,
      "32": 8,
      "33": 135,
      "34": 75,
      "35": 232,
      "36": 28,
      "37": 178,
      "38": 3,
      "39": 146,
      "40": 194,
      "41": 10,
      "42": 63,
      "43": 247,
      "44": 161,
      "45": 76,
      "46": 114,
      "47": 43,
      "48": 202,
      "49": 7,
      "50": 116,
      "51": 89,
      "52": 243,
      "53": 127,
      "54": 153,
      "55": 227,
      "56": 192,
      "57": 108,
      "58": 80,
      "59": 135,
      "60": 40,
      "61": 70,
      "62": 227,
      "63": 178,
      "64": 28
    }
  }
}

describe("ZelleChaseReclaimVerifier", () => {
  let owner: Account;
  let attacker: Account;
  let escrow: Account;
  let providerHashes: string[];
  let witnesses: Address[];
  let subjectCaller: Account;

  let nullifierRegistry: NullifierRegistry;
  let baseVerifier: ZelleBaseVerifier;
  let verifier: ZelleChaseReclaimVerifier;
  let usdcToken: USDCMock;

  let deployer: DeployHelper;

  beforeEach(async () => {
    [
      owner,
      attacker,
      escrow
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    usdcToken = await deployer.deployUSDCMock(usdc(1000000000), "USDC", "USDC");

    witnesses = ["0x0636c417755e3ae25c6c166d181c0607f4c572a3"];
    providerHashes = [
      "0xd7615f705f999e8db7b0c9c2a16849559b88f3b95d6bdeed8a8c106bee870046", // list completed
      "0xc472a6b6bace68cef2750c5a713a9649b3a89965d2e7a7c81d8301987f281200", // list delivered
      "0x21eb240c8a3131b258efceb330081cc0f8ca3e6e9e715e95fa0841ffe6a88dbe"  // detail
    ];

    nullifierRegistry = await deployer.deployNullifierRegistry();

    baseVerifier = await deployer.deployZelleBaseVerifier(
      escrow.address,
      nullifierRegistry.address,
      BigNumber.from(30),
      [Currency.USD]
    );

    verifier = await deployer.deployZelleChaseReclaimVerifier(
      baseVerifier.address,
      nullifierRegistry.address,
      providerHashes,
      BigNumber.from(60)
    );

    await nullifierRegistry.connect(owner.wallet).addWritePermission(verifier.address);

    // Set up impersonated signer for base verifier
    await hre.network.provider.request({
      method: "hardhat_impersonateAccount",
      params: [baseVerifier.address],
    });

    const baseVerifierSigner = await ethers.getSigner(baseVerifier.address);

    // Set balance for base verifier for gas
    await hre.network.provider.send("hardhat_setBalance", [
      baseVerifier.address,
      "0x56BC75E2D63100000" // 100 ETH in hex
    ]);

    subjectCaller = {
      address: baseVerifier.address,
      wallet: baseVerifierSigner
    };
  });

  describe("#constructor", async () => {
    it("should set the correct state", async () => {
      const baseVerifierAddress = await verifier.baseVerifier();
      const nullifierRegistryAddress = await verifier.nullifierRegistry();
      const providerHashes = await verifier.getProviderHashes();

      expect(nullifierRegistryAddress).to.eq(nullifierRegistry.address);
      expect(providerHashes).to.deep.eq(providerHashes);
      expect(baseVerifierAddress).to.eq(baseVerifier.address);
    });
  });

  describe("#verifyPayment", async () => {
    let proofList: ReclaimProof;
    let proofDetail: ReclaimProof;

    let subjectProof: BytesLike;
    let subjectDepositToken: Address;
    let subjectIntentAmount: BigNumber;
    let subjectIntentTimestamp: BigNumber;
    let subjectConversionRate: BigNumber;
    let subjectPayeeDetailsHash: string;
    let subjectFiatCurrency: BytesLike;
    let subjectData: BytesLike;
    let subjectDepositData: BytesLike;

    let paymentTimestamp: number;

    beforeEach(async () => {
      proofList = parseExtensionProof(chaseListCompletedProof);
      proofDetail = parseExtensionProof(chaseDetailCompletedProof);

      subjectProof = encodeTwoProofs(proofList, proofDetail);

      // For this example, date is "20250428" (YYYYMMDD)
      const paymentTimeString = '2025-04-28';
      const paymentTime = new Date(paymentTimeString);
      paymentTimestamp = Math.floor(paymentTime.getTime() / 1000);

      subjectDepositToken = usdcToken.address;
      subjectIntentAmount = usdc(10);
      subjectIntentTimestamp = BigNumber.from(paymentTimestamp);
      subjectConversionRate = ether(1);   // 10 * 1 = 10
      subjectPayeeDetailsHash = "0x829bf7a59c5884cda204d6932e01e010a0b609e16dcef6da89b571a30b8b7cbb";
      subjectFiatCurrency = Currency.USD;
      subjectData = "0x";
      subjectDepositData = ethers.utils.defaultAbiCoder.encode(
        ['address[]'],
        [witnesses]
      );
    });

    async function subject(): Promise<any> {
      return await verifier.connect(subjectCaller.wallet).verifyPayment({
        paymentProof: subjectProof,
        depositToken: subjectDepositToken,
        intentAmount: subjectIntentAmount,
        intentTimestamp: subjectIntentTimestamp,
        payeeDetails: subjectPayeeDetailsHash,
        fiatCurrency: subjectFiatCurrency,
        conversionRate: subjectConversionRate,
        data: subjectData,
        depositData: subjectDepositData
      });
    }

    async function subjectCallStatic(): Promise<any> {
      return await verifier.connect(subjectCaller.wallet).callStatic.verifyPayment({
        paymentProof: subjectProof,
        depositToken: subjectDepositToken,
        intentAmount: subjectIntentAmount,
        intentTimestamp: subjectIntentTimestamp,
        payeeDetails: subjectPayeeDetailsHash,
        fiatCurrency: subjectFiatCurrency,
        conversionRate: subjectConversionRate,
        data: subjectData,
        depositData: subjectDepositData
      });
    }

    it("should verify the proof", async () => {
      const result = await subjectCallStatic();

      expect(result.success).to.be.true;
      expect(result.intentHash).to.eq("0x0000000000000000000000000000000000000000000000000000000000000000");
      // Payment is $10, conversion rate is 1, intent amount is 10
      // Release amount = 10 / 1 = 10
      expect(result.releaseAmount).to.eq(usdc(10));
      expect(result.paymentCurrency).to.eq(Currency.USD);
      expect(result.paymentId).to.eq('24569221649');
    });

    describe("when the payment amount is less than the expected payment amount", async () => {
      beforeEach(async () => {
        subjectIntentAmount = usdc(20); // Intent expects 20 * 0.9 = 18, but actual payment is 10
        subjectConversionRate = ether(0.9);
      });

      it("should succeed with partial payment", async () => {
        const result = await subjectCallStatic();

        expect(result.success).to.be.true;
        expect(result.intentHash).to.eq("0x0000000000000000000000000000000000000000000000000000000000000000");
        // Payment is $10, conversion rate is 0.9, intent amount is 20
        // Release amount = 10 / 0.9 = 11.111...
        expect(result.releaseAmount).to.eq(usdc(11.111111));  // 6 decimal places rounded down
        expect(result.paymentCurrency).to.eq(Currency.USD);
        expect(result.paymentId).to.eq('24569221649');
      });
    });

    describe("when the payment amount is zero", async () => {
      beforeEach(async () => {
        // Create proofs with zero payment amount
        const zeroAmountListProof = {
          ...proofList,
          claimInfo: {
            ...proofList.claimInfo,
            context: "{\"contextAddress\":\"0x0\",\"contextMessage\":\"0x0000000000000000000000000000000000000000000000000000000000000000\",\"extractedParameters\":{\"amount\":\"0\",\"date\":\"20250428\",\"id\":\"24569221649\",\"verboseStatus\":\"COMPLETED\"},\"providerHash\":\"0xd7615f705f999e8db7b0c9c2a16849559b88f3b95d6bdeed8a8c106bee870046\"}"
          }
        };

        const zeroAmountDetailProof = {
          ...proofDetail,
          claimInfo: {
            ...proofDetail.claimInfo,
            context: "{\"contextAddress\":\"0x0\",\"contextMessage\":\"0x0000000000000000000000000000000000000000000000000000000000000000\",\"extractedParameters\":{\"PAYMENT_ID\":\"24569221649\",\"recipientEmail\":\"0x829bf7a59c5884cda204d6932e01e010a0b609e16dcef6da89b571a30b8b7cbb\"},\"providerHash\":\"0x21eb240c8a3131b258efceb330081cc0f8ca3e6e9e715e95fa0841ffe6a88dbe\"}"
          }
        };

        // Update identifiers
        zeroAmountListProof.signedClaim.claim.identifier = getIdentifierFromClaimInfo(zeroAmountListProof.claimInfo);
        zeroAmountDetailProof.signedClaim.claim.identifier = getIdentifierFromClaimInfo(zeroAmountDetailProof.claimInfo);

        // Sign with witnesses
        const listDigest = createSignDataForClaim(zeroAmountListProof.signedClaim.claim);
        const detailDigest = createSignDataForClaim(zeroAmountDetailProof.signedClaim.claim);

        const witness = ethers.Wallet.createRandom();
        zeroAmountListProof.signedClaim.signatures = [await witness.signMessage(listDigest)];
        zeroAmountDetailProof.signedClaim.signatures = [await witness.signMessage(detailDigest)];

        subjectProof = encodeTwoProofs(zeroAmountListProof, zeroAmountDetailProof);
        subjectDepositData = ethers.utils.defaultAbiCoder.encode(
          ['address[]'],
          [[witness.address]]
        );
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Payment amount must be greater than zero");
      });
    });

    describe("when the payment was made before the intent", async () => {
      beforeEach(async () => {
        subjectIntentTimestamp = BigNumber.from(paymentTimestamp).add(86400).add(BigNumber.from(60));   // 1 second after the payment timestamp + 23:59:59 + buffer of 60 seconds
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Incorrect payment timestamp");
      });
    });

    describe("when the payment recipient is incorrect", async () => {
      beforeEach(async () => {
        subjectPayeeDetailsHash = "0x1234567890123456789012345678901234567890123456789012345678901234";
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Incorrect payment recipient");
      });
    });

    describe("when the proof has already been verified", async () => {
      beforeEach(async () => {
        await subject();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Nullifier has already been used");
      });
    });

    describe("when the provider list hash is invalid", async () => {
      beforeEach(async () => {
        // Mutate the providerHash in the list proof
        proofList.claimInfo.context = proofList.claimInfo.context.replace(
          "0xd7615f705f999e8db7b0c9c2a16849559b88f3b95d6bdeed8a8c106bee870046",
          "0xbbb4d6813c1ccac7253673094ce4c1e122fe358682392851cfa332fe8359b8fc"
        );
        proofList.signedClaim.claim.identifier = getIdentifierFromClaimInfo(proofList.claimInfo);
        // sign the updated claim with a witness
        const digest = createSignDataForClaim(proofList.signedClaim.claim);
        const witness = ethers.Wallet.createRandom();
        proofList.signedClaim.signatures = [await witness.signMessage(digest)];

        // Re-encode
        subjectProof = encodeTwoProofs(proofList, proofDetail);
        subjectDepositData = ethers.utils.defaultAbiCoder.encode(
          ['address[]'],
          [[witness.address, witnesses[0]]]
        );
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("No valid providerHashList");
      });
    });

    describe("when the provider detail hash is invalid", async () => {
      beforeEach(async () => {
        // Mutate the providerHash in the detail proof
        proofDetail.claimInfo.context = proofDetail.claimInfo.context.replace(
          "0x21eb240c8a3131b258efceb330081cc0f8ca3e6e9e715e95fa0841ffe6a88dbe",
          "0xbbb4d6813c1ccac7253673094ce4c1e122fe358682392851cfa332fe8359b8fc"
        );
        proofDetail.signedClaim.claim.identifier = getIdentifierFromClaimInfo(proofDetail.claimInfo);
        // sign the updated claim with a witness
        const digest = createSignDataForClaim(proofDetail.signedClaim.claim);
        const witness = ethers.Wallet.createRandom();
        proofDetail.signedClaim.signatures = [await witness.signMessage(digest)];

        // Re-encode
        subjectProof = encodeTwoProofs(proofList, proofDetail);
        subjectDepositData = ethers.utils.defaultAbiCoder.encode(
          ['address[]'],
          [[witness.address, witnesses[0]]]
        );
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("No valid providerHashDetail");
      });
    });

    describe("when the payment status is not COMPLETED or DELIVERED", async () => {
      beforeEach(async () => {
        proofList.claimInfo.context = proofList.claimInfo.context.replace("COMPLETED", "PENDING");
        proofList.signedClaim.claim.identifier = getIdentifierFromClaimInfo(proofList.claimInfo);
        // sign the updated claim with a witness
        const digest = createSignDataForClaim(proofList.signedClaim.claim);
        const witness = ethers.Wallet.createRandom();
        proofList.signedClaim.signatures = [await witness.signMessage(digest)];

        // Re-encode
        subjectProof = encodeTwoProofs(proofList, proofDetail);
        subjectDepositData = ethers.utils.defaultAbiCoder.encode(
          ['address[]'],
          [[witness.address, witnesses[0]]]
        );
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Payment not completed or delivered");
      });
    });

    describe("when the payment IDs do not match", async () => {
      beforeEach(async () => {
        proofDetail.claimInfo.context = proofDetail.claimInfo.context.replace("24569221649", "99999999999");
        proofDetail.signedClaim.claim.identifier = getIdentifierFromClaimInfo(proofDetail.claimInfo);
        // sign the updated claim with a witness
        const digest = createSignDataForClaim(proofDetail.signedClaim.claim);
        const witness = ethers.Wallet.createRandom();
        proofDetail.signedClaim.signatures = [await witness.signMessage(digest)];

        // Re-encode
        subjectProof = encodeTwoProofs(proofList, proofDetail);
        subjectDepositData = ethers.utils.defaultAbiCoder.encode(
          ['address[]'],
          [[witness.address, witnesses[0]]]
        );
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Payment IDs do not match");
      });
    });

    describe("when the caller is not the base verifier", async () => {
      beforeEach(async () => {
        subjectCaller = owner;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Only base verifier can call");
      });
    });
  });


  describe("#setTimestampBuffer", async () => {
    let subjectBuffer: BigNumber;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectBuffer = BigNumber.from(60);
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return await verifier.connect(subjectCaller.wallet).setTimestampBuffer(subjectBuffer);
    }

    it("should set the timestamp buffer correctly", async () => {
      await subject();
      expect(await verifier.timestampBuffer()).to.equal(subjectBuffer);
    });

    it("should emit the TimestampBufferSet event", async () => {
      await expect(subject()).to.emit(verifier, "TimestampBufferSet").withArgs(subjectBuffer);
    });

    describe("when the caller is not the owner", async () => {
      beforeEach(async () => {
        subjectCaller = attacker;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });
  });
});

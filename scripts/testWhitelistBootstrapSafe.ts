import assert from "assert";

import { BigNumber, ethers } from "ethers";

import {
  POLICY_ABI,
  buildSafeBatch,
  buildSafeTransaction,
} from "./bootstrapWhitelistPolicy";

const policyAddress = "0x1000000000000000000000000000000000000001";
const escrowAddress = "0x2000000000000000000000000000000000000002";
const safeAddress = "0x3000000000000000000000000000000000000003";
const depositIds = [BigNumber.from(7), BigNumber.from(42)];
const groupIds = [
  `0x${"11".repeat(32)}`,
  `0x${"22".repeat(32)}`,
];

const transaction = buildSafeTransaction(policyAddress, escrowAddress, depositIds, groupIds);
assert.equal(transaction.to, ethers.utils.getAddress(policyAddress));
assert.equal(transaction.value, "0");
assert.equal(transaction.contractMethod, null);
assert.equal(transaction.contractInputsValues, null);

const policyInterface = new ethers.utils.Interface(POLICY_ABI);
const decoded = policyInterface.decodeFunctionData("bootstrapDeposits", transaction.data);
assert.equal(decoded[0], ethers.utils.getAddress(escrowAddress));
assert.deepEqual(decoded[1].map((depositId: BigNumber) => depositId.toString()), ["7", "42"]);
assert.deepEqual(decoded[2].map((groupId: string) => groupId.toLowerCase()), groupIds);

const safeBatch = buildSafeBatch(
  "base",
  8453,
  policyAddress,
  safeAddress,
  depositIds.length,
  [transaction],
);
assert.equal(safeBatch.chainId, "8453");
assert.equal(safeBatch.meta.createdFromSafeAddress, ethers.utils.getAddress(safeAddress));
assert.match(safeBatch.meta.description, new RegExp(ethers.utils.getAddress(policyAddress)));
assert.match(safeBatch.meta.description, new RegExp(ethers.utils.getAddress(safeAddress)));
assert.deepEqual(safeBatch.transactions, [transaction]);

assert.throws(
  () => buildSafeBatch("base", 8453, policyAddress, safeAddress, 0, []),
  /empty whitelist bootstrap Safe batch/,
);

console.log("Whitelist bootstrap Safe calldata and metadata validation passed");

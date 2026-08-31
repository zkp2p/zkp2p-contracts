const assert = require("node:assert/strict");
const { test } = require("node:test");

require("ts-node/register/transpile-only");

const {
  XMONEY_CURRENCIES,
  XMONEY_PAYMENT_METHOD_HASH,
} = require("../deployments/verifiers/xmoney");

test("uses the canonical X Money hash and USD currency", () => {
  assert.equal(
    XMONEY_PAYMENT_METHOD_HASH,
    "0x790dd0cc68b6e7f474649a6c0a5463a964be9d2589e2076b6dc99f5701543f51",
  );
  assert.deepEqual(XMONEY_CURRENCIES, [
    "0xc4ae21aac0c6549d71dd96035b7e0bdb6c79ebdba8891b666115bc976d16a29e",
  ]);
});

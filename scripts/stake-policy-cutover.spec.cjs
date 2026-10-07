require('ts-node/register/transpile-only');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assertDrainedInventory } = require('./prepareStakePolicyCutover');
const settled = { hash: 'intent', status: 3, stakeOwner: '0xABC', releaseAmount: '60000000', releaseEligibleAt: '1700000000', lockOwner: '0xabc', lockAmount: '60000000', lockMaturity: '1700000000' };
test('allows nonempty settled inventory without changing owners, amounts or deadlines', () => assert.doesNotThrow(() => assertDrainedInventory([settled])));
test('pending inventory blocks handover even after elapsed maturity', () => assert.throws(() => assertDrainedInventory([{ ...settled, status: 1 }]), /Pending/));
test('missing admission record fails closed', () => assert.throws(() => assertDrainedInventory([{ ...settled, status: 0 }]), /Missing/));
for (const field of ['lockOwner', 'lockAmount', 'lockMaturity']) {
  test(`rejects ${field} drift`, () => assert.throws(() => assertDrainedInventory([{ ...settled, [field]: 'different' }]), /lock mismatch/));
}
for (const status of [2, 4, 5]) {
  test(`terminal status ${status} must have no vault lock`, () => {
    assert.throws(() => assertDrainedInventory([{ ...settled, status }]), /still locked/);
    assert.doesNotThrow(() => assertDrainedInventory([{ ...settled, status, lockAmount: '0' }]));
  });
}

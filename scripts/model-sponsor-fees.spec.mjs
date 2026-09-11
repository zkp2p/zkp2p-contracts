import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { modelSponsorFees } from './model-sponsor-fees.mjs';

const scenario = JSON.parse(readFileSync(new URL('./fixtures/sponsor-fees.json', import.meta.url), 'utf8'));
const model = (overrides = {}) => modelSponsorFees({ ...scenario, ...overrides });

test('80 bps funds a 12% target with a 14-day hold and a 150 bps fee budget', () => {
  const result = model({ sponsorFeeBps: 80, serviceFeeBps: 150, minimumPeerFeeBps: 20 });
  assert.equal(result.requiredSponsorFeeBps, 77);
  assert.equal(result.netAprPercent.toFixed(4), '12.7098');
  assert.equal(result.annualNetIncomeUsd.toFixed(2), '1270.98');
  assert.equal(result.annualVolumeUsd.toFixed(2), '195535.71');
  assert.equal(result.maximumLossBpsForTarget.toFixed(4), '13.6301');
  assert.equal(result.feeBudgetFits, true);
  assert.equal(result.peerRemainderBps, 20);
});

test('the approved L1-priced fixture uses 40 bps and fits a 100 bps total budget', () => {
  const result = model();
  assert.equal(result.assumptions.sponsorFeeBps, result.assumptions.l1FeeBps);
  assert.equal(result.netAprPercent.toFixed(4), '4.8884');
  assert.equal(result.requiredSponsorFeeBps, 77);
  assert.equal(result.peerRemainderBps, 10);
  assert.equal(result.feeBudgetFits, true);
});

test('idle collateral and delayed release reduce throughput without changing the fee per fill', () => {
  assert.equal(model({ utilizationBps: 5000 }).requiredSponsorFeeBps, 108);
  assert.equal(model({ additionalHoldDays: 2 }).requiredSponsorFeeBps, 86);
  assert.equal(model({ additionalHoldDays: 2 }).netAprPercent.toFixed(4), '4.2773');
});

test('zero utilization has no earnings and no attainable volume-based target fee', () => {
  const result = model({ utilizationBps: 0 });
  assert.equal(result.annualVolumeUsd, 0);
  assert.equal(result.annualNetIncomeUsd, 0);
  assert.equal(result.requiredSponsorFeeBps, null);
});

test('loss stress preserves negative returns rather than clipping them to zero', () => {
  assert.equal(model({ expectedLossBps: 100 }).netAprPercent.toFixed(4), '-12.7098');
});

test('a 75 bps budget exposes the shortfall without taking existing referral fees', () => {
  const result = model({ serviceFeeBps: 75 });
  assert.equal(result.requiredServiceFeeBps, 100);
  assert.equal(result.budgetShortfallBps, 25);
  assert.equal(result.peerRemainderBps, -15);
  assert.equal(result.feeBudgetFits, false);
});

test('capital scales dollars, not the required rate or annualized return', () => {
  const small = model();
  const large = model({ capitalUsd: 100000 });
  assert.equal(large.annualNetIncomeUsd.toFixed(2), '4888.39');
  assert.equal(large.requiredSponsorFeeBps, small.requiredSponsorFeeBps);
  assert.equal(large.netAprPercent, small.netAprPercent);
});

test('whole-bp fee ceiling keeps exact boundaries and flags unattainable rates', () => {
  assert.equal(model({ riskWindowDays: 365, utilizationBps: 10000 }).requiredSponsorFeeBps, 1215);
  const result = model({ utilizationBps: 1 });
  assert.equal(result.requiredSponsorFeeBps, 460289);
});

test('input errors reject missing, misspelled, non-finite, fractional and out-of-range assumptions', () => {
  for (const [key, value] of [
    ['utilizationBps', 10001], ['utilizationBps', -1], ['riskWindowDays', 0],
    ['additionalHoldDays', -1], ['sponsorFeeBps', NaN], ['capitalUsd', Infinity],
    ['expectedLossBps', 0.5], ['targetNetAprBps', '1200'], ['operatingCostBps', undefined],
  ]) {
    assert.throws(() => model({ [key]: value }), new RegExp(key));
  }
  assert.throws(() => model({ lockDays: 14 }), /Unknown scenario input: lockDays/);
  assert.throws(() => modelSponsorFees(null), /Scenario must be an object/);
});

test('CLI produces the same scenario results', () => {
  const result = spawnSync(process.execPath, [
    new URL('./model-sponsor-fees.mjs', import.meta.url).pathname,
    new URL('./fixtures/sponsor-fees.json', import.meta.url).pathname,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), model());
});

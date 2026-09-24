#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const YEAR_DAYS = 365;
const BPS = 10_000;

/** Offline, steady-state economics. All rates are bps; all inputs are assumptions. */
export function modelSponsorFees(input) {
  const bounds = {
    capitalUsd: [1, 1_000_000_000],
    riskWindowDays: [1, 365],
    additionalHoldDays: [0, 365],
    utilizationBps: [0, BPS],
    targetNetAprBps: [0, BPS],
    expectedLossBps: [0, BPS],
    operatingCostBps: [0, BPS],
    sponsorFeeBps: [0, BPS],
    serviceFeeBps: [0, BPS],
    l1FeeBps: [0, BPS],
    l2FeeBps: [0, BPS],
    minimumPeerFeeBps: [0, BPS],
  };
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('Scenario must be an object');
  }
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(bounds, key)) throw new Error(`Unknown scenario input: ${key}`);
  }
  for (const [key, [min, max]] of Object.entries(bounds)) {
    if (!Number.isSafeInteger(input[key]) || input[key] < min || input[key] > max) {
      throw new Error(`${key} must be an integer between ${min} and ${max}`);
    }
  }

  // The policy locks 100% of gross release amount. There is no collateral multiplier.
  const holdDays = input.riskWindowDays + input.additionalHoldDays;
  const utilization = input.utilizationBps / BPS;
  const annualVolumePerDollar = utilization * YEAR_DAYS / holdDays;
  const annualVolumeUsd = input.capitalUsd * annualVolumePerDollar;
  const netMarginBps = input.sponsorFeeBps - input.expectedLossBps - input.operatingCostBps;
  const annualFeeUsd = annualVolumeUsd * input.sponsorFeeBps / BPS;
  const annualLossUsd = annualVolumeUsd * input.expectedLossBps / BPS;
  const annualOperatingCostUsd = annualVolumeUsd * input.operatingCostBps / BPS;

  // Ceiling is exact at the whole-bp pricing boundary, including exact integer results.
  const numerator = BigInt(input.targetNetAprBps) * BigInt(holdDays) * BigInt(BPS);
  const denominator = BigInt(YEAR_DAYS) * BigInt(input.utilizationBps);
  const requiredSponsorFeeBps = denominator === 0n ? null :
    Number((numerator + denominator - 1n) / denominator) + input.expectedLossBps + input.operatingCostBps;
  const requiredServiceFeeBps = input.sponsorFeeBps + input.l1FeeBps + input.l2FeeBps + input.minimumPeerFeeBps;
  const budgetShortfallBps = Math.max(0, requiredServiceFeeBps - input.serviceFeeBps);

  return {
    assumptions: { ...input },
    holdDays,
    annualVolumePerDollar,
    annualVolumeUsd,
    annualFeeUsd,
    annualLossUsd,
    annualOperatingCostUsd,
    annualNetIncomeUsd: annualVolumeUsd * netMarginBps / BPS,
    grossAprPercent: input.sponsorFeeBps * annualVolumePerDollar / 100,
    netAprPercent: netMarginBps * annualVolumePerDollar / 100,
    requiredSponsorFeeBps,
    maximumLossBpsForTarget: input.utilizationBps === 0 ? null :
      input.sponsorFeeBps - input.operatingCostBps - input.targetNetAprBps / annualVolumePerDollar,
    requiredServiceFeeBps,
    budgetShortfallBps,
    feeBudgetFits: budgetShortfallBps === 0,
    peerRemainderBps: input.serviceFeeBps - input.l1FeeBps - input.l2FeeBps - input.sponsorFeeBps,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] === '--help') {
    process.stdout.write('Usage: node scripts/model-sponsor-fees.mjs <scenario.json>\n');
    process.exitCode = args[0] === '--help' ? 0 : 1;
  } else {
    const input = JSON.parse(readFileSync(args[0], 'utf8'));
    process.stdout.write(`${JSON.stringify(modelSponsorFees(input), null, 2)}\n`);
  }
}

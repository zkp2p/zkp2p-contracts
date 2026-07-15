#!/usr/bin/env ts-node

import 'ts-node/register/transpile-only';
import { extractAddresses } from './extractors/addresses';
import { extractABIs } from './extractors/abis';
import { extractTypes } from './extractors/types';
import { extractConstants } from './extractors/constants';
import { extractUtils } from './extractors/utils';
import { extractPaymentMethods } from './extractors/paymentMethods';
import { extractCurrencies } from './extractors/currencies';
import { extractOracleFeeds } from './extractors/oracleFeeds';
import { execFileSync } from 'child_process';
import * as path from 'path';

async function generateTypeDeclarations() {
  try {
    const scriptPath = path.join(__dirname, 'generate-types.ts');
    const tsNodePath = require.resolve('ts-node/dist/bin.js');
    execFileSync(process.execPath, [tsNodePath, '--transpile-only', scriptPath], {
      stdio: 'inherit',
      cwd: path.join(__dirname, '..')
    });
  } catch (error) {
    console.error('⚠️  Type declaration generation failed:', error);
    // Non-fatal error - continue with extraction
  }
}

export async function extractAll(): Promise<void> {
  console.log('📦 Starting extraction from deployments/outputs...');

  const started = Date.now();
  await extractAddresses();
  await extractABIs();
  await extractTypes();
  await extractConstants();
  await extractUtils();
  await extractPaymentMethods();
  await extractCurrencies();
  await extractOracleFeeds();

  // Generate .d.ts files for all index.ts files
  await generateTypeDeclarations();

  const ms = Date.now() - started;
  console.log(`✅ Extraction complete in ${ms}ms`);
}

if (require.main === module) {
  extractAll().catch((err) => {
    console.error('❌ Extraction failed:', err);
    process.exit(1);
  });
}

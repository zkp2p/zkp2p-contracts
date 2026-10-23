const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const ts = require('typescript');

// Evaluate the actual config without registering Hardhat plugins or reading .env.
function config(env) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'hardhat.config.ts'), 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports = {};
  const requireStub = () => ({ config() {} });
  requireStub.extensions = {};
  vm.runInNewContext(output, { exports, require: requireStub, process: { env } });
  return exports.default;
}

test('Base staging never falls back to the production signer', () => {
  const production = '11'.repeat(32);
  const result = config({ BASE_DEPLOY_PRIVATE_KEY: production });
  assert.equal(result.networks.base_staging.accounts.length, 0);
  assert.equal(result.networks.base.accounts[0], `0x${production}`);
});

test('Base staging accepts only its scoped setting, with or without a prefix', () => {
  const staging = '22'.repeat(32);
  for (const key of [staging, `0x${staging}`]) {
    const result = config({ BASE_DEPLOY_PRIVATE_KEY: '11'.repeat(32), STAGING_DEPLOYER_KEY: key });
    assert.equal(result.networks.base_staging.accounts.length, 1);
    assert.equal(result.networks.base_staging.accounts[0], `0x${staging}`);
    assert.equal(result.networks.base.accounts[0], `0x${'11'.repeat(32)}`);
  }
});

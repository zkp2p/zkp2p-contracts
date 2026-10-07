// Run against a fresh local Anvil instance on port 8547 after yarn compile.
require('ts-node/register/transpile-only');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { ethers } = require('ethers');
const { prepareStakePolicyCutover } = require('./prepareStakePolicyCutover');

async function main() {
  const rpcUrl = 'http://127.0.0.1:8547';
  const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
  const signer = provider.getSigner(0);
  const owner = await signer.getAddress();
  const zero = ethers.constants.AddressZero;
  const id = ethers.utils.id;
  const day = 86400;
  async function deploy(path, name, args = []) {
    const artifact = JSON.parse(readFileSync(`artifacts/contracts/${path}.sol/${name}.json`, 'utf8'));
    const contract = await new ethers.ContractFactory(artifact.abi, artifact.bytecode, signer).deploy(...args);
    await contract.deployed();
    return contract;
  }
  const token = await deploy('mocks/USDCMock', 'USDCMock', [1000000000000, 'USDC', 'USDC']);
  const methods = await deploy('registries/PaymentVerifierRegistry', 'PaymentVerifierRegistry');
  const escrows = await deploy('registries/EscrowRegistry', 'EscrowRegistry');
  const origins = await deploy('registries/OrchestratorRegistry', 'OrchestratorRegistry');
  const relayers = await deploy('registries/RelayerRegistry', 'RelayerRegistry');
  const witnesses = await deploy('unifiedVerifier/MultiAttestationVerifier', 'MultiAttestationVerifier', [[owner], 1]);
  const legacyReplay = await deploy('registries/NullifierRegistry', 'NullifierRegistry');
  const replay = await deploy('registries/NullifierRegistryV2', 'NullifierRegistryV2', [legacyReplay.address]);
  const upv = await deploy('unifiedVerifier/UnifiedPaymentVerifierV3', 'UnifiedPaymentVerifierV3', [origins.address, replay.address, witnesses.address]);
  for (const rail of ['venmo', 'paypal']) {
    await (await upv.addPaymentMethod(id(rail))).wait();
    await (await methods.addPaymentMethod(id(rail), upv.address, [id('USD')])).wait();
  }
  const escrow = await deploy('EscrowV2', 'EscrowV2', [owner, 31337, origins.address, methods.address, owner, 0, 20, 3600]);
  const o3 = await deploy('OrchestratorV3', 'OrchestratorV3', [owner, 31337, escrows.address, methods.address, relayers.address, 0, owner]);
  await (await escrows.addEscrow(escrow.address)).wait();
  await (await origins.addOrchestrator(o3.address)).wait();
  const vault = await deploy('StakeVault', 'StakeVault', [owner, token.address, zero, 2 * day]);
  const disputes = await deploy('registries/NullifierRegistry', 'NullifierRegistry');
  const verifier = await deploy('unifiedVerifier/DisputeVerifier', 'DisputeVerifier', [owner, replay.address, witnesses.address]);
  const old = await deploy('legacy/DisputeProtectionPolicy', 'DisputeProtectionPolicy', [owner, vault.address, verifier.address, disputes.address]);
  const next = await deploy('hooks/DisputeProtectionPolicy', 'DisputeProtectionPolicyV2', [owner, vault.address, verifier.address, disputes.address, old.address]);
  const groups = await deploy('registries/AddressGroupRegistry', 'AddressGroupRegistry');
  const whitelist = await deploy('hooks/WhitelistPolicy', 'WhitelistPolicy', [groups.address, escrows.address, origins.address]);
  const oldHook = await deploy('hooks/IntentLifecycleHookV1', 'IntentLifecycleHookV1', [origins.address, whitelist.address, old.address]);
  const hook = await deploy('hooks/IntentLifecycleHookV2', 'IntentLifecycleHookV2', [origins.address, whitelist.address, next.address]);
  await (await vault.initializeController(old.address)).wait();
  await (await disputes.addWritePermission(old.address)).wait();
  await (await old.setLifecycleHookAuthorization(oldHook.address, true)).wait();
  await (await next.setLifecycleHookAuthorization(hook.address, true)).wait();
  await (await o3.setLifecycleHook(oldHook.address)).wait();
  await (await hook.initializePaymentVerifier(upv.address)).wait();
  for (const rail of ['venmo', 'paypal']) {
    await (await old.setRiskWindow(id(rail), 14 * day)).wait();
    await (await next.setRiskWindow(id(rail), 14 * day)).wait();
    await (await hook.setPolicy(id(`${rail}_personal`), id(rail), 0, 0, false)).wait();
    await (await hook.setPolicy(id(`${rail}_goods_and_services`), id(rail), 1, 90 * day, false)).wait();
  }
  await (await hook.setPolicy(id('venmo_balance'), id('venmo'), 1, 0, false)).wait();
  await (await token.approve(escrow.address, 500000000)).wait();
  await (await escrow.createDeposit({
    token: token.address, amount: 500000000, intentAmountRange: { min: 10000000, max: 200000000 },
    paymentMethods: [id('venmo')], paymentMethodData: [{ intentGatingService: zero, payeeDetails: id('payee'), data: '0x' }],
    currencies: [[{ code: id('USD'), minConversionRate: ethers.constants.WeiPerEther, oracleRateConfig: { adapter: zero, adapterConfig: '0x', spreadBps: 0, maxStaleness: 0 } }]],
    delegate: zero, intentGuardian: zero, retainOnEmpty: false,
  })).wait();
  await (await token.approve(vault.address, 100000000)).wait();
  await (await vault.depositStake(100000000)).wait();
  // Impersonate only the authorized callback to isolate preflight inventory from proof tests in Foundry.
  await provider.send('anvil_impersonateAccount', [oldHook.address]);
  await provider.send('anvil_setBalance', [oldHook.address, '0x1000000000000000000']);
  const callback = old.connect(provider.getSigner(oldHook.address));
  const hash = id('predecessor-settlement');
  await (await callback.onIntentSignaled(hash, escrow.address, 0, owner, id('venmo'), 50000000)).wait();
  await (await vault.proposeController(next.address)).wait();
  await (await old.setAdmissionsPaused(true)).wait();
  const config = {
    rpcUrl, chainId: 31337, governance: owner, predecessor: old.address, successor: next.address,
    predecessorDeploymentTransaction: old.deployTransaction.hash, successorDeploymentTransaction: next.deployTransaction.hash,
    vault: vault.address, disputeVerifier: verifier.address, disputeRegistry: disputes.address,
    upv: upv.address, witnessVerifier: witnesses.address, oldHook: oldHook.address, newHook: hook.address, orchestrator: o3.address,
  };
  await assert.rejects(prepareStakePolicyCutover(config), /delay has not elapsed/);
  await provider.send('evm_increaseTime', [2 * day]);
  await provider.send('evm_mine', []);
  await assert.rejects(prepareStakePolicyCutover(config), /Pending predecessor intent/);
  await (await callback.onIntentSettled(hash, 30000000, false)).wait();
  await (await old.setDisputeProtectionEnabled(escrow.address, 0, id('venmo'), false)).wait();
  await assert.rejects(prepareStakePolicyCutover(config), /Depositor must reapply opt-out/);
  await (await next.setDisputeProtectionEnabled(escrow.address, 0, id('venmo'), false)).wait();
  const plan = await prepareStakePolicyCutover(config);
  assert.equal(plan.inventory.length, 1);
  assert.equal(plan.inventory[0].lockAmount, '30000000');
  assert.equal(plan.optOuts.length, 1);
  assert.equal(plan.controllerChangeDelay, String(2 * day));
  for (const call of plan.calls) await (await signer.sendTransaction(call)).wait();
  assert.equal(await vault.controller(), next.address);
  assert.equal(await upv.attestationVerifier(), hook.address);
  assert.equal(await o3.lifecycleHook(), hook.address);
  assert.deepEqual(await disputes.getWriters(), [next.address]);
  assert.equal((await vault.locks(hash)).amount.toString(), '30000000');
  assert.equal((await next.getDisputeProtectionIntent(hash)).releaseEligibleAt.toString(), plan.inventory[0].lockMaturity);
  assert.equal(await next.isDisputeProtectionEnabled(escrow.address, 0, id('venmo')), false);
  await assert.rejects(prepareStakePolicyCutover(config), /current controller mismatch/);
  console.log('Cutover rehearsal passed: delay, pending drain, opt-outs, unchanged settled lock and exact unsigned call sequence.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

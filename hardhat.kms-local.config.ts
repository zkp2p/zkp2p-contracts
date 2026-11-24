import { appendFileSync } from "fs";
import { extendProvider } from "hardhat/config";
import config from "./hardhat.config";
import { FakeKms } from "./scripts/lib/fakeKms";
import { KmsDigestSigner } from "./utils/kmsSigner";
import { KmsSigningProvider } from "./utils/kmsSigningProvider";

// Local rehearsal of KMS deployer signing: `localhost` signs through the same KmsSigningProvider that `base` and
// `base_staging` use, backed by a fake KMS over a throwaway key that the node itself does not hold.
const fakeKey = process.env.KMS_LOCAL_FAKE_PRIVATE_KEY;
if (!fakeKey) throw new Error("hardhat.kms-local.config.ts needs KMS_LOCAL_FAKE_PRIVATE_KEY");
if (!config.networks) throw new Error("Canonical Hardhat networks are unavailable");
const signLog = process.env.KMS_LOCAL_SIGN_LOG;
const keyId = "alias/local-fake-deployer";

extendProvider(async (provider, _config, network) => {
  if (network !== "localhost") return provider;
  const kms = new FakeKms(fakeKey, {
    keyId, highS: true, onSign: (request) => { if (signLog) appendFileSync(signLog, `${keyId} ${request.messageType}\n`); },
  });
  const signer = await KmsDigestSigner.create(kms, keyId, kms.address);
  // The throwaway key starts empty; fund it on the local node only.
  await provider.request({ method: "hardhat_setBalance", params: [signer.address, "0x56bc75e2d63100000"] });
  return new KmsSigningProvider(provider, signer);
});

export default {
  ...config,
  networks: {
    ...config.networks,
    localhost: { ...config.networks.localhost, url: process.env.KMS_LOCAL_RPC_URL ?? "http://127.0.0.1:8545" },
  },
};

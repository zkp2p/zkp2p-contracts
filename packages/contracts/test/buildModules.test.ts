import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { buildModules, resolveEsmSpecifier } from "../scripts/build-modules";
import { renderPaymentMethodsIndex } from "../scripts/extractors/paymentMethods";

function write(root: string, relativePath: string, content: string): void {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function walk(root: string, relativePath = ""): string[] {
  const directory = path.join(root, relativePath);
  if (!fs.existsSync(directory)) return [];

  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(relativePath, entry.name);
    return entry.isDirectory() ? walk(root, entryPath) : [entryPath];
  });
}

function runtimeSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const pattern = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  return specifiers;
}

describe("native module generation", () => {
  let packageRoot: string;
  const manifest = { name: "fixture-contracts", version: "9.8.7" };

  beforeEach(() => {
    packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "contracts-build-modules-"));
    write(packageRoot, "package.json", JSON.stringify(manifest));
    write(packageRoot, "addresses/base.json", JSON.stringify({ Escrow: "0x1234" }));
    write(packageRoot, "addresses/index.ts", "export { default as base } from './base.json';\n");
    write(packageRoot, "abis/base/Escrow.json", JSON.stringify({ abi: [] }));
    write(packageRoot, "abis/base/index.ts", "export { default as Escrow } from './Escrow.json';\n");
    write(packageRoot, "abis/index.ts", "export * as base from './base';\nexport type { Fixture } from './types';\n");
    write(packageRoot, "abis/types.d.ts", "export interface Fixture { readonly value: string; }\n");
    write(packageRoot, "abis/base.cjs", "module.exports = {};\n");
    write(packageRoot, "abis/base.mjs", "export default {};\n");
    write(packageRoot, "paymentMethods/base.json", JSON.stringify({ methods: {} }));
    write(packageRoot, "paymentMethods/baseStaging.json", JSON.stringify({ methods: {} }));
    write(packageRoot, "paymentMethods/lookups.json", JSON.stringify({ nameToHash: {}, hashToName: {} }));
    write(packageRoot, "paymentMethods/types.d.ts", "export interface PaymentMethodConfig {}\nexport interface NetworkPaymentMethods { methods: Record<string, PaymentMethodConfig>; }\n");
    write(packageRoot, "paymentMethods/index.ts", renderPaymentMethodsIndex(["base", "baseStaging"]));
    write(packageRoot, "disputeReadiness/base.json", JSON.stringify({ network: "base" }));
    write(packageRoot, "disputeReadiness/types.d.ts", "export interface DisputeProtectionReadinessManifest { network: string; }\n");
    write(
      packageRoot,
      "disputeReadiness/index.ts",
      "import baseData from './base.json';\nexport type { DisputeProtectionReadinessManifest } from './types';\nexport const base = baseData;\n",
    );
    write(packageRoot, "utils/protocolUtils.ts", "export const protocolValue = 1;\n");
    write(packageRoot, "utils/sideEffect.ts", "export const sideEffectValue = 1;\n");
    write(
      packageRoot,
      "utils/index.ts",
      "import './sideEffect';\nimport { type MissingImport } from './missing-import';\nexport { type MissingExport } from './missing-export';\nexport * from './protocolUtils';\nexport const loadProtocol = () => import('./protocolUtils');\nexport const loadProtocolWithOptions = () => import('./protocolUtils', {});\n",
    );
    write(packageRoot, "types/index.ts", "export interface TypesOnly { value: string; }\n");
  });

  afterEach(() => {
    fs.rmSync(packageRoot, { recursive: true, force: true });
  });

  it("resolves runtime ESM specifiers from the importing source", () => {
    const addressesIndex = path.join(packageRoot, "addresses/index.ts");
    const utilsIndex = path.join(packageRoot, "utils/index.ts");
    const abisIndex = path.join(packageRoot, "abis/index.ts");

    expect(resolveEsmSpecifier("./base.json", addressesIndex)).toBe("./base.js");
    expect(resolveEsmSpecifier("./protocolUtils", utilsIndex)).toBe("./protocolUtils.js");
    expect(resolveEsmSpecifier("./base", abisIndex)).toBe("./base/index.js");
    expect(resolveEsmSpecifier("abitype", abisIndex)).toBe("abitype");
    expect(resolveEsmSpecifier("./already.js", abisIndex)).toBe("./already.js");
    expect(resolveEsmSpecifier("./already.mjs", abisIndex)).toBe("./already.mjs");
    expect(() => resolveEsmSpecifier("./missing", abisIndex)).toThrow(/unresolved relative runtime specifier/);
  });

  it("renders payment methods with static imports and an in-memory map", () => {
    const source = renderPaymentMethodsIndex(["base", "baseStaging"]);

    expect(source).toContain("import baseData from './base.json';");
    expect(source).toContain("import baseStagingData from './baseStaging.json';");
    expect(source).toContain("base: baseData,");
    expect(source).toContain("baseStaging: baseStagingData,");
    expect(source).toContain("paymentMethodsByNetwork[network]?.methods?.[paymentMethod]");
    expect(source).not.toContain("require(");
  });

  it("deterministically keeps TypeScript output when a JSON companion would collide", async () => {
    write(packageRoot, "addresses/index.json", JSON.stringify({ networks: ["base"] }));
    const warning = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await buildModules(packageRoot);

      const esmIndex = fs.readFileSync(path.join(packageRoot, "_esm/addresses/index.js"), "utf8");
      const cjsIndex = fs.readFileSync(path.join(packageRoot, "_cjs/addresses/index.js"), "utf8");
      expect(esmIndex).toMatch(/export \{ default as base \} from ["']\.\/base\.js["'];/);
      expect(cjsIndex).toContain("exports.base");
      expect(fs.existsSync(path.join(packageRoot, "_esm/addresses/index.json"))).toBe(true);
      expect(warning.mock.calls.flat().join("\n")).toMatch(
        /addresses\/index\.json.*addresses\/index\.ts.*_esm\/addresses\/index\.js/s,
      );
    } finally {
      warning.mockRestore();
    }
  });

  it("builds a hermetic dual-module tree with resolvable native ESM", async () => {
    await buildModules(packageRoot);

    const read = (relativePath: string) => fs.readFileSync(path.join(packageRoot, relativePath), "utf8");
    const esmFiles = walk(packageRoot, "_esm");
    const cjsFiles = walk(packageRoot, "_cjs");

    expect(read("_esm/package.json")).toBe(`${JSON.stringify({ type: "module" }, null, 2)}\n`);
    expect(read("_esm/index.js")).toContain(`export const version = ${JSON.stringify(manifest.version)};`);
    expect(read("_esm/index.js")).not.toContain("require(");
    expect(read("_cjs/index.js")).toContain(`exports.version = ${JSON.stringify(manifest.version)};`);
    expect(read("_esm/disputeReadiness/index.js")).toMatch(/from ["']\.\/base\.js["']/);
    expect(read("_cjs/disputeReadiness/index.js")).toContain("exports.base");
    expect(read("_types/disputeReadiness/types.d.ts")).toContain("DisputeProtectionReadinessManifest");

    for (const relativePath of esmFiles.filter((file) => file.endsWith(".js"))) {
      const source = read(relativePath);
      expect(source).not.toMatch(/\brequire\s*\(/);
      expect(source).not.toMatch(/(?:from|import\s*\()\s*["'][^"']+\.json["']/);

      for (const specifier of runtimeSpecifiers(source).filter((value) => value.startsWith("."))) {
        expect(fs.existsSync(path.resolve(path.dirname(path.join(packageRoot, relativePath)), specifier))).toBe(true);
      }
    }

    expect(esmFiles).not.toContainEqual(expect.stringMatching(/\.(?:cjs|mjs)$/));
    expect(cjsFiles).not.toContainEqual(expect.stringMatching(/\.(?:cjs|mjs)$/));
    expect(esmFiles).not.toContainEqual(expect.stringMatching(/^_esm\/types(?:\/|$)/));
    expect(cjsFiles).not.toContainEqual(expect.stringMatching(/^_cjs\/types(?:\/|$)/));
  });
});

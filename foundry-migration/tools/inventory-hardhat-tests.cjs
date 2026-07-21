#!/usr/bin/env node

process.env.TS_NODE_TRANSPILE_ONLY = "1";

const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const Mocha = require("mocha");
const ts = require("typescript");

require("ts-node/register/transpile-only");
require("hardhat/register");
require("module-alias/register");

const repositoryRoot = path.resolve(__dirname, "../..");
const testRoot = path.join(repositoryRoot, "test");
const outputDirectory = path.join(repositoryRoot, "foundry-migration/baseline");

function walk(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const target = path.join(directory, entry.name);
        return entry.isDirectory() ? walk(target) : [target];
    });
}

function relative(file) {
    return path.relative(repositoryRoot, file).split(path.sep).join("/");
}

function csv(value) {
    const stringValue = String(value ?? "");
    return /[",\n]/.test(stringValue) ? `"${stringValue.replaceAll('"', '""')}"` : stringValue;
}

function location(sourceFile, node) {
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    return { line: position.line + 1, column: position.character + 1 };
}

function staticInventory(file) {
    const text = fs.readFileSync(file, "utf8");
    const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const imports = [];
    const callables = [];

    function visit(node, parents = []) {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
            const names = [];
            const clause = node.importClause;
            if (clause?.name) names.push(clause.name.text);
            if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
                names.push(...clause.namedBindings.elements.map((element) => element.name.text));
            } else if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
                names.push(`* as ${clause.namedBindings.name.text}`);
            }
            imports.push({ module: node.moduleSpecifier.text, names, ...location(sourceFile, node) });
        }

        let callable;
        if (ts.isFunctionDeclaration(node) && node.name) {
            callable = { name: node.name.text, kind: "function" };
        } else if (
            ts.isVariableDeclaration(node)
            && ts.isIdentifier(node.name)
            && node.initializer
            && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
        ) {
            callable = { name: node.name.text, kind: "function-variable" };
        }
        if (callable) {
            callables.push({
                ...callable,
                nesting: parents.join(" > "),
                ...location(sourceFile, node),
            });
        }

        let nextParents = parents;
        if (ts.isFunctionDeclaration(node) && node.name) nextParents = [...parents, node.name.text];
        ts.forEachChild(node, (child) => visit(child, nextParents));
    }
    visit(sourceFile);
    return { imports, callables };
}

function pending(test) {
    let current = test;
    while (current) {
        if (current.pending || current.isPending?.()) return true;
        current = current.parent;
    }
    return false;
}

function expectedBehavior(title) {
    const lower = title.toLowerCase();
    if (/revert|reject|unauthori|invalid|fail|cannot|blocked|prevent/.test(lower)) return "revert/error";
    if (/emit|event/.test(lower)) return "event";
    if (/balance|transfer|fund|fee|amount|liquidity|solven/.test(lower)) return "balance/accounting";
    if (/return|getter|view|read/.test(lower)) return "return value";
    if (/update|set |sets |delete|remove|add |adds |create|close|prune|store|clear|record|lock|unlock/.test(lower)) return "state transition";
    if (/succeed|allow|not revert|execute|deploy|wire|configure/.test(lower)) return "success";
    return "asserted behavior";
}

async function main() {
    const sourceCommit = execFileSync("git", ["rev-parse", "origin/main"], {
        cwd: repositoryRoot,
        encoding: "utf8",
    }).trim();
    const files = walk(testRoot).filter((file) => file.endsWith(".spec.ts")).sort();
    const staticByFile = new Map(files.map((file) => [relative(file), staticInventory(file)]));
    const mocha = new Mocha({ timeout: 1, dryRun: true });
    files.forEach((file) => mocha.addFile(file));
    await mocha.loadFilesAsync();

    const suites = [];
    const hooks = [];
    const tests = [];
    const duplicateKeys = new Map();

    function visitSuite(suite, parentTitles = []) {
        const titles = suite.title ? [...parentTitles, suite.title] : parentTitles;
        const suiteFile = suite.file ? relative(suite.file) : "";
        if (suite.title) {
            suites.push({ file: suiteFile, path: titles.join(" > "), pending: Boolean(suite.pending) });
        }

        for (const [kind, collection] of [
            ["beforeAll", suite._beforeAll],
            ["beforeEach", suite._beforeEach],
            ["afterEach", suite._afterEach],
            ["afterAll", suite._afterAll],
        ]) {
            for (const hook of collection ?? []) {
                hooks.push({
                    file: hook.file ? relative(hook.file) : suiteFile,
                    suitePath: titles.join(" > "),
                    kind,
                    title: hook.title,
                });
            }
        }

        for (const test of suite.tests) {
            const file = test.file ? relative(test.file) : suiteFile;
            const suitePath = titles.join(" > ");
            const key = `${file}\0${suitePath}\0${test.title}`;
            const occurrence = (duplicateKeys.get(key) ?? 0) + 1;
            duplicateKeys.set(key, occurrence);
            const idHash = crypto.createHash("sha256").update(`${key}\0${occurrence}`).digest("hex").slice(0, 12).toUpperCase();
            const inheritedHooks = hooks
                .filter((hook) => hook.file === file && suitePath.startsWith(hook.suitePath))
                .map((hook) => `${hook.kind}:${hook.suitePath}`);
            const helperImports = (staticByFile.get(file)?.imports ?? [])
                .filter((entry) => entry.module.startsWith("@utils/") || entry.module.startsWith("../../utils/") || entry.module.includes("network-helpers"))
                .map((entry) => `${entry.module}[${entry.names.join("|")}]`);
            tests.push({
                id: `HH-${idHash}`,
                sourceFile: file,
                suitePath,
                hardhatTest: test.title,
                scenario: test.fullTitle(),
                expectedBehavior: expectedBehavior(test.fullTitle()),
                fixtureDependencies: [...new Set([...inheritedHooks, ...helperImports])].join("; "),
                pending: pending(test),
            });
        }
        suite.suites.forEach((child) => visitSuite(child, titles));
    }
    visitSuite(mocha.suite);

    const fileInventory = files.map((file) => {
        const sourceFile = relative(file);
        const staticData = staticByFile.get(sourceFile);
        return {
            file: sourceFile,
            sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
            group: sourceFile.startsWith("test/deploy/") ? "deployment" : sourceFile.startsWith("test/patchCoverage/") ? "patch-coverage" : "canonical",
            tests: tests.filter((test) => test.sourceFile === sourceFile).length,
            pending: tests.filter((test) => test.sourceFile === sourceFile && test.pending).length,
            suites: suites.filter((suite) => suite.file === sourceFile).length,
            hooks: hooks.filter((hook) => hook.file === sourceFile),
            imports: staticData.imports,
            localCallables: staticData.callables,
        };
    });

    const inventory = {
        schemaVersion: 1,
        sourceCommit,
        totals: {
            files: fileInventory.length,
            suites: suites.length,
            tests: tests.length,
            executableTests: tests.filter((test) => !test.pending).length,
            pendingTests: tests.filter((test) => test.pending).length,
            hooks: hooks.length,
            importedDependencies: fileInventory.reduce((total, file) => total + file.imports.length, 0),
            localCallables: fileInventory.reduce((total, file) => total + file.localCallables.length, 0),
        },
        groupTotals: Object.fromEntries(["canonical", "patch-coverage", "deployment"].map((group) => {
            const groupFiles = new Set(fileInventory.filter((file) => file.group === group).map((file) => file.file));
            const groupTests = tests.filter((test) => groupFiles.has(test.sourceFile));
            return [group, {
                files: groupFiles.size,
                tests: groupTests.length,
                executableTests: groupTests.filter((test) => !test.pending).length,
                pendingTests: groupTests.filter((test) => test.pending).length,
            }];
        })),
        files: fileInventory,
        suites,
        hooks,
        tests,
    };

    const manifestHeader = [
        "id", "source_file", "suite_path", "hardhat_test", "scenario", "expected_behavior",
        "fixture_dependencies", "foundry_destination", "translation_shape", "status", "evidence",
    ];
    const manifestRows = tests.map((test) => [
        test.id,
        test.sourceFile,
        test.suitePath,
        test.hardhatTest,
        test.scenario,
        test.expectedBehavior,
        test.fixtureDependencies,
        "",
        "one-to-one",
        test.pending ? "pending-resolution" : "pending-translation",
        test.pending ? "baseline-pending" : "baseline-passed",
    ]);

    fs.mkdirSync(outputDirectory, { recursive: true });
    fs.writeFileSync(path.join(outputDirectory, "hardhat-inventory.json"), `${JSON.stringify(inventory, null, 2)}\n`);
    fs.writeFileSync(
        path.join(repositoryRoot, "foundry-migration/hardhat-to-foundry-manifest.csv"),
        `${[manifestHeader, ...manifestRows].map((row) => row.map(csv).join(",")).join("\n")}\n`,
    );
    console.log(JSON.stringify({ totals: inventory.totals, groupTotals: inventory.groupTotals }, null, 2));
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

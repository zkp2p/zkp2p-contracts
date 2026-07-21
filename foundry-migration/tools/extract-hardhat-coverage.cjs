#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { createCoverageMap } = require("istanbul-lib-coverage");

const repositoryRoot = path.resolve(__dirname, "../..");
const inputPath = path.join(repositoryRoot, "coverage/coverage-final.json");
const lcovPath = path.join(repositoryRoot, "coverage/lcov.info");
const outputDirectory = path.join(repositoryRoot, "foundry-migration/baseline");
const rawCoverage = fs.readFileSync(inputPath);
const rawLcov = fs.readFileSync(lcovPath);
const coverageMap = createCoverageMap(JSON.parse(rawCoverage));

function metric(summary, name) {
    const value = summary[name];
    return {
        covered: value.covered,
        total: value.total,
        pct: value.pct,
    };
}

function normalizedSummary(summary) {
    return {
        statements: metric(summary, "statements"),
        branches: metric(summary, "branches"),
        functions: metric(summary, "functions"),
        lines: metric(summary, "lines"),
    };
}

function percent(covered, total) {
    return total === 0 ? 100 : Number(((covered / total) * 100).toFixed(2));
}

const lcovByFile = new Map();
for (const record of rawLcov.toString("utf8").split("end_of_record")) {
    const fields = new Map();
    for (const line of record.trim().split("\n")) {
        const separator = line.indexOf(":");
        if (separator !== -1) fields.set(line.slice(0, separator), line.slice(separator + 1));
    }
    if (!fields.has("SF")) continue;
    const file = path.relative(repositoryRoot, fields.get("SF"));
    lcovByFile.set(file, {
        branches: {
            covered: Number(fields.get("BRH")),
            total: Number(fields.get("BRF")),
        },
        functions: {
            covered: Number(fields.get("FNH")),
            total: Number(fields.get("FNF")),
        },
        lines: {
            covered: Number(fields.get("LH")),
            total: Number(fields.get("LF")),
        },
    });
}

const files = coverageMap.files().sort().map((file) => {
    const lcov = lcovByFile.get(file);
    if (!lcov) throw new Error(`Missing LCOV record for ${file}`);
    const statements = metric(coverageMap.fileCoverageFor(file).toSummary(), "statements");
    return {
        file,
        statements: { ...statements, pct: percent(statements.covered, statements.total) },
        branches: { ...lcov.branches, pct: percent(lcov.branches.covered, lcov.branches.total) },
        functions: { ...lcov.functions, pct: percent(lcov.functions.covered, lcov.functions.total) },
        lines: { ...lcov.lines, pct: percent(lcov.lines.covered, lcov.lines.total) },
    };
});

const overall = Object.fromEntries(
    ["statements", "branches", "functions", "lines"].map((name) => {
        const covered = files.reduce((sum, file) => sum + file[name].covered, 0);
        const total = files.reduce((sum, file) => sum + file[name].total, 0);
        return [name, { covered, total, pct: percent(covered, total) }];
    }),
);

const baseline = {
    schemaVersion: 1,
    source: "solidity-coverage 0.8.17",
    sourceCommit: "659fb603907339e920af07a1355c6473ddcdb223",
    command: "PATH=/opt/homebrew/opt/node@20/bin:$PATH /usr/bin/time -p node .yarn/releases/yarn-4.9.1.cjs coverage",
    testResult: {
        passing: 1333,
        pending: 5,
        failing: 0,
        exitCode: 0,
        runtimeSeconds: 870.61,
    },
    inputs: {
        coverageFinalSha256: crypto.createHash("sha256").update(rawCoverage).digest("hex"),
        lcovSha256: crypto.createHash("sha256").update(rawLcov).digest("hex"),
    },
    overall,
    files,
};

const metrics = ["statements", "branches", "functions", "lines"];
const csvHeader = [
    "file",
    ...metrics.flatMap((name) => [`${name}_covered`, `${name}_total`, `${name}_pct`]),
];
const csvRows = files.map((file) => [
    file.file,
    ...metrics.flatMap((name) => [file[name].covered, file[name].total, file[name].pct]),
]);

fs.mkdirSync(outputDirectory, { recursive: true });
fs.writeFileSync(
    path.join(outputDirectory, "hardhat-coverage-summary.json"),
    `${JSON.stringify(baseline, null, 2)}\n`,
);
fs.writeFileSync(
    path.join(outputDirectory, "hardhat-coverage-by-file.csv"),
    `${[csvHeader, ...csvRows].map((row) => row.join(",")).join("\n")}\n`,
);

console.log(JSON.stringify(baseline.overall, null, 2));

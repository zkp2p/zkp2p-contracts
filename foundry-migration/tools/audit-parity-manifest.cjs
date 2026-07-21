#!/usr/bin/env node

const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const repositoryRoot = path.resolve(__dirname, "../..");
const inventoryPath = path.join(repositoryRoot, "foundry-migration/baseline/hardhat-inventory.json");
const manifestPath = path.join(repositoryRoot, "foundry-migration/hardhat-to-foundry-manifest.csv");

function fail(message) {
    throw new Error(message);
}

function parseCsv(input) {
    const rows = [];
    let row = [];
    let field = "";
    let quoted = false;
    for (let index = 0; index < input.length; ++index) {
        const character = input[index];
        if (quoted) {
            if (character === '"' && input[index + 1] === '"') {
                field += '"';
                ++index;
            } else if (character === '"') {
                quoted = false;
            } else {
                field += character;
            }
        } else if (character === '"') {
            quoted = true;
        } else if (character === ",") {
            row.push(field);
            field = "";
        } else if (character === "\n") {
            row.push(field.replace(/\r$/, ""));
            rows.push(row);
            row = [];
            field = "";
        } else {
            field += character;
        }
    }
    if (quoted) fail("Manifest ends inside a quoted field");
    if (field.length || row.length) {
        row.push(field.replace(/\r$/, ""));
        rows.push(row);
    }
    const [header, ...values] = rows;
    return values.map((cells, rowIndex) => {
        if (cells.length !== header.length) {
            fail(`Manifest row ${rowIndex + 2} has ${cells.length} columns; expected ${header.length}`);
        }
        return Object.fromEntries(header.map((name, columnIndex) => [name, cells[columnIndex]]));
    });
}

function sha256(file) {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

const inventory = JSON.parse(fs.readFileSync(inventoryPath, "utf8"));
const manifest = parseCsv(fs.readFileSync(manifestPath, "utf8"));

if (manifest.length !== inventory.tests.length) {
    fail(`Manifest/inventory row mismatch: ${manifest.length} / ${inventory.tests.length}`);
}

const inventoryIds = new Set();
const destinations = new Map();
for (let index = 0; index < inventory.tests.length; ++index) {
    const source = inventory.tests[index];
    const row = manifest[index];
    if (inventoryIds.has(source.id)) fail(`Duplicate inventory ID: ${source.id}`);
    inventoryIds.add(source.id);
    const exactFields = [
        ["id", source.id],
        ["source_file", source.sourceFile],
        ["suite_path", source.suitePath],
        ["hardhat_test", source.hardhatTest],
        ["scenario", source.scenario],
        ["expected_behavior", source.expectedBehavior],
        ["fixture_dependencies", source.fixtureDependencies],
    ];
    for (const [field, expected] of exactFields) {
        if (row[field] !== expected) fail(`Row ${index + 2} ${field} drift for ${source.id}`);
    }
    if (!row.foundry_destination) fail(`Unmapped behavior: ${source.id} ${source.scenario}`);
    if (row.status !== "verified-independent-file") fail(`Unverified behavior: ${source.id} (${row.status})`);
    if (!row.evidence) fail(`Missing evidence: ${source.id}`);
    const mappedRows = destinations.get(row.foundry_destination) || [];
    mappedRows.push(source.id);
    destinations.set(row.foundry_destination, mappedRows);
}

for (const file of inventory.files) {
    const sourcePath = path.join(repositoryRoot, file.file);
    if (!fs.existsSync(sourcePath)) fail(`Inventoried Hardhat source is missing: ${file.file}`);
    const actualHash = sha256(sourcePath);
    if (actualHash !== file.sha256) fail(`Hardhat source changed after inventory: ${file.file}`);
}

const forgeList = JSON.parse(execFileSync("forge", ["test", "--list", "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
}));
const liveFoundryTests = new Set();
for (const [file, contracts] of Object.entries(forgeList)) {
    for (const [contractName, tests] of Object.entries(contracts)) {
        for (const testName of tests) liveFoundryTests.add(`${file}:${contractName}::${testName}`);
    }
}

for (const destination of destinations.keys()) {
    if (!liveFoundryTests.has(destination)) fail(`Manifest destination is not a live Foundry test: ${destination}`);
}
const orphanFoundryTests = [...liveFoundryTests].filter((test) => !destinations.has(test));

const consolidatedDestinations = [...destinations.values()].filter((rows) => rows.length > 1);
const inventoryById = new Map(inventory.tests.map((test) => [test.id, test]));
const consolidationsBySourceFile = {};
for (const rows of consolidatedDestinations) {
    const sourceFiles = new Set(rows.map((id) => inventoryById.get(id).sourceFile));
    const sourceFile = [...sourceFiles].sort().join(" + ");
    const current = consolidationsBySourceFile[sourceFile] || { destinations: 0, sourceRows: 0, netReduction: 0 };
    ++current.destinations;
    current.sourceRows += rows.length;
    current.netReduction += rows.length - 1;
    consolidationsBySourceFile[sourceFile] = current;
}
const summary = {
    sourceFiles: inventory.files.length,
    sourceHashesVerified: inventory.files.length,
    inventoryRows: inventory.tests.length,
    manifestRows: manifest.length,
    mappedRows: [...destinations.values()].reduce((total, rows) => total + rows.length, 0),
    baselinePendingRowsResolved: inventory.tests.filter((test) => test.pending).length,
    uniqueFoundryDestinations: destinations.size,
    liveFoundryTests: liveFoundryTests.size,
    consolidationCount: consolidatedDestinations.length,
    consolidatedSourceRows: consolidatedDestinations.reduce((total, rows) => total + rows.length, 0),
    consolidationNetReduction: inventory.tests.length - destinations.size,
    consolidationsBySourceFile,
    splitSourceRows: 0,
    unmappedSourceRows: 0,
    missingFoundryDestinations: 0,
    additionalFoundryTests: orphanFoundryTests.length,
    additionalFoundryTestDestinations: orphanFoundryTests,
};
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

require("ts-node/register/transpile-only");

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { ethers } = require("ethers");

const {
  BASE_SAFE,
  MULTI_SEND_CALL_ONLY,
  encodeMultiSendCalldata,
} = require("./simulate-dispute-opt-in-safe-batch.ts");
const {
  SAFE_TX_TYPES,
  loadTransactionBuilderFile,
  planSafeBatchChunks,
  runProposeSafeBatchChunks,
  selectStartNonce,
} = require("./proposeSafeBatchChunks.ts");

const PROPOSER_PRIVATE_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const proposer = new ethers.Wallet(PROPOSER_PRIVATE_KEY);
const targetA = "0x1000000000000000000000000000000000000001";
const targetB = "0x2000000000000000000000000000000000000002";
const targetC = "0x3000000000000000000000000000000000000003";
const safeInterface = new ethers.utils.Interface([
  "function VERSION() view returns (string)",
  "function nonce() view returns (uint256)",
]);
const multiSendInterface = new ethers.utils.Interface([
  "function multiSend(bytes transactions)",
]);

function builder(transactions) {
  return {
    version: "1.0",
    chainId: "8453",
    createdAt: 1,
    meta: {
      name: "test bootstrap",
      createdFromSafeAddress: BASE_SAFE,
    },
    transactions,
  };
}

function call(to, data) {
  return { to, value: "0", data, operation: 0 };
}

function writeBuilder(value) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "safe-chunks-"));
  const file = path.join(directory, "batch.json");
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
  return { directory, file };
}

function decodePackedTransactions(data) {
  const [packed] = multiSendInterface.decodeFunctionData("multiSend", data);
  const bytes = ethers.utils.arrayify(packed);
  const decoded = [];
  let offset = 0;
  while (offset < bytes.length) {
    const operation = bytes[offset];
    const to = ethers.utils.getAddress(
      ethers.utils.hexlify(bytes.slice(offset + 1, offset + 21))
    );
    const value = ethers.BigNumber.from(
      bytes.slice(offset + 21, offset + 53)
    ).toString();
    const length = ethers.BigNumber.from(
      bytes.slice(offset + 53, offset + 85)
    ).toNumber();
    const innerData = ethers.utils.hexlify(
      bytes.slice(offset + 85, offset + 85 + length)
    );
    decoded.push({ operation, to, value, data: innerData });
    offset += 85 + length;
  }
  return decoded;
}

function jsonResponse(status, value) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(value);
    },
  };
}

function fakeProvider(gasPerCall = 10, onChainNonce = 7) {
  return {
    async getCode(address) {
      assert.equal(address.toLowerCase(), MULTI_SEND_CALL_ONLY.toLowerCase());
      return "0x01";
    },
    async call(transaction) {
      assert.equal(transaction.to.toLowerCase(), BASE_SAFE.toLowerCase());
      if (transaction.data === safeInterface.getSighash("VERSION")) {
        return safeInterface.encodeFunctionResult("VERSION", ["1.3.0"]);
      }
      if (transaction.data === safeInterface.getSighash("nonce")) {
        return safeInterface.encodeFunctionResult("nonce", [onChainNonce]);
      }
      throw new Error(`Unexpected provider call ${transaction.data}`);
    },
    async estimateGas(transaction) {
      assert.equal(transaction.from.toLowerCase(), BASE_SAFE.toLowerCase());
      assert.equal(
        transaction.to.toLowerCase(),
        MULTI_SEND_CALL_ONLY.toLowerCase()
      );
      return ethers.BigNumber.from(
        decodePackedTransactions(transaction.data).length * gasPerCall
      );
    },
  };
}

function serviceFetch({
  queued = [],
  posts = [],
  postStatus = 201,
  postBody,
} = {}) {
  return async (url, init = {}) => {
    if (init.method === "POST") {
      posts.push(JSON.parse(init.body));
      return jsonResponse(
        postStatus,
        postBody || { safeTxHash: posts.at(-1).contractTransactionHash }
      );
    }
    if (url.includes("/multisig-transactions/")) {
      return jsonResponse(200, { results: queued, next: null });
    }
    if (url.includes("/api/v1/safes/")) {
      return jsonResponse(200, { nonce: 7, owners: [], threshold: 2 });
    }
    if (url.includes("/api/v2/delegates/")) {
      return jsonResponse(200, {
        results: [{ delegate: proposer.address }],
        next: null,
      });
    }
    throw new Error(`Unexpected URL ${url}`);
  };
}

test("Transaction Builder validation refuses malformed or unsafe calls", async (t) => {
  const valid = builder([call(targetA, "0x12345678")]);
  const cases = [
    ["wrong chain", { ...valid, chainId: "84532" }, /chainId 8453/],
    [
      "wrong Safe",
      { ...valid, meta: { createdFromSafeAddress: targetA } },
      /Base Safe/,
    ],
    [
      "missing target",
      builder([{ value: "0", data: "0x", operation: 0 }]),
      /target/,
    ],
    [
      "nonzero value",
      builder([{ ...call(targetA, "0x"), value: "1" }]),
      /value 0/,
    ],
    [
      "invalid data",
      builder([{ ...call(targetA, "0x"), data: "xyz" }]),
      /calldata/,
    ],
    [
      "delegatecall",
      builder([{ ...call(targetA, "0x"), operation: 1 }]),
      /operation 0/,
    ],
  ];

  for (const [name, value, pattern] of cases) {
    await t.test(name, () => {
      const { directory, file } = writeBuilder(value);
      try {
        assert.throws(() => loadTransactionBuilderFile(file), pattern);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});

test("Transaction Builder CALLs may omit the default operation field", () => {
  const { directory, file } = writeBuilder(
    builder([{ to: targetA, value: "0", data: "0x12345678" }])
  );
  try {
    assert.equal(loadTransactionBuilderFile(file).transactions[0].operation, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("greedy chunking respects gas and call caps while preserving order", async () => {
  const transactions = [
    call(targetA, "0xaaaaaaaa"),
    call(targetB, "0xbbbbbbbb"),
    call(targetC, "0xcccccccc"),
  ];
  const chunks = await planSafeBatchChunks(transactions, fakeProvider(10), {
    maxGas: ethers.BigNumber.from(25),
    chunkCalls: 2,
    startNonce: 11,
  });

  assert.deepEqual(
    chunks.map(({ calls }) => calls.length),
    [2, 1]
  );
  assert.deepEqual(
    chunks.map(({ estimatedGas }) => estimatedGas),
    ["20", "10"]
  );
  assert.deepEqual(
    chunks.map(({ safeTx }) => safeTx.nonce),
    [11, 12]
  );
  assert.deepEqual(
    chunks.flatMap(({ safeTx }) =>
      decodePackedTransactions(safeTx.data).map(({ data }) => data)
    ),
    transactions.map(({ data }) => data)
  );
});

test("a reverted candidate chunk is fatal", async () => {
  const provider = fakeProvider();
  const originalEstimateGas = provider.estimateGas;
  provider.estimateGas = async (transaction) => {
    if (decodePackedTransactions(transaction.data).length > 1) {
      throw new Error("combined simulation failed");
    }
    return originalEstimateGas(transaction);
  };
  await assert.rejects(
    planSafeBatchChunks(
      [call(targetA, "0xaaaaaaaa"), call(targetB, "0xbbbbbbbb")],
      provider,
      {
        maxGas: ethers.BigNumber.from(100),
        startNonce: 4,
      }
    ),
    /MultiSend simulation reverted: combined simulation failed/
  );
});

test("chunks use DELEGATECALL and preserve the canonical MultiSend encoding", async () => {
  const transactions = [
    call(targetA, "0x12345678"),
    call(targetB, "0x90abcdef"),
  ];
  const [chunk] = await planSafeBatchChunks(transactions, fakeProvider(), {
    maxGas: ethers.BigNumber.from(100),
    startNonce: 4,
  });

  assert.equal(chunk.safeTx.operation, 1);
  assert.equal(chunk.safeTx.to, MULTI_SEND_CALL_ONLY);
  assert.equal(chunk.safeTx.data, encodeMultiSendCalldata(transactions));
  assert.deepEqual(
    decodePackedTransactions(chunk.safeTx.data).map(
      ({ operation, to, value, data }) => ({
        operation,
        to: to.toLowerCase(),
        value,
        data,
      })
    ),
    transactions.map((transaction) => ({
      ...transaction,
      to: transaction.to.toLowerCase(),
    }))
  );
});

test("nonce selection ignores stale queued proposals", () => {
  assert.equal(
    selectStartNonce(7, [
      { nonce: 2 },
      { nonce: 6 },
      { nonce: 7 },
      { nonce: 10 },
    ]),
    11
  );
  assert.equal(selectStartNonce(7, [{ nonce: 6 }]), 7);
  assert.equal(selectStartNonce(7, [{ nonce: 99 }], 12), 12);
});

test("dry-run writes the plan and never posts", async () => {
  const posts = [];
  const { directory, file } = writeBuilder(
    builder([call(targetA, "0xaaaaaaaa"), call(targetB, "0xbbbbbbbb")])
  );
  try {
    const result = await runProposeSafeBatchChunks(
      { file, maxGas: "100", propose: false },
      {
        provider: fakeProvider(),
        fetch: serviceFetch({ posts }),
        env: { SAFE_PROPOSER_PRIVATE_KEY: PROPOSER_PRIVATE_KEY },
        multiSendRuntimeHash: ethers.utils.keccak256("0x01"),
        log: () => {},
      }
    );
    assert.equal(posts.length, 0);
    assert.equal(result.chunks.length, 1);
    assert.equal(fs.existsSync(`${file}.chunks.json`), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("--propose posts signed Safe transactions in nonce order", async () => {
  const posts = [];
  const { directory, file } = writeBuilder(
    builder([
      call(targetA, "0xaaaaaaaa"),
      call(targetB, "0xbbbbbbbb"),
      call(targetC, "0xcccccccc"),
    ])
  );
  try {
    const result = await runProposeSafeBatchChunks(
      { file, maxGas: "15", propose: true, origin: "node:test" },
      {
        provider: fakeProvider(),
        fetch: serviceFetch({ posts }),
        env: { SAFE_PROPOSER_PRIVATE_KEY: PROPOSER_PRIVATE_KEY },
        multiSendRuntimeHash: ethers.utils.keccak256("0x01"),
        log: () => {},
      }
    );

    assert.deepEqual(
      posts.map(({ nonce }) => nonce),
      [7, 8, 9]
    );
    assert.equal(posts.length, result.chunks.length);
    for (const body of posts) {
      assert.equal(body.sender, proposer.address);
      assert.equal(body.operation, 1);
      assert.equal(body.origin, "node:test");
      assert.equal(
        ethers.utils.verifyTypedData(
          { chainId: 8453, verifyingContract: BASE_SAFE },
          SAFE_TX_TYPES,
          {
            to: body.to,
            value: body.value,
            data: body.data,
            operation: body.operation,
            safeTxGas: body.safeTxGas,
            baseGas: body.baseGas,
            gasPrice: body.gasPrice,
            gasToken: body.gasToken,
            refundReceiver: body.refundReceiver,
            nonce: body.nonce,
          },
          body.signature
        ),
        proposer.address
      );
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("--propose refuses a duplicate queued Safe transaction hash", async () => {
  const posts = [];
  const { directory, file } = writeBuilder(
    builder([call(targetA, "0xaaaaaaaa")])
  );
  try {
    const first = await runProposeSafeBatchChunks(
      { file, maxGas: "100", propose: false },
      {
        provider: fakeProvider(),
        fetch: serviceFetch(),
        env: { SAFE_PROPOSER_PRIVATE_KEY: PROPOSER_PRIVATE_KEY },
        multiSendRuntimeHash: ethers.utils.keccak256("0x01"),
        log: () => {},
      }
    );
    await assert.rejects(
      runProposeSafeBatchChunks(
        { file, maxGas: "100", propose: true },
        {
          provider: fakeProvider(),
          fetch: serviceFetch({
            posts,
            queued: [{ nonce: 6, safeTxHash: first.chunks[0].safeTxHash }],
          }),
          env: { SAFE_PROPOSER_PRIVATE_KEY: PROPOSER_PRIVATE_KEY },
          multiSendRuntimeHash: ethers.utils.keccak256("0x01"),
          log: () => {},
        }
      ),
      /already queued/
    );
    assert.equal(posts.length, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("--propose stops on the first failed service response and surfaces its body", async () => {
  const posts = [];
  const { directory, file } = writeBuilder(
    builder([call(targetA, "0xaaaaaaaa"), call(targetB, "0xbbbbbbbb")])
  );
  try {
    await assert.rejects(
      runProposeSafeBatchChunks(
        { file, maxGas: "15", propose: true },
        {
          provider: fakeProvider(),
          fetch: serviceFetch({
            posts,
            postStatus: 422,
            postBody: { detail: "invalid Safe transaction" },
          }),
          env: { SAFE_PROPOSER_PRIVATE_KEY: PROPOSER_PRIVATE_KEY },
          multiSendRuntimeHash: ethers.utils.keccak256("0x01"),
          log: () => {},
        }
      ),
      /422.*invalid Safe transaction/
    );
    assert.equal(posts.length, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

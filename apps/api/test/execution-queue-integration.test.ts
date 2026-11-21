import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryExecutionStore } from "@4evergent/database";
import { ExecutionQueue } from "../src/execution-queue.js";
import type { ExecutionRecord, ExecutionResult } from "@4evergent/database";
import type { AgentIntent } from "@4evergent/shared";
import { startServer, waitFor } from "./helpers.js";
import { StellarAdapter } from "@4evergent/agent-core";
import {
  StellarTransactionBuilder,
  StellarSimulator,
  StellarSubmitter,
} from "@4evergent/stellar";

function makeIntent(): AgentIntent {
  return {
    type: "payment",
    asset: "XLM",
    destination: "GDI73WJ4SX7LOG3XZDJC3KCK6ED6E5NBYK2JUBQSPBCNNWEG3ZN7T75U",
    amount: "10",
    reason: "test execution",
  };
}

function makeExecution(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    ownerId: "owner-a",
    agentId: "agent-a",
    approvalId: null,
    activityId: null,
    intent: makeIntent(),
    status: "queued",
    policyDecision: null,
    simulationResult: null,
    txHash: null,
    error: null,
    attempt: 0,
    nextRetryAt: null,
    startedAt: null,
    completedAt: null,
    errorClass: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

test("ExecutionQueue: approval boundary — execution record requires approvalId", async () => {
  const store = new InMemoryExecutionStore();
  const pipelineExecutor = async (record: ExecutionRecord): Promise<ExecutionResult> => {
    // Verify that the execution record has an approvalId (approval boundary)
    assert.ok(record.approvalId, "execution record must have approvalId");
    return {
      record,
      success: true,
      status: "submitted",
      txHash: "tx-123",
      error: null,
    };
  };
  const queue = new ExecutionQueue(store, pipelineExecutor, async () => ({
    accountId: () => "GACCOUNT",
    sequenceNumber: () => "1",
    incrementSequenceNumber: () => {},
  }));

  const execution = makeExecution({ approvalId: "approval-123" });
  await queue.enqueue(execution);
  await queue.processDue();

  const updated = await store.get(execution.id);
  assert.equal(updated?.status, "submitted");
});

test("ExecutionQueue: owner isolation — executions are owner-scoped", async () => {
  const store = new InMemoryExecutionStore();
  const pipelineExecutor = async (record: ExecutionRecord): Promise<ExecutionResult> => {
    return {
      record,
      success: true,
      status: "submitted",
      txHash: "tx-123",
      error: null,
    };
  };
  const queue = new ExecutionQueue(store, pipelineExecutor, async () => ({
    accountId: () => "GACCOUNT",
    sequenceNumber: () => "1",
    incrementSequenceNumber: () => {},
  }));

  const executionA = makeExecution({ ownerId: "owner-a", agentId: "agent-a" });
  const executionB = makeExecution({ ownerId: "owner-b", agentId: "agent-b" });
  await queue.enqueue(executionA);
  await queue.enqueue(executionB);
  await queue.processDue();

  const all = await store.listByOwner("owner-a", 10);
  assert.equal(all.length, 1);
  assert.equal(all[0]?.ownerId, "owner-a");
});

test("ExecutionQueue: scheduler integration — scheduled execution enqueued and processed", async () => {
  const store = new InMemoryExecutionStore();
  let executed = 0;
  const pipelineExecutor = async (record: ExecutionRecord): Promise<ExecutionResult> => {
    executed++;
    return {
      record,
      success: true,
      status: "submitted",
      txHash: "tx-scheduled",
      error: null,
    };
  };
  const queue = new ExecutionQueue(store, pipelineExecutor, async () => ({
    accountId: () => "GACCOUNT",
    sequenceNumber: () => "1",
    incrementSequenceNumber: () => {},
  }));

  // Simulate scheduler enqueueing a scheduled execution
  const execution = makeExecution({
    ownerId: "owner-a",
    agentId: "agent-a",
    approvalId: null,
    activityId: "activity-123",
  });
  await queue.enqueue(execution);
  await queue.processDue();

  assert.equal(executed, 1);
  const updated = await store.get(execution.id);
  assert.equal(updated?.status, "submitted");
  assert.equal(updated?.txHash, "tx-scheduled");
});

test("ExecutionQueue: manual execution regression — direct pipeline execution still works", async () => {
  const store = new InMemoryExecutionStore();
  const pipelineExecutor = async (record: ExecutionRecord): Promise<ExecutionResult> => {
    return {
      record,
      success: true,
      status: "submitted",
      txHash: "tx-manual",
      error: null,
    };
  };
  const queue = new ExecutionQueue(store, pipelineExecutor, async () => ({
    accountId: () => "GACCOUNT",
    sequenceNumber: () => "1",
    incrementSequenceNumber: () => {},
  }));

  const execution = makeExecution();
  await queue.enqueue(execution);
  await queue.processDue();

  const updated = await store.get(execution.id);
  assert.equal(updated?.status, "submitted");
  assert.equal(updated?.txHash, "tx-manual");
});

function stubStellar(overrides: {
  simulate?: () => Promise<any>;
  submit?: () => Promise<any>;
  getTransactionStatus?: (txHash: string) => Promise<any>;
} = {}) {
  const originals = {
    getAccount: StellarAdapter.prototype.getAccount,
    getTransactionStatus: StellarAdapter.prototype.getTransactionStatus,
    buildPayment: StellarTransactionBuilder.prototype.buildPayment,
    simulate: StellarSimulator.prototype.simulate,
    submit: StellarSubmitter.prototype.submit,
  };
  StellarAdapter.prototype.getAccount = (async () => ({
    address: "GDI73WJ4SX7LOG3XZDJC3KCK6ED6E5NBYK2JUBQSPBCNNWEG3ZN7T75U",
    sequence: "1",
    balances: [],
    subentryCount: 0,
  })) as typeof originals.getAccount;
  StellarAdapter.prototype.getTransactionStatus = (overrides.getTransactionStatus ?? (async () => "not_found")) as typeof originals.getTransactionStatus;
  StellarTransactionBuilder.prototype.buildPayment = (async () => ({
    hash: () => Buffer.from("pre-submit-hash"),
  })) as typeof originals.buildPayment;
  StellarSimulator.prototype.simulate = (overrides.simulate ?? (async () => ({
    success: true,
    fee: "100",
    operations: 1,
    warnings: [],
  }))) as typeof originals.simulate;
  StellarSubmitter.prototype.submit = (overrides.submit ?? (async () => ({
    hash: "stub-tx-hash",
    ledger: 123,
  }))) as typeof originals.submit;
  return () => {
    StellarAdapter.prototype.getAccount = originals.getAccount;
    StellarAdapter.prototype.getTransactionStatus = originals.getTransactionStatus;
    StellarTransactionBuilder.prototype.buildPayment = originals.buildPayment;
    StellarSimulator.prototype.simulate = originals.simulate;
    StellarSubmitter.prototype.submit = originals.submit;
  };
}

test("production pipelineExecutor: transient submission failure is classified transient and retried", async () => {
  const restore = stubStellar({
    submit: async () => {
      throw new Error("network timeout");
    },
  });
  const { close, executionStore } = await startServer({
    schedulerEnabled: true,
    intervalMs: 50,
  });
  try {
    const record = makeExecution();
    await executionStore.record(record);

    const updated = await waitFor(
      async () => {
        const r = await executionStore.get(record.id);
        return r && r.status !== "queued" && r.status !== "executing" ? r : undefined;
      },
      5000,
      50
    );
    assert.ok(updated);
    assert.equal(updated.status, "failed");
    assert.equal(updated.errorClass, "transient");
    assert.ok(updated.nextRetryAt);
  } finally {
    await close();
    restore();
  }
});

test("production pipelineExecutor: deterministic simulation failure is classified permanent and dead-lettered", async () => {
  const restore = stubStellar({
    simulate: async () => ({
      success: false,
      fee: "0",
      operations: 0,
      warnings: [],
      error: "bad sequence",
    }),
  });
  const { close, executionStore } = await startServer({
    schedulerEnabled: true,
    intervalMs: 50,
  });
  try {
    const record = makeExecution();
    await executionStore.record(record);

    const updated = await waitFor(
      async () => {
        const r = await executionStore.get(record.id);
        return r && r.status !== "queued" && r.status !== "executing" ? r : undefined;
      },
      5000,
      50
    );
    assert.ok(updated);
    assert.equal(updated.status, "dead_letter");
    assert.equal(updated.errorClass, "permanent");
    assert.equal(updated.nextRetryAt, null);
  } finally {
    await close();
    restore();
  }
});

test("production pipelineExecutor: permanent policy rejection is classified permanent and dead-lettered", async () => {
  const restore = stubStellar();
  const { close, executionStore } = await startServer({
    policyRules: { maxTxAmount: { XLM: "5" } },
    schedulerEnabled: true,
    intervalMs: 50,
  });
  try {
    const record = makeExecution({
      intent: { ...makeIntent(), amount: "50" },
    });
    await executionStore.record(record);

    const updated = await waitFor(
      async () => {
        const r = await executionStore.get(record.id);
        return r && r.status !== "queued" && r.status !== "executing" ? r : undefined;
      },
      5000,
      50
    );
    assert.ok(updated);
    assert.equal(updated.status, "dead_letter");
    assert.equal(updated.errorClass, "permanent");
    assert.equal(updated.nextRetryAt, null);
  } finally {
    await close();
    restore();
  }
});

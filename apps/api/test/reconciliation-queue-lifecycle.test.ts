/**
 * Integration tests for the ExecutionQueue + TransactionStatusReconciler lifecycle.
 *
 * Transition ownership contract enforced by these tests:
 *   - ExecutionQueue owns:
 *       queued -> executing -> submitted (on successful submission)
 *       queued -> executing -> failed / dead_letter (on submission failure / exhausted retries)
 *       failed -> queued (via manual retry(), subject to maxRetries)
 *   - TransactionStatusReconciler owns:
 *       submitted -> confirmed (when statusProvider returns "confirmed")
 *       submitted -> failed    (when statusProvider returns "failed", or "not_found" past maxAgeMs)
 *       submitted -> submitted (no-op when statusProvider returns "not_found" within maxAgeMs or "network_error")
 *   - Both use atomic conditional updates (updateIfStatus) so a concurrent state
 *     change between read and write cannot be overwritten by a stale update.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApiServer } from "../src/index.js";
import { ExecutionQueue } from "../src/execution-queue.js";
import { DevAuthProvider } from "@4evergent/shared";
import {
  InMemoryExecutionStore,
  InMemoryActivityStore,
  InMemoryApprovalStore,
  InMemoryScheduleStore,
  InMemoryAgentStore,
} from "@4evergent/database";
import type { ExecutionRecord, ExecutionResult } from "@4evergent/database";
import {
  TransactionStatusReconciler,
  type TransactionStatus,
  type TransactionStatusProvider,
} from "@4evergent/stellar";

function makeExecution(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  const now = new Date("2026-01-01T00:00:00.000Z").toISOString();
  return {
    id: crypto.randomUUID(),
    ownerId: "owner-a",
    agentId: "agent-a",
    approvalId: "approval-1",
    activityId: null,
    intent: {
      type: "payment",
      asset: "XLM",
      destination: "GDI73WJ4SX7LOG3XZDJC3KCK6ED6E5NBYK2JUBQSPBCNNWEG3ZN7T75U",
      amount: "10",
      reason: "lifecycle test",
    },
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

interface HarnessOptions {
  getStatus: (txHash: string) => Promise<TransactionStatus>;
  execute?: (record: ExecutionRecord) => Promise<ExecutionResult>;
  maxRetries?: number;
}

async function startLifecycleHarness(opts: HarnessOptions) {
  let currentNow = new Date("2026-01-01T00:00:00.000Z");
  const clock = () => currentNow;

  const executionStore = new InMemoryExecutionStore();
  const activityStore = new InMemoryActivityStore();
  const approvalStore = new InMemoryApprovalStore();
  const scheduleStore = new InMemoryScheduleStore();
  const agentStore = new InMemoryAgentStore();

  const statusProvider: TransactionStatusProvider = {
    getStatus: opts.getStatus,
  };

  const reconciler = new TransactionStatusReconciler(executionStore, statusProvider, {
    intervalMs: 600_000,
    clock,
    activityStore,
  });

  const defaultExecute = async (record: ExecutionRecord): Promise<ExecutionResult> => ({
    record,
    success: true,
    status: "submitted",
    txHash: `tx-${record.id.slice(0, 8)}`,
    error: null,
  });

  const queue = new ExecutionQueue(
    executionStore,
    opts.execute ?? defaultExecute,
    async () => ({
      accountId: () => "GTEST",
      sequenceNumber: () => "1",
      incrementSequenceNumber: () => {},
    }),
    {
      intervalMs: 600_000,
      nowFn: clock,
      retryPolicy: {
        maxRetries: opts.maxRetries ?? 2,
        baseDelayMs: 1_000,
        maxDelayMs: 10_000,
        jitterFactor: 0,
      },
      statusProvider,
    }
  );

  const server = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer: {
      getAccountId: () => "GTEST",
      getNetworkPassphrase: () => "Test SDF Network ; September 2015",
      sign: async (tx: any) => tx,
    },
    activityStore,
    approvalStore,
    scheduleStore,
    executionStore,
    agentStore,
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
    executionQueue: { enabled: true, instance: queue, intervalMs: 600_000 },
    reconciliation: { enabled: true, instance: reconciler, intervalMs: 600_000 },
  });

  await server.listen(0);

  return {
    executionStore,
    queue,
    reconciler,
    advanceTimeMs: (ms: number) => {
      currentNow = new Date(currentNow.getTime() + ms);
    },
    clock,
    close: () => server.close(),
  };
}

test("LIFECYCLE: queued -> executing -> submitted -> confirmed preserves txHash", async () => {
  const harness = await startLifecycleHarness({
    getStatus: async () => "confirmed",
  });

  try {
    const execution = makeExecution();
    await harness.queue.enqueue(execution);

    await harness.queue.processDue(harness.clock().toISOString());
    const submitted = await harness.executionStore.get(execution.id);
    assert.equal(submitted?.status, "submitted");
    assert.ok(submitted?.txHash, "txHash should be set on submitted record");

    const recResult = await harness.reconciler.reconcile();
    assert.equal(recResult.confirmed, 1);

    const confirmed = await harness.executionStore.get(execution.id);
    assert.equal(confirmed?.status, "confirmed");
    assert.equal(confirmed?.txHash, submitted.txHash);
  } finally {
    await harness.close();
  }
});

test("LIFECYCLE: submitted + failed -> reconciler marks failed -> queue retry -> dead_letter when exhausted", async () => {
  let attemptCount = 0;
  const harness = await startLifecycleHarness({
    maxRetries: 1,
    getStatus: async () => "failed",
    execute: async (record) => {
      attemptCount++;
      if (attemptCount === 1) {
        return {
          record,
          success: true,
          status: "submitted",
          txHash: `tx-${record.id.slice(0, 8)}`,
          error: null,
        };
      }
      return {
        record,
        success: false,
        status: "failed",
        txHash: null,
        error: "Horizon 500: permanent failure after retry",
      };
    },
  });

  try {
    const execution = makeExecution();
    await harness.queue.enqueue(execution);

    // Attempt 1: queued -> executing -> submitted
    await harness.queue.processDue(harness.clock().toISOString());
    const submitted = await harness.executionStore.get(execution.id);
    assert.equal(submitted?.status, "submitted");
    assert.equal(submitted?.attempt, 0);

    // Reconciler sees on-chain failure -> submitted -> failed
    const recResult = await harness.reconciler.reconcile();
    assert.equal(recResult.failed, 1);
    const failed = await harness.executionStore.get(execution.id);
    assert.equal(failed?.status, "failed");

    // Queue retries the failed execution -> queued, then attempt 1 exhausts maxRetries -> dead_letter
    const retryRes = await harness.queue.retry(execution.id, 1);
    assert.equal(retryRes.status, "queued");

    harness.advanceTimeMs(5_000);
    await harness.queue.processDue(harness.clock().toISOString());

    const finalRecord = await harness.executionStore.get(execution.id);
    assert.equal(finalRecord?.status, "dead_letter");
    assert.equal(finalRecord?.attempt, 1);
  } finally {
    await harness.close();
  }
});

test("LIFECYCLE: submitted + not_found stays submitted and is never blind-retried", async () => {
  const harness = await startLifecycleHarness({
    getStatus: async () => "not_found",
  });

  try {
    const execution = makeExecution();
    await harness.queue.enqueue(execution);

    await harness.queue.processDue(harness.clock().toISOString());
    const submitted = await harness.executionStore.get(execution.id);
    assert.equal(submitted?.status, "submitted");
    assert.equal(submitted?.attempt, 0);

    const recResult = await harness.reconciler.reconcile();
    assert.equal(recResult.checked, 1);
    assert.equal(recResult.confirmed, 0);
    assert.equal(recResult.failed, 0);

    // Advance time slightly (well under 6h maxAgeMs) and run processDue again
    harness.advanceTimeMs(10_000);
    await harness.queue.processDue(harness.clock().toISOString());

    const after = await harness.executionStore.get(execution.id);
    assert.equal(after?.status, "submitted");
    assert.equal(after?.attempt, 0);
    assert.equal(after?.txHash, submitted?.txHash);
  } finally {
    await harness.close();
  }
});

test("LIFECYCLE: submitted + network_error stays submitted", async () => {
  const harness = await startLifecycleHarness({
    getStatus: async () => "network_error",
  });

  try {
    const execution = makeExecution();
    await harness.queue.enqueue(execution);

    await harness.queue.processDue(harness.clock().toISOString());
    const submitted = await harness.executionStore.get(execution.id);
    assert.equal(submitted?.status, "submitted");

    const recResult = await harness.reconciler.reconcile();
    assert.equal(recResult.checked, 1);
    assert.equal(recResult.confirmed, 0);
    assert.equal(recResult.failed, 0);

    const after = await harness.executionStore.get(execution.id);
    assert.equal(after?.status, "submitted");
    assert.equal(after?.attempt, 0);
  } finally {
    await harness.close();
  }
});

test("LIFECYCLE: concurrent update between reconciler read and write prevents stale overwrite", async () => {
  let storeRef: InMemoryExecutionStore | null = null;
  let targetId: string | null = null;

  const harness = await startLifecycleHarness({
    getStatus: async () => {
      // Simulate a concurrent writer confirming the record after reconciler read it
      if (storeRef && targetId) {
        await storeRef.updateIfStatus(targetId, "submitted", {
          status: "confirmed",
          completedAt: new Date("2026-01-01T00:00:05.000Z").toISOString(),
          updatedAt: new Date("2026-01-01T00:00:05.000Z").toISOString(),
          nextRetryAt: null,
        });
      }
      return "failed";
    },
  });

  storeRef = harness.executionStore;

  try {
    const execution = makeExecution();
    targetId = execution.id;
    await harness.queue.enqueue(execution);

    await harness.queue.processDue(harness.clock().toISOString());
    const submitted = await harness.executionStore.get(execution.id);
    assert.equal(submitted?.status, "submitted");

    // Reconciler reads "submitted", gets "failed" from provider, but concurrent update already
    // moved it to "confirmed". Reconciler's updateIfStatus(..., "submitted", ...) must be a no-op.
    const recResult = await harness.reconciler.reconcile();
    assert.equal(recResult.failed, 0);

    const finalRecord = await harness.executionStore.get(execution.id);
    assert.equal(finalRecord?.status, "confirmed");
  } finally {
    await harness.close();
  }
});

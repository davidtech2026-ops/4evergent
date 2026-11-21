import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { DevAuthProvider } from "@4evergent/shared";
import {
  InMemoryActivityStore,
  InMemoryApprovalStore,
  InMemoryExecutionStore,
  InMemoryScheduleStore,
} from "@4evergent/database";
import type { ExecutionRecord, ScheduleRecord } from "@4evergent/database";
import { createApiServer } from "../src/index.js";
import { DEFAULT_TEST_AGENT, MockSigner, waitFor } from "./helpers.js";

function makeSchedule(overrides: Partial<ScheduleRecord> = {}): ScheduleRecord {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    agentId: "test-agent",
    ownerId: "test",
    status: "active",
    intent: {
      type: "payment",
      asset: "XLM",
      destination: "GDI73WJ4SX7LOG3XZDJC3KCK6ED6E5NBYK2JUBQSPBCNNWEG3ZN7T75U",
      amount: "10",
      reason: "scheduled payment enqueue failure test",
    },
    scheduleExpression: "0 * * * *",
    timezone: "UTC",
    nextRunAt: new Date(Date.now() - 60_000).toISOString(),
    lastRunAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

class FailingExecutionStore extends InMemoryExecutionStore {
  recordCalls = 0;

  constructor(private readonly errorMessage: string) {
    super();
  }

  override async record(_record: ExecutionRecord): Promise<void> {
    this.recordCalls++;
    throw new Error(this.errorMessage);
  }
}

test("scheduler callback: failing executionQueue.enqueue logs error, marks pre-created activity failed, and surfaces failure to scheduler", async () => {
  const activityStore = new InMemoryActivityStore();
  const executionStore = new FailingExecutionStore("execution store unavailable");
  const approvalStore = new InMemoryApprovalStore();
  const scheduleStore = new InMemoryScheduleStore();

  const loggedErrors: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    loggedErrors.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
  };

  const server = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer: new MockSigner("test-agent"),
    policyRules: { maxTxAmount: { XLM: "1000" } },
    deferExecution: true,
    authProvider: new DevAuthProvider({ defaultOwnerId: "test" }),
    activityStore,
    executionStore,
    approvalStore,
    scheduleStore,
    scheduler: { enabled: true, intervalMs: 50 },
    executionQueue: { enabled: true, intervalMs: 50 },
  });

  server.registerAgent({ ...DEFAULT_TEST_AGENT });

  try {
    const schedule = makeSchedule();
    await scheduleStore.create(schedule);

    // Wait for the scheduler tick to attempt enqueue and mark the pre-created activity failed.
    const failedActivity = await waitFor(async () => {
      const activities = await activityStore.listByAgent(schedule.agentId);
      return activities.find((a) => a.status === "failed");
    }, 2000);

    assert.ok(failedActivity, "Pre-created ActivityRecord must be marked failed instead of staying pending");
    assert.equal(failedActivity!.status, "failed");
    assert.match(failedActivity!.error ?? "", /execution store unavailable/);

    // Verify enqueue was attempted once (no duplicate execution records created).
    assert.equal(executionStore.recordCalls, 1, "enqueue should be attempted exactly once");
    const executions = await executionStore.listByAgent(schedule.agentId);
    assert.equal(executions.length, 0, "no execution record should be stored when enqueue fails");

    // Verify the failure was logged with the schedule id and error, and surfaced to the scheduler's error handler.
    const enqueueLog = loggedErrors.find(
      (msg) => msg.includes(schedule.id) && msg.includes("failed to enqueue execution") && msg.includes("execution store unavailable")
    );
    assert.ok(enqueueLog, `Expected enqueue failure log with schedule id and error, got: ${JSON.stringify(loggedErrors)}`);

    const schedulerFailureLog = loggedErrors.find(
      (msg) => msg.includes(`[scheduler] schedule ${schedule.id} failed:`) && msg.includes("execution store unavailable")
    );
    assert.ok(
      schedulerFailureLog,
      `Expected scheduler to catch thrown callback error (not treat as success), got: ${JSON.stringify(loggedErrors)}`
    );
  } finally {
    console.error = originalConsoleError;
    await server.close();
  }
});

test("scheduler callback: successful executionQueue.enqueue advances schedule normally", async () => {
  const activityStore = new InMemoryActivityStore();
  const executionStore = new InMemoryExecutionStore();
  const approvalStore = new InMemoryApprovalStore();
  const scheduleStore = new InMemoryScheduleStore();

  const server = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer: new MockSigner("test-agent"),
    policyRules: { maxTxAmount: { XLM: "1000" } },
    deferExecution: true,
    authProvider: new DevAuthProvider({ defaultOwnerId: "test" }),
    activityStore,
    executionStore,
    approvalStore,
    scheduleStore,
    scheduler: { enabled: true, intervalMs: 50 },
    executionQueue: { enabled: true, intervalMs: 50 },
  });

  server.registerAgent({ ...DEFAULT_TEST_AGENT });

  try {
    const initialNextRunAt = new Date(Date.now() - 60_000).toISOString();
    const schedule = makeSchedule({ nextRunAt: initialNextRunAt });
    await scheduleStore.create(schedule);

    const execution = await waitFor(async () => {
      const recs = await executionStore.listByAgent(schedule.agentId);
      return recs[0];
    }, 2000);

    assert.ok(execution, "ExecutionRecord should be enqueued");

    const updatedSchedule = await waitFor(async () => {
      const s = await scheduleStore.get(schedule.id);
      return s && s.lastRunAt ? s : undefined;
    }, 2000);

    assert.ok(updatedSchedule, "Schedule should advance after successful enqueue");
    assert.ok(updatedSchedule!.lastRunAt, "lastRunAt should be set");
    assert.notEqual(updatedSchedule!.nextRunAt, initialNextRunAt, "nextRunAt should advance to next occurrence");
  } finally {
    await server.close();
  }
});

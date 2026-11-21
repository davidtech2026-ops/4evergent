import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createApproval,
  InMemoryApprovalStore,
  type ApprovalStore,
  type AgentIntent,
  type PolicyDecision,
} from "../src/index.js";
import { SQLiteApprovalStore } from "../src/sqlite-store.js";
import { closeAllSharedConnections } from "../src/shared-connection.js";

function makeIntent(): AgentIntent {
  return { type: "payment", amount: "100", asset: "XLM", destination: "GDEST" };
}

function makeDecision(): PolicyDecision {
  return { result: "requires_approval", reason: "test", rule: "approval" };
}

function runExpiryTests(name: string, makeStore: () => { approval: ApprovalStore; cleanup?: () => void }) {
  test(`${name}: expired approval is not counted or listed as pending_approval`, async () => {
    const { approval, cleanup } = makeStore();
    try {
      const past = new Date(Date.now() - 3600_000).toISOString();
      const future = new Date(Date.now() + 3600_000).toISOString();

      const expiredAppr = createApproval("act-1", "agent-1", "owner-1", makeIntent(), makeDecision(), past);
      const activeAppr = createApproval("act-2", "agent-1", "owner-1", makeIntent(), makeDecision(), future);
      const noExpiryAppr = createApproval("act-3", "agent-1", "owner-1", makeIntent(), makeDecision(), null);

      await approval.record(expiredAppr);
      await approval.record(activeAppr);
      await approval.record(noExpiryAppr);

      // countByOwner for pending_approval
      const pendingCount = await approval.countByOwner("owner-1", "pending_approval");
      assert.equal(pendingCount, 2, "only unexpired pending approvals should be counted as pending");

      // listByOwner for pending_approval
      const pendingList = await approval.listByOwner("owner-1", 50, 0, "pending_approval");
      assert.equal(pendingList.length, 2);
      const ids = pendingList.map((a) => a.id);
      assert.ok(!ids.includes(expiredAppr.id), "expired approval must not appear in pending list");
      assert.ok(ids.includes(activeAppr.id));
      assert.ok(ids.includes(noExpiryAppr.id));

      // listByAgent & listByStatus for pending_approval
      const agentPending = await approval.listByAgent("agent-1", 50, 0, "pending_approval");
      assert.equal(agentPending.length, 2);
      assert.ok(!agentPending.some((a) => a.id === expiredAppr.id));

      const statusPending = await approval.listByStatus("agent-1", "pending_approval");
      assert.equal(statusPending.length, 2);
      assert.ok(!statusPending.some((a) => a.id === expiredAppr.id));

      // countByOwner for expired
      const expiredCount = await approval.countByOwner("owner-1", "expired");
      assert.equal(expiredCount, 1, "past-expiresAt approval must be counted as expired");

      // listByOwner for expired
      const expiredList = await approval.listByOwner("owner-1", 50, 0, "expired");
      assert.equal(expiredList.length, 1);
      assert.equal(expiredList[0]?.id, expiredAppr.id);
      assert.equal(expiredList[0]?.status, "expired");

      // get & getForOwner return status = expired
      const got = await approval.get(expiredAppr.id);
      assert.equal(got?.status, "expired");
      assert.ok(got?.expiredAt);

      const gotForOwner = await approval.getForOwner(expiredAppr.id, "owner-1");
      assert.equal(gotForOwner?.status, "expired");

      // updateIfStatus with expectedStatus pending_approval must fail
      const claimResult = await approval.updateIfStatus(expiredAppr.id, "pending_approval", {
        status: "approved",
      });
      assert.equal(claimResult, null, "cannot claim expired approval as pending_approval");
    } finally {
      cleanup?.();
    }
  });

  test(`${name}: sweepExpired marks past-expiresAt approvals as expired in the store`, async () => {
    const { approval, cleanup } = makeStore();
    try {
      const past1 = new Date(Date.now() - 7200_000).toISOString();
      const past2 = new Date(Date.now() - 3600_000).toISOString();
      const future = new Date(Date.now() + 3600_000).toISOString();

      const exp1 = createApproval("act-1", "agent-1", "owner-1", makeIntent(), makeDecision(), past1);
      const exp2 = createApproval("act-2", "agent-1", "owner-1", makeIntent(), makeDecision(), past2);
      const live = createApproval("act-3", "agent-1", "owner-1", makeIntent(), makeDecision(), future);

      await approval.record(exp1);
      await approval.record(exp2);
      await approval.record(live);

      const sweptCallbacks: string[] = [];
      const sweptCount = await approval.sweepExpired(new Date().toISOString(), 500, (rec) => {
        sweptCallbacks.push(rec.id);
      });

      assert.equal(sweptCount, 2);
      assert.deepEqual(sweptCallbacks.sort(), [exp1.id, exp2.id].sort());

      // Future approval still pending
      const liveRec = await approval.get(live.id);
      assert.equal(liveRec?.status, "pending_approval");

      // Swept approvals are expired
      const rec1 = await approval.get(exp1.id);
      assert.equal(rec1?.status, "expired");

      const rec2 = await approval.get(exp2.id);
      assert.equal(rec2?.status, "expired");

      // Sweeping again finds 0
      const secondSweep = await approval.sweepExpired(new Date().toISOString(), 500);
      assert.equal(secondSweep, 0);
    } finally {
      cleanup?.();
    }
  });

  test(`${name}: sweepExpired respects batch limit`, async () => {
    const { approval, cleanup } = makeStore();
    try {
      const past = new Date(Date.now() - 3600_000).toISOString();
      for (let i = 0; i < 5; i++) {
        await approval.record(createApproval(`act-${i}`, "agent-1", "owner-1", makeIntent(), makeDecision(), past));
      }

      const swept = await approval.sweepExpired(new Date().toISOString(), 2);
      assert.equal(swept, 2);

      const remainingSwept = await approval.sweepExpired(new Date().toISOString(), 10);
      assert.equal(remainingSwept, 3);
    } finally {
      cleanup?.();
    }
  });
}

runExpiryTests("InMemoryApprovalStore", () => ({
  approval: new InMemoryApprovalStore(),
}));

runExpiryTests("SQLiteApprovalStore", () => {
  const tmp = path.join(os.tmpdir(), `sqlite-test-expiry-${crypto.randomUUID()}.db`);
  return {
    approval: new SQLiteApprovalStore(tmp),
    cleanup: () => {
      closeAllSharedConnections();
      try {
        fs.unlinkSync(tmp);
      } catch {
        // Ignore if file doesn't exist
      }
    },
  };
});


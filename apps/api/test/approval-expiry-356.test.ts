import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createApiServer } from "../src/index.js";
import { DevAuthProvider } from "@4evergent/shared";
import {
  InMemoryActivityStore,
  InMemoryAgentStore,
  InMemoryApprovalStore,
  InMemoryExecutionStore,
  SQLiteActivityStore,
  SQLiteAgentStore,
  SQLiteApprovalStore,
  SQLiteExecutionStore,
  closeAllSharedConnections,
  createApproval,
} from "@4evergent/database";

declare const fetch: typeof globalThis.fetch;

const TEST_INTENT = {
  type: "payment" as const,
  asset: "XLM",
  destination: "GDI73WJ4SX7LOG3XZDJC3KCK6ED6E5NBYK2JUBQSPBCNNWEG3ZN7T75U",
  amount: "10",
  reason: "expiry test",
};

function makeServer(useSqlite = false) {
  let dbPath: string | undefined;
  if (useSqlite) {
    dbPath = path.join(os.tmpdir(), `sqlite-expiry-api-${crypto.randomUUID()}.db`);
  }

  const activityStore = useSqlite ? new SQLiteActivityStore(dbPath!) : new InMemoryActivityStore();
  const agentStore = useSqlite ? new SQLiteAgentStore(dbPath!) : new InMemoryAgentStore();
  const approvalStore = useSqlite ? new SQLiteApprovalStore(dbPath!) : new InMemoryApprovalStore();
  const executionStore = useSqlite ? new SQLiteExecutionStore(dbPath!) : new InMemoryExecutionStore();

  const auth = new DevAuthProvider({ defaultOwnerId: "owner-a" });

  async function start() {
    const apiServer = await createApiServer({
      port: 0,
      horizonUrl: "https://horizon-testnet.stellar.org",
      activityStore,
      agentStore,
      approvalStore,
      executionStore,
      authProvider: auth,
      signer: {
        sign: async () => ({ signedTxXdr: "xdr", txHash: "h1" } as any),
        getAccountId: () => "GSOURCE",
        getNetworkPassphrase: () => "Test SDF Network ; September 2015",
      },
      retention: {
        intervalMs: 100_000,
        authSessionDays: 30,
        dailySpendingDays: 90,
      },
    });

    apiServer.registerAgent({
      id: "agent-1",
      displayName: "Agent One",
      description: "expiry test agent",
      ownerId: "owner-a",
      stellarAddress: "GA1",
      capabilities: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      active: true,
      status: "active",
      metadata: {},
    });

    await apiServer.listen(0);
    const addr = apiServer.server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    return {
      baseUrl,
      activityStore,
      approvalStore,
      close: async () => {
        await apiServer.close();
        if (useSqlite && dbPath) {
          closeAllSharedConnections();
          try {
            fs.unlinkSync(dbPath);
          } catch {
            // Ignore if file doesn't exist
          }
        }
      },
    };
  }

  return start;
}

for (const backend of ["InMemory", "SQLite"] as const) {
  const isSqlite = backend === "SQLite";

  test(`[${backend}] #356: GET /overview/attention excludes expired approvals without human action`, async () => {
    const start = makeServer(isSqlite);
    const { baseUrl, close, approvalStore } = await start();
    try {
      const past = new Date(Date.now() - 3600_000).toISOString();
      const future = new Date(Date.now() + 3600_000).toISOString();

      // One expired approval, one live pending approval
      const expiredAppr = createApproval(
        "act-expired",
        "agent-1",
        "owner-a",
        TEST_INTENT,
        { result: "requires_approval", reason: "test", rule: "approval" },
        past
      );
      const liveAppr = createApproval(
        "act-live",
        "agent-1",
        "owner-a",
        TEST_INTENT,
        { result: "requires_approval", reason: "test", rule: "approval" },
        future
      );

      await approvalStore.record(expiredAppr);
      await approvalStore.record(liveAppr);

      const res = await fetch(`${baseUrl}/overview/attention`, {
        headers: { Authorization: "Bearer dev:owner-a" },
      });
      assert.equal(res.status, 200);
      const data = await res.json();

      // Only the live approval should be counted as pending (1, not 2)
      assert.equal(data.pendingApprovals, 1, "expired approval must not be counted in pendingApprovals");
    } finally {
      await close();
    }
  });

  test(`[${backend}] #356: GET /approvals?status=pending_approval does not return expired approvals`, async () => {
    const start = makeServer(isSqlite);
    const { baseUrl, close, approvalStore } = await start();
    try {
      const past = new Date(Date.now() - 3600_000).toISOString();
      const future = new Date(Date.now() + 3600_000).toISOString();

      const expiredAppr = createApproval(
        "act-expired",
        "agent-1",
        "owner-a",
        TEST_INTENT,
        { result: "requires_approval", reason: "test", rule: "approval" },
        past
      );
      const liveAppr = createApproval(
        "act-live",
        "agent-1",
        "owner-a",
        TEST_INTENT,
        { result: "requires_approval", reason: "test", rule: "approval" },
        future
      );

      await approvalStore.record(expiredAppr);
      await approvalStore.record(liveAppr);

      // Query pending
      const pendingRes = await fetch(`${baseUrl}/approvals?status=pending_approval`, {
        headers: { Authorization: "Bearer dev:owner-a" },
      });
      assert.equal(pendingRes.status, 200);
      const pendingData = await pendingRes.json();
      assert.equal(pendingData.approvals.length, 1);
      assert.equal(pendingData.approvals[0].id, liveAppr.id);
      assert.equal(pendingData.total, 1);

      // Query expired
      const expiredRes = await fetch(`${baseUrl}/approvals?status=expired`, {
        headers: { Authorization: "Bearer dev:owner-a" },
      });
      assert.equal(expiredRes.status, 200);
      const expiredData = await expiredRes.json();
      assert.equal(expiredData.approvals.length, 1);
      assert.equal(expiredData.approvals[0].id, expiredAppr.id);
      assert.equal(expiredData.approvals[0].status, "expired");
      assert.equal(expiredData.total, 1);
    } finally {
      await close();
    }
  });

  test(`[${backend}] #356: POST /approvals/:id/approve on expired approval returns 410 APPROVAL_EXPIRED`, async () => {
    const start = makeServer(isSqlite);
    const { baseUrl, close, approvalStore } = await start();
    try {
      const past = new Date(Date.now() - 3600_000).toISOString();
      const expiredAppr = createApproval(
        "act-expired",
        "agent-1",
        "owner-a",
        TEST_INTENT,
        { result: "requires_approval", reason: "test", rule: "approval" },
        past
      );
      await approvalStore.record(expiredAppr);

      const res = await fetch(`${baseUrl}/approvals/${expiredAppr.id}/approve`, {
        method: "POST",
        headers: {
          Authorization: "Bearer dev:owner-a",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });

      assert.equal(res.status, 410);
      const data = await res.json();
      assert.equal(data.code, "APPROVAL_EXPIRED");
      assert.equal(data.status, "expired");
    } finally {
      await close();
    }
  });

  test(`[${backend}] #356: sweepExpired transitions past-expiresAt approvals to terminal expired state`, async () => {
    const start = makeServer(isSqlite);
    const { baseUrl, close, approvalStore } = await start();
    try {
      const past = new Date(Date.now() - 3600_000).toISOString();
      const expiredAppr = createApproval(
        "act-expired",
        "agent-1",
        "owner-a",
        TEST_INTENT,
        { result: "requires_approval", reason: "test", rule: "approval" },
        past
      );
      await approvalStore.record(expiredAppr);

      const swept = await approvalStore.sweepExpired(new Date().toISOString(), 500);
      assert.equal(swept, 1);

      // Now approve returns 410 even after sweep has marked it expired in DB
      const res = await fetch(`${baseUrl}/approvals/${expiredAppr.id}/approve`, {
        method: "POST",
        headers: {
          Authorization: "Bearer dev:owner-a",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });

      assert.equal(res.status, 410);
      const data = await res.json();
      assert.equal(data.code, "APPROVAL_EXPIRED");
      assert.equal(data.status, "expired");
    } finally {
      await close();
    }
  });
}

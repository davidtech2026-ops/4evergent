import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import type { Signer } from "@4evergent/stellar";
import type { PolicyRules } from "@4evergent/shared";
import type { AddressInfo } from "node:net";
import { createApiServer } from "../src/index.js";
import { DevAuthProvider } from "@4evergent/shared";
import {
  createActivity,
  createApproval,
  InMemoryActivityStore,
  InMemoryApprovalStore,
  InMemoryExecutionStore,
} from "@4evergent/database";

// NOTE: approval integration tests must not call the live Horizon network.
// We test only the persistence + state-machine + idempotency behavior.
// The async execution after approval uses a local stub account (no network).

// NOTE: approval integration tests use deterministic mocks and in-process
// HTTP servers. They do NOT call the live Stellar testnet.

class MockSigner implements Signer {
  private id: string;
  constructor(id: string) {
    this.id = id.startsWith("G") ? id : `G${id.padEnd(55, "A").slice(0, 55)}`;
  }
  getAccountId(): string { return this.id; }
  getNetworkPassphrase(): string { return "Test SDF Network ; September 2015"; }
  async sign(transaction: any): Promise<any> {
    transaction.signatures = [{ hint: Buffer.from("mock"), signature: Buffer.from("sig") }];
    return transaction;
  }
}

const TEST_AGENT = {
  id: "test-agent",
  displayName: "Test",
  description: "test agent",
  ownerId: "test",
  stellarAddress: "GDI73WJ4SX7LOG3XZDJC3KCK6ED6E5NBYK2JUBQSPBCNNWEG3ZN7T75U",
  capabilities: [],
  status: "active",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  active: true,
  metadata: {},
};

async function startServer(opts?: { policyRules?: Partial<PolicyRules>; signer?: Signer; deferExecution?: boolean }) {
  const signer = opts?.signer ?? new MockSigner("test-agent");
  const server = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer,
    policyRules: opts?.policyRules,
    deferExecution: opts?.deferExecution,
    authProvider: new DevAuthProvider({ defaultOwnerId: "test" }),
  });
  server.registerAgent(TEST_AGENT);

  return new Promise<{
    baseUrl: string;
    close: () => Promise<void>;
    store: typeof server.store;
    approvals: typeof server.approvals;
  }>((resolve) => {
    const http = server.server.listen(0, "127.0.0.1", () => {
      const addr = http.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () => server.close(),
        store: server.store,
        approvals: server.approvals,
      });
    });
  });
}

async function post(baseUrl: string, path: string, body: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// ===== Approval flow lifecycle =====

test("approval: submit intent requiring approval → 202 pending_approval", async () => {
  const rules: Partial<PolicyRules> = {
    maxTxAmount: { XLM: "1000" },
    requireHumanApprovalForAmountAbove: "10",
  };
  const { baseUrl, close, store, approvals } = await startServer({ policyRules: rules });
  try {
    const res = await post(baseUrl, "/agents/test-agent/intents", {
      type: "payment",
      asset: "XLM",
      destination: Keypair.random().publicKey(),
      amount: "50",
      reason: "approval flow test",
    });
    assert.equal(res.status, 202);
    assert.equal(res.body.status, "requires_approval");
    assert.ok(res.body.approvalId, "approvalId must be returned");
    assert.ok(res.body.activityId, "activityId must be returned");

    // Activity persisted with requires_approval status
    const activity = await store.get(res.body.activityId);
    assert.ok(activity);
    assert.equal(activity!.status, "requires_approval");
    assert.equal(activity!.authorizationStatus, "pending_approval");

    // Approval persisted
    const approval = await approvals.get(res.body.approvalId);
    assert.ok(approval);
    assert.equal(approval!.status, "pending_approval");
  } finally {
    await close();
  }
});

test("approval: approve valid approval → 200 approved (async execution)", async () => {
  // NOTE: approve endpoint marks the approval as "approved" and kicks off
  // execution asynchronously. The HTTP response returns "approved" immediately.
  const rules: Partial<PolicyRules> = {
    maxTxAmount: { XLM: "1000" },
    requireHumanApprovalForAmountAbove: "10",
  };
  const { baseUrl, close, approvals } = await startServer({ policyRules: rules, deferExecution: true });
  try {
    const intentRes = await post(baseUrl, "/agents/test-agent/intents", {
      type: "payment",
      asset: "XLM",
      destination: Keypair.random().publicKey(),
      amount: "50",
      reason: "approval approve test",
    });
    assert.equal(intentRes.status, 202);

    // Approve
    const approveRes = await post(baseUrl, `/approvals/${intentRes.body.approvalId}/approve`, { approver: "tester" });
    assert.equal(approveRes.status, 200);
    assert.equal(approveRes.body.status, "approved");
    assert.ok(approveRes.body.message.includes("queued"));

    // Verify approval persisted as approved
    const approval = await approvals.get(intentRes.body.approvalId);
    assert.ok(approval);
    assert.equal(approval!.status, "approved");
    // Phase 28K-2: approver comes from authenticated identity (no client spoofing).
    // DevAuthProvider returns subject="dev-user", so approver is "dev-user".
    assert.equal(approval!.approver, "dev-user");
    assert.ok(approval!.approvedAt);
  } finally {
    await close();
  }
});

test("approval: second approve is rejected (idempotent — no double submission)", async () => {
  const rules: Partial<PolicyRules> = {
    maxTxAmount: { XLM: "1000" },
    requireHumanApprovalForAmountAbove: "10",
  };
  const { baseUrl, close, approvals } = await startServer({ policyRules: rules, deferExecution: true });
  try {
    const intentRes = await post(baseUrl, "/agents/test-agent/intents", {
      type: "payment",
      asset: "XLM",
      destination: Keypair.random().publicKey(),
      amount: "50",
      reason: "double approve test",
    });

    // First approve → 200
    const firstApprove = await post(baseUrl, `/approvals/${intentRes.body.approvalId}/approve`, { approver: "tester1" });
    assert.equal(firstApprove.status, 200);

    // Second approve → 409 conflict (already approved, cannot approve again)
    const secondApprove = await post(baseUrl, `/approvals/${intentRes.body.approvalId}/approve`, { approver: "tester2" });
    assert.equal(secondApprove.status, 409);
    assert.match(secondApprove.body.message, /cannot approve/);

    // Verify still approved (not double-executed)
    const approval = await approvals.get(intentRes.body.approvalId);
    assert.equal(approval!.status, "approved");
  } finally {
    await close();
  }
});

test("approval: reject nonexistent approval → 404", async () => {
  const { baseUrl, close } = await startServer();
  try {
    const res = await post(baseUrl, "/approvals/nonexistent-id/approve", {});
    assert.equal(res.status, 404);
    assert.equal(res.body.status, "rejected");
    assert.match(res.body.message, /not found/);
  } finally {
    await close();
  }
});

test("approval: reject already-approved approval → 409", async () => {
  const rules: Partial<PolicyRules> = {
    maxTxAmount: { XLM: "1000" },
    requireHumanApprovalForAmountAbove: "10",
  };
  const { baseUrl, close } = await startServer({ policyRules: rules, deferExecution: true });
  try {
    const intentRes = await post(baseUrl, "/agents/test-agent/intents", {
      type: "payment",
      asset: "XLM",
      destination: Keypair.random().publicKey(),
      amount: "50",
      reason: "approve then reject test",
    });

    // Approve first
    const approve = await post(baseUrl, `/approvals/${intentRes.body.approvalId}/approve`, { approver: "tester" });
    assert.equal(approve.status, 200);

    // Now try to reject → must fail (409 conflict)
    const reject = await post(baseUrl, `/approvals/${intentRes.body.approvalId}/reject`, {});
    assert.equal(reject.status, 409);
    assert.match(reject.body.message, /cannot reject/);
  } finally {
    await close();
  }
});

test("approval: reject valid pending approval → 200 rejected", async () => {
  const rules: Partial<PolicyRules> = {
    maxTxAmount: { XLM: "1000" },
    requireHumanApprovalForAmountAbove: "10",
  };
  const { baseUrl, close, store, approvals } = await startServer({ policyRules: rules });
  try {
    const intentRes = await post(baseUrl, "/agents/test-agent/intents", {
      type: "payment",
      asset: "XLM",
      destination: Keypair.random().publicKey(),
      amount: "50",
      reason: "reject flow test",
    });
    assert.equal(intentRes.status, 202);

    const reject = await post(baseUrl, `/approvals/${intentRes.body.approvalId}/reject`, {});
    assert.equal(reject.status, 200);
    assert.equal(reject.body.status, "rejected");

    const approval = await approvals.get(intentRes.body.approvalId);
    assert.ok(approval);
    assert.equal(approval!.status, "rejected");
    assert.ok(approval!.rejectedAt);

    // #389: human-rejected approval records "denied_by_approver" on the activity,
    // distinct from policy denials ("denied_by_policy").
    const activity = await store.get(intentRes.body.activityId);
    assert.ok(activity);
    assert.equal(activity!.status, "rejected");
    assert.equal(activity!.authorizationStatus, "denied_by_approver");

    // Policy-denied intent still records "denied_by_policy"
    const deniedRes = await post(baseUrl, "/agents/test-agent/intents", {
      type: "payment",
      asset: "XLM",
      destination: Keypair.random().publicKey(),
      amount: "2000",
      reason: "policy deny check",
    });
    assert.equal(deniedRes.status, 403);
    assert.equal(deniedRes.body.authorizationStatus, "denied_by_policy");
  } finally {
    await close();
  }
});

test("approval: approve endpoint rejects raw XDR injection", async () => {
  const rules: Partial<PolicyRules> = {
    requireHumanApprovalForAmountAbove: "10",
  };
  const { baseUrl, close } = await startServer({ policyRules: rules, deferExecution: true });
  try {
    const intentRes = await post(baseUrl, "/agents/test-agent/intents", {
      type: "payment",
      asset: "XLM",
      destination: Keypair.random().publicKey(),
      amount: "50",
      reason: "xdr injection test",
    });
    assert.equal(intentRes.status, 202);

    const res = await post(baseUrl, `/approvals/${intentRes.body.approvalId}/approve`, {
      xdr: "AAAAAgAAAAA=",
    });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /raw XDR/);
  } finally {
    await close();
  }
});

test("approval: reject endpoint rejects raw XDR injection", async () => {
  const rules: Partial<PolicyRules> = {
    requireHumanApprovalForAmountAbove: "10",
  };
  const { baseUrl, close } = await startServer({ policyRules: rules, deferExecution: true });
  try {
    const intentRes = await post(baseUrl, "/agents/test-agent/intents", {
      type: "payment",
      asset: "XLM",
      destination: Keypair.random().publicKey(),
      amount: "50",
      reason: "xdr reject injection test",
    });
    assert.equal(intentRes.status, 202);

    const res = await post(baseUrl, `/approvals/${intentRes.body.approvalId}/reject`, {
      xdr: "AAAAAgAAAAA=",
    });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /raw XDR/);
  } finally {
    await close();
  }
});

test("approval: approve approval belonging to other agent — current impl allows (no cross-agent guard yet)", async () => {
  // LIMITATION: Phase 3 does not enforce cross-agent approval ownership.
  // A future phase will add agent-scoped approval access control.
  // This test documents the current behavior.
  const rules: Partial<PolicyRules> = {
    maxTxAmount: { XLM: "1000" },
    requireHumanApprovalForAmountAbove: "10",
  };
  const { baseUrl, close } = await startServer({ policyRules: rules, deferExecution: true });
  try {
    const intentRes = await post(baseUrl, "/agents/test-agent/intents", {
      type: "payment",
      asset: "XLM",
      destination: Keypair.random().publicKey(),
      amount: "50",
      reason: "cross-agent test",
    });
    assert.equal(intentRes.status, 202);

    // Anyone with the approvalId can approve — this is a known limitation
    const approve = await post(baseUrl, `/approvals/${intentRes.body.approvalId}/approve`, { approver: "anonymous" });
    assert.equal(approve.status, 200);
  } finally {
    await close();
  }
});

test("approval does not leak secrets in response", async () => {
  const rules: Partial<PolicyRules> = {
    requireHumanApprovalForAmountAbove: "10",
  };
  const { baseUrl, close } = await startServer({ policyRules: rules, deferExecution: true });
  try {
    const intentRes = await post(baseUrl, "/agents/test-agent/intents", {
      type: "payment",
      asset: "XLM",
      destination: Keypair.random().publicKey(),
      amount: "50",
      reason: "check privacy",
    });
    const approveRes = await post(baseUrl, `/approvals/${intentRes.body.approvalId}/approve`, { approver: "tester" });
    const json = JSON.stringify(intentRes) + JSON.stringify(approveRes);
    assert.ok(!/secret|seed|private_key|mnemonic|keypair/i.test(json));
  } finally {
    await close();
  }
});

// ===== #372: concurrent approve/reject — atomic claim via updateIfStatus =====

async function startQueueServer(opts?: {
  policyRules?: Partial<PolicyRules>;
  approvalStore?: InMemoryApprovalStore;
  activityStore?: InMemoryActivityStore;
}) {
  const signer = new MockSigner("test-agent");
  const activityStore = opts?.activityStore ?? new InMemoryActivityStore();
  const approvalStore = opts?.approvalStore ?? new InMemoryApprovalStore();
  const executionStore = new InMemoryExecutionStore();
  const server = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer,
    policyRules: opts?.policyRules,
    authProvider: new DevAuthProvider({ defaultOwnerId: "test" }),
    activityStore,
    approvalStore,
    executionStore,
    executionQueue: { enabled: true, intervalMs: 60_000 },
  });
  server.registerAgent(TEST_AGENT);

  return new Promise<{
    baseUrl: string;
    close: () => Promise<void>;
    store: typeof server.store;
    approvals: typeof server.approvals;
    executionStore: InMemoryExecutionStore;
  }>((resolve) => {
    const http = server.server.listen(0, "127.0.0.1", () => {
      const addr = http.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () => server.close(),
        store: server.store,
        approvals: server.approvals,
        executionStore,
      });
    });
  });
}

async function pendingApprovalId(baseUrl: string): Promise<string> {
  const res = await post(baseUrl, "/agents/test-agent/intents", {
    type: "payment",
    asset: "XLM",
    destination: Keypair.random().publicKey(),
    amount: "50",
    reason: "concurrency test",
  });
  assert.equal(res.status, 202);
  return res.body.approvalId;
}

async function waitFor(fn: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

test("approval: concurrent approve+approve → 1x200 1x409, exactly one execution record", async () => {
  const rules: Partial<PolicyRules> = {
    maxTxAmount: { XLM: "1000" },
    requireHumanApprovalForAmountAbove: "10",
  };
  const { baseUrl, close, approvals, executionStore } = await startQueueServer({ policyRules: rules });
  try {
    const approvalId = await pendingApprovalId(baseUrl);
    const [first, second] = await Promise.all([
      post(baseUrl, `/approvals/${approvalId}/approve`, {}),
      post(baseUrl, `/approvals/${approvalId}/approve`, {}),
    ]);
    const statuses = [first.status, second.status].sort();
    assert.deepEqual(statuses, [200, 409]);
    // The loser is always a 409 with no side effects. Which 409 code it gets
    // depends on timing: APPROVAL_CONFLICT when its read lands before the
    // winner's atomic claim, APPROVAL_INVALID_STATE when it lands after.
    // The atomic claim itself is covered deterministically at the store level
    // (updateIfStatus tests in packages/database/test/store.test.ts).
    const loser = first.status === 409 ? first : second;
    assert.ok(loser.body.code === "APPROVAL_CONFLICT" || loser.body.code === "APPROVAL_INVALID_STATE");

    const approval = await approvals.get(approvalId);
    assert.equal(approval!.status, "approved");

    // Exactly one execution record for the winning approve (enqueue is
    // fire-and-forget, so poll briefly).
    await waitFor(async () => {
      const records = await executionStore.listByAgent("test-agent");
      return records.filter((r) => r.approvalId === approvalId).length === 1;
    });
  } finally {
    await close();
  }
});

test("approval: concurrent approve+reject → 1x200 1x409, loser creates nothing", async () => {
  const rules: Partial<PolicyRules> = {
    maxTxAmount: { XLM: "1000" },
    requireHumanApprovalForAmountAbove: "10",
  };
  const { baseUrl, close, approvals, executionStore, store } = await startQueueServer({ policyRules: rules });
  try {
    const approvalId = await pendingApprovalId(baseUrl);
    const [approveRes, rejectRes] = await Promise.all([
      post(baseUrl, `/approvals/${approvalId}/approve`, {}),
      post(baseUrl, `/approvals/${approvalId}/reject`, {}),
    ]);
    const statuses = [approveRes.status, rejectRes.status].sort();
    assert.deepEqual(statuses, [200, 409]);
    // Same timing note as the approve+approve test: the loser is always a
    // 409; the exact code depends on whether its read lands before or after
    // the winner's atomic claim.
    const loser = approveRes.status === 409 ? approveRes : rejectRes;
    assert.ok(loser.body.code === "APPROVAL_CONFLICT" || loser.body.code === "APPROVAL_INVALID_STATE");

    const approval = await approvals.get(approvalId);
    assert.ok(approval!.status === "approved" || approval!.status === "rejected");
    // Reject winning means no execution record at all; approve winning means
    // exactly one. Either way there is never a second record or a
    // rejected-then-executed approval.
    const expectedRecords = approval!.status === "approved" ? 1 : 0;
    await waitFor(async () => {
      const records = await executionStore.listByAgent("test-agent");
      return records.filter((r) => r.approvalId === approvalId).length === expectedRecords;
    });
    if (approval!.status === "rejected") {
      const activity = await store.get(approval!.activityId);
      assert.equal(activity!.status, "rejected");
    }
  } finally {
    await close();
  }
});

test("approval: sequential approve after reject stays APPROVAL_INVALID_STATE", async () => {
  const rules: Partial<PolicyRules> = {
    maxTxAmount: { XLM: "1000" },
    requireHumanApprovalForAmountAbove: "10",
  };
  const { baseUrl, close, approvals } = await startServer({ policyRules: rules, deferExecution: true });
  try {
    const approvalId = await pendingApprovalId(baseUrl);
    const rejected = await post(baseUrl, `/approvals/${approvalId}/reject`, {});
    assert.equal(rejected.status, 200);

    const lateApprove = await post(baseUrl, `/approvals/${approvalId}/approve`, {});
    assert.equal(lateApprove.status, 409);
    assert.equal(lateApprove.body.code, "APPROVAL_INVALID_STATE");
    assert.match(lateApprove.body.message, /cannot approve/);
    assert.equal((await approvals.get(approvalId))!.status, "rejected");
  } finally {
    await close();
  }
});

// ===== #376: startup recovery of a stale `executing` approval =====

test("approval-recovery: stale executing approval is failed at server startup", async () => {
  const activityStore = new InMemoryActivityStore();
  const approvalStore = new InMemoryApprovalStore();
  const activity = createActivity("test-agent", "test", {
    type: "payment",
    asset: "XLM",
    destination: Keypair.random().publicKey(),
    amount: "50",
    reason: "recovery startup test",
  } as any, { result: "requires_approval", reason: "Requires human approval", rule: "approvalThreshold", intent: null as any });
  activity.status = "requires_approval";
  activity.authorizationStatus = "pending_approval";
  await activityStore.record(activity);

  const approval = createApproval(activity.id, "test-agent", "test", activity.intent, activity.policyDecision, null);
  approval.status = "executing";
  // Stale: last touched 10 minutes ago, no hash recorded (crash before submit).
  approval.updatedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  await approvalStore.record(approval);

  const { close } = await startQueueServer({ approvalStore, activityStore });
  try {
    const saved = await approvalStore.get(approval.id);
    assert.equal(saved?.status, "failed");
    assert.match(saved?.error ?? "", /no recorded transaction hash/);
    assert.equal((await activityStore.get(activity.id))?.status, "failed");
  } finally {
    await close();
  }
});

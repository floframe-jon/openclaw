import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WorkboardSourceBinding, WorkboardWorkspace } from "@openclaw/workboard-contract";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { workboardSqliteBackendEntrypoint } from "./sqlite-backend-entrypoint.test-support.js";
import { createWorkboardSqliteStores } from "./sqlite-store.js";
import { executionAuthority, WorkboardStore, type WorkboardVerifyCheckout } from "./store.js";

describe("exact Workboard execution fences", () => {
  let dir: string;
  let repoRoot: string;
  let a: WorkboardSourceBinding;
  let b: WorkboardSourceBinding;
  let store: WorkboardStore;
  let host: WorkboardStore;
  let verificationHook: (() => Promise<void>) | undefined;

  function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  }

  const verifyCheckout: WorkboardVerifyCheckout = async (input) => {
    await verificationHook?.();
    const actualPath = fs.realpathSync(input.path);
    const commonDir = fs.realpathSync(
      git(actualPath, "rev-parse", "--path-format=absolute", "--git-common-dir"),
    );
    const headCommit = git(actualPath, "rev-parse", "HEAD");
    if (
      git(actualPath, "status", "--porcelain", "--untracked-files=all") ||
      headCommit !== input.checkoutCommit
    ) {
      throw new Error("exact checkout is dirty or has the wrong revision");
    }
    return {
      path: actualPath,
      repoRoot,
      commonDir,
      repoFingerprint: createHash("sha256").update(commonDir).digest("hex"),
      headCommit,
    };
  };

  beforeAll(async () => {
    // openclaw-temp-dir: allow SQLite and Git ownership close before removing fixture files.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-exact-store-"));
    repoRoot = fs.realpathSync(dir);
    git(repoRoot, "init", "-b", "main");
    git(repoRoot, "config", "user.email", "workboard@example.test");
    git(repoRoot, "config", "user.name", "Workboard fixture");
    fs.writeFileSync(path.join(repoRoot, "sentinel"), "A\n");
    git(repoRoot, "add", "sentinel");
    git(repoRoot, "commit", "-m", "A");
    const commitA = git(repoRoot, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(repoRoot, "sentinel"), "B\n");
    git(repoRoot, "commit", "-am", "B");
    const commitB = git(repoRoot, "rev-parse", "HEAD");
    for (const [name, commit] of [
      ["checkout-a", commitA],
      ["checkout-b", commitB],
    ]) {
      const checkoutPath = path.join(repoRoot, name);
      git(repoRoot, "worktree", "add", "--detach", checkoutPath, commit);
    }
    const binding = async (
      name: string,
      checkoutCommit: string,
    ): Promise<WorkboardSourceBinding> => {
      const actual = await verifyCheckout({
        path: path.join(repoRoot, name),
        repoRoot,
        checkoutCommit,
      });
      return {
        path: actual.path,
        repoRoot,
        commonDir: actual.commonDir,
        repoFingerprint: actual.repoFingerprint,
        checkoutCommit,
      };
    };
    a = await binding("checkout-a", commitA);
    b = await binding("checkout-b", commitB);
    const workerModuleUrl = resolveRuntimeWorkerUrl(workboardSqliteBackendEntrypoint);
    const dbPath = path.join(repoRoot, "workboard.sqlite");
    const stores = createWorkboardSqliteStores({ dbPath, workerModuleUrl });
    const hostStores = createWorkboardSqliteStores({ dbPath, workerModuleUrl });
    store = new WorkboardStore(stores.cards, { ...stores, verifyCheckout });
    host = new WorkboardStore(hostStores.cards, { ...hostStores, verifyCheckout });
    await Promise.all([store.ready(), host.ready()]);
  });

  afterAll(async () => {
    await Promise.all([store?.close(), host?.close()]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function workspace(source: WorkboardSourceBinding): WorkboardWorkspace {
    return { kind: "dir", path: source.path, repoRoot, checkoutCommit: source.checkoutCommit };
  }

  async function attempt(source = a) {
    const card = await store.create({
      title: "Exact review",
      status: "ready",
      workspace: workspace(source),
      workspaceAccess: { unrestricted: true },
    });
    const claimed = await store.claim(card.id, { ownerId: `worker:${card.id}` });
    const prepared = await store.prepareExecutionLaunch(card.id, {
      requestedSessionKey: `subagent:${card.id}`,
      now: Date.now(),
      scope: { token: claimed.token },
      expectedAuthority: executionAuthority(claimed.card),
      source,
    });
    return { ...prepared, token: claimed.token };
  }

  it("accepts clean source only with the current token and preserves the source on lifecycle adoption", async () => {
    const prepared = await attempt();
    await expect(
      store.complete(prepared.card.id, { ownerId: prepared.card.metadata?.claim?.ownerId }),
    ).rejects.toThrow("current claim token");
    await expect(store.update(prepared.card.id, { status: "done" })).rejects.toThrow(
      "verified workboard_complete",
    );
    await store.syncLifecycle(prepared.card.id, {
      targetStatus: "done",
      executionStatus: "done",
      sourceUpdatedAt: Date.now(),
      stale: undefined,
      now: Date.now(),
      association: {
        expectedSessionKey: prepared.launch.requestedSessionKey,
        expectedRunId: prepared.launch.provisionalRunId,
        sessionKey: `agent:worker:${prepared.launch.requestedSessionKey}`,
        runId: "accepted-run",
        acceptedAt: Date.now(),
      },
    });
    const synced = await store.get(prepared.card.id);
    expect(synced?.status).toBe("running");
    expect(synced?.execution?.source).toEqual(a);
    const completed = await store.complete(prepared.card.id, {
      token: prepared.token,
      summary: "Verified A",
      proof: { status: "passed", note: a.checkoutCommit },
    });
    expect(completed.status).toBe("done");
    expect(completed.execution?.source).toEqual(a);
    expect(completed.metadata?.claim).toBeUndefined();
  });

  it("rejects dirty reviewed source and leaves the attempt recoverable", async () => {
    const prepared = await attempt();
    fs.writeFileSync(path.join(a.path, "sentinel"), "changed after review\n");
    try {
      await expect(store.complete(prepared.card.id, { token: prepared.token })).rejects.toThrow(
        "dirty",
      );
      expect((await store.get(prepared.card.id))?.metadata?.claim?.token).toBe(prepared.token);
    } finally {
      fs.writeFileSync(path.join(a.path, "sentinel"), "A\n");
    }
  });

  it("fences completion against a foreign card update during source verification", async () => {
    const prepared = await attempt();
    const entered = createDeferred<void>();
    const resume = createDeferred<void>();
    verificationHook = async () => {
      entered.resolve();
      await resume.promise;
    };
    const completing = store.complete(prepared.card.id, {
      token: prepared.token,
      proof: { status: "passed" },
    });
    try {
      await entered.promise;
      await host.update(prepared.card.id, { notes: "Changed during completion" });
      resume.resolve();
      await expect(completing).rejects.toThrow("Card changed");
      expect((await host.get(prepared.card.id))?.status).toBe("running");
    } finally {
      verificationHook = undefined;
      resume.resolve();
    }
  });

  it("rejects a stale A token after native reclaim and B rebinding", async () => {
    const first = await attempt();
    await store.reclaim(first.card.id, { token: first.token });
    await store.update(first.card.id, { workspace: workspace(b) });
    const claimed = await store.claim(first.card.id, { ownerId: `worker:${first.card.id}` });
    const next = await store.prepareExecutionLaunch(first.card.id, {
      requestedSessionKey: `subagent:${first.card.id}`,
      now: Date.now(),
      scope: { token: claimed.token },
      expectedAuthority: executionAuthority(claimed.card),
      source: b,
    });
    await expect(store.complete(first.card.id, { token: first.token })).rejects.toThrow();
    expect((await store.get(first.card.id))?.execution?.runId).toBe(next.card.execution?.runId);
    expect((await store.get(first.card.id))?.metadata?.claim?.token).toBe(claimed.token);
    expect(
      (
        await store.complete(first.card.id, {
          token: claimed.token,
          proof: { status: "passed", label: "B review" },
        })
      ).execution?.source,
    ).toEqual(b);
  });

  it.each(["done", "blocked"] as const)("allows a new B attempt after A is %s", async (status) => {
    const first = await attempt();
    if (status === "done") {
      await store.complete(first.card.id, {
        token: first.token,
        proof: { status: "passed", label: "A review" },
      });
      await store.update(first.card.id, { status: "ready" });
    } else {
      await store.block(first.card.id, {
        token: first.token,
        reason: "Recoverable review failure",
      });
      await store.unblock(first.card.id);
    }
    await store.update(first.card.id, { workspace: workspace(b) });
    const claimed = await store.claim(first.card.id, { ownerId: `worker:${first.card.id}` });
    const next = await store.prepareExecutionLaunch(first.card.id, {
      requestedSessionKey: `subagent:${first.card.id}`,
      now: Date.now(),
      scope: { token: claimed.token },
      expectedAuthority: executionAuthority(claimed.card),
      source: b,
    });
    expect(next.card.execution?.source).toEqual(b);
    expect(
      (
        await store.complete(first.card.id, {
          token: claimed.token,
          proof: { status: "passed", label: "B review" },
        })
      ).execution?.source,
    ).toEqual(b);
  });

  it("requires fresh attempt proof and retains distinct A and B review evidence", async () => {
    await expect(
      store.create({ title: "Unverified import", status: "done", workspace: workspace(a) }),
    ).rejects.toThrow("verified workboard_complete");
    const first = await attempt();
    await expect(store.complete(first.card.id, { token: first.token })).rejects.toThrow(
      "fresh proof",
    );
    await expect(
      store.complete(first.card.id, { token: first.token, proof: { status: "unknown" } }),
    ).rejects.toThrow("known result");
    const completedA = await store.complete(first.card.id, {
      token: first.token,
      proof: { status: "passed", label: "A review" },
    });
    const proofA = completedA.metadata?.proof?.at(-1);
    expect(proofA).toBeDefined();
    await store.update(first.card.id, { status: "ready", workspace: workspace(b) });
    const claimed = await store.claim(first.card.id, { ownerId: `worker:${first.card.id}` });
    const next = await store.prepareExecutionLaunch(first.card.id, {
      requestedSessionKey: `subagent:${first.card.id}`,
      now: Date.now(),
      scope: { token: claimed.token },
      expectedAuthority: executionAuthority(claimed.card),
      source: b,
    });
    await expect(
      store.complete(first.card.id, { token: claimed.token, proofId: proofA?.id }),
    ).rejects.toThrow("earlier attempt");
    const withProof = await store.addProof(
      first.card.id,
      { status: "passed", label: "B review" },
      { token: claimed.token },
    );
    const proofB = withProof.metadata?.proof?.at(-1);
    const completedB = await store.complete(first.card.id, {
      token: claimed.token,
      proofId: proofB?.id,
    });
    expect(completedB.metadata?.automation?.reviewEvidence).toEqual([
      expect.objectContaining({
        attemptId: first.card.execution?.runId,
        proofId: proofA?.id,
        status: "passed",
        source: a,
      }),
      expect.objectContaining({
        attemptId: next.card.execution?.runId,
        proofId: proofB?.id,
        status: "passed",
        source: b,
      }),
    ]);
  });

  it("keeps reviewed source bound until the current claim completes or is reclaimed", async () => {
    const prepared = await attempt();
    await store.syncLifecycle(prepared.card.id, {
      targetStatus: "review",
      executionStatus: "review",
      sourceUpdatedAt: Date.now(),
      stale: undefined,
      now: Date.now(),
    });
    await expect(host.update(prepared.card.id, { workspace: workspace(b) })).rejects.toThrow(
      "authority changed",
    );
    await store.reclaim(prepared.card.id, { token: prepared.token, status: "ready" });
    await store.update(prepared.card.id, { workspace: workspace(b) });
    const claimed = await store.claim(prepared.card.id, { ownerId: `worker:${prepared.card.id}` });
    expect(claimed.card.execution).toBeUndefined();
    expect(claimed.card.runId).toBeUndefined();
  });

  it("refuses changed preparation authority, duplicate prepared launches, and expired claims", async () => {
    const card = await store.create({
      title: "Captured candidate",
      status: "ready",
      workspace: workspace(a),
    });
    const claimed = await store.claim(card.id, { ownerId: `worker:${card.id}` });
    await host.update(card.id, { workspace: workspace(b) });
    await expect(
      store.bindExecutionWorkspace(card.id, {
        scope: { token: claimed.token },
        expectedAuthority: executionAuthority(claimed.card),
        workspace: workspace(a),
        workspaceAccess: { unrestricted: true },
      }),
    ).rejects.toThrow("authority changed");
    const prepared = await attempt();
    await expect(host.update(prepared.card.id, { workspace: workspace(b) })).rejects.toThrow(
      "authority changed",
    );
    await expect(
      store.prepareExecutionLaunch(prepared.card.id, {
        requestedSessionKey: "duplicate",
        now: Date.now(),
        scope: { token: prepared.token },
        source: a,
      }),
    ).rejects.toThrow("already has a prepared");
    await host.update(prepared.card.id, {
      metadata: { claim: { ...prepared.card.metadata?.claim, expiresAt: 1 } },
    });
    await expect(
      store.assertExecutionLaunchCurrent(prepared.card.id, {
        scope: { token: prepared.token },
        expectedAuthority: executionAuthority(prepared.card),
        expectedLaunch: prepared.launch,
      }),
    ).rejects.toThrow("expired");
    await expect(store.complete(prepared.card.id, { token: prepared.token })).rejects.toThrow(
      "expired",
    );
  });

  it("fences exact failure compensation against a replaced same-owner claim", async () => {
    const first = await attempt();
    const authority = executionAuthority(first.card);
    await store.releaseClaim(first.card.id, { token: first.token });
    const replacement = await host.claim(first.card.id, {
      ownerId: first.card.metadata?.claim?.ownerId,
    });
    const staleScope = { ownerId: first.card.metadata?.claim?.ownerId, token: first.token };
    await expect(
      store.block(first.card.id, { ...staleScope, reason: "Delayed failure" }, staleScope, {
        expectedAuthority: authority,
      }),
    ).rejects.toThrow("current claim token");
    await expect(
      store.failPreparedLaunch(first.card.id, {
        expectedLaunch: first.launch,
        reason: "Delayed prepared failure",
        failedAt: Date.now(),
        scope: staleScope,
        expectedAuthority: authority,
      }),
    ).rejects.toThrow("current claim token");
    const current = await host.get(first.card.id);
    expect(current?.metadata?.claim?.token).toBe(replacement.token);
    expect(current?.metadata?.automation?.launch).toEqual(first.launch);
    expect(current?.status).toBe("running");
    await expect(
      store.failPreparedLaunch(first.card.id, {
        expectedLaunch: first.launch,
        reason: "Current failure",
        failedAt: Date.now(),
        scope: { token: replacement.token },
        expectedAuthority: authority,
      }),
    ).resolves.toBe(true);
  });

  it("retains exact preparation across native store restart and reconciles to B without accepting A", async () => {
    const workerModuleUrl = resolveRuntimeWorkerUrl(workboardSqliteBackendEntrypoint);
    const dbPath = path.join(dir, "restart-workboard.sqlite");
    const open = () => {
      const stores = createWorkboardSqliteStores({ dbPath, workerModuleUrl });
      return new WorkboardStore(stores.cards, { ...stores, verifyCheckout });
    };
    const original = open();
    const observer = open();
    let resumed: WorkboardStore | undefined;
    try {
      await Promise.all([original.ready(), observer.ready()]);
      const card = await original.create({
        title: "Interrupted preparation",
        status: "ready",
        workspace: workspace(a),
        workspaceAccess: { unrestricted: true },
      });
      const claimedA = await original.claim(card.id, { ownerId: `restart-worker:${card.id}` });
      const preparedA = await original.prepareExecutionLaunch(card.id, {
        requestedSessionKey: `subagent:${card.id}`,
        now: Date.now(),
        scope: { token: claimedA.token },
        expectedAuthority: executionAuthority(claimedA.card),
        source: a,
      });
      expect((await observer.get(card.id))?.execution?.source).toEqual(a);
      // Join and close every native database owner for this fixture before reopening.
      await Promise.all([original.close(), observer.close()]);
      resumed = open();
      await resumed.ready();
      const persisted = await resumed.get(card.id);
      expect(persisted?.metadata?.claim?.token).toBe(claimedA.token);
      expect(persisted?.metadata?.automation?.launch).toEqual(preparedA.launch);
      expect(persisted?.execution?.source).toEqual(a);
      await expect(
        resumed.claim(card.id, { ownerId: `restart-worker:${card.id}` }),
      ).rejects.toThrow("already claimed");
      await expect(
        resumed.prepareExecutionLaunch(card.id, {
          requestedSessionKey: `subagent:${card.id}`,
          now: Date.now(),
          scope: { token: claimedA.token },
          expectedAuthority: executionAuthority(preparedA.card),
          source: a,
        }),
      ).rejects.toThrow("already has a prepared");
      await expect(resumed.update(card.id, { status: "done" })).rejects.toThrow(
        "verified workboard_complete",
      );
      await resumed.reclaim(card.id, {
        token: claimedA.token,
        status: "ready",
        reason: "Fixture preparation reconciled after restart",
      });
      await resumed.update(card.id, { workspace: workspace(b) });
      const claimedB = await resumed.claim(card.id, { ownerId: `restart-worker:${card.id}` });
      const bound = await resumed.bindExecutionWorkspace(card.id, {
        scope: { token: claimedB.token },
        expectedAuthority: executionAuthority(claimedB.card),
        workspace: workspace(b),
        workspaceAccess: { unrestricted: true },
      });
      const preparedB = await resumed.prepareExecutionLaunch(card.id, {
        requestedSessionKey: `subagent:${card.id}`,
        now: Date.now(),
        scope: { token: claimedB.token },
        expectedAuthority: executionAuthority(bound.after),
        source: b,
      });
      await expect(
        resumed.complete(card.id, {
          token: claimedA.token,
          ownerId: `restart-worker:${card.id}`,
          proof: { status: "passed", note: "Stale A" },
        }),
      ).rejects.toThrow("current claim token");
      const completed = await resumed.complete(card.id, {
        token: claimedB.token,
        proof: { status: "passed", note: "Fresh B after restart" },
      });
      expect(completed.status).toBe("done");
      expect(completed.metadata?.automation?.reviewEvidence).toEqual([
        expect.objectContaining({
          attemptId: preparedB.card.execution?.runId,
          source: b,
          status: "passed",
        }),
      ]);
      expect(git(a.path, "rev-parse", "HEAD")).toBe(a.checkoutCommit);
      expect(fs.readFileSync(path.join(a.path, "sentinel"), "utf8")).toBe("A\n");
    } finally {
      await Promise.all([original.close(), observer.close(), resumed?.close()]);
    }
  });

  it("preserves ordinary builder completion without a source binding or token", async () => {
    const card = await store.create({ title: "Ordinary resume", status: "running" });
    expect((await store.complete(card.id)).status).toBe("done");
  });
});

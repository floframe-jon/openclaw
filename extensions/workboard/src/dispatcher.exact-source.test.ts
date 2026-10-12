import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { WorkboardWorkspace } from "@openclaw/workboard-contract";
import { closeOpenClawStateDatabaseForTest } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { clearRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { managedWorktreeName } from "./dispatcher-workspace.js";
import { dispatchAndStartWorkboardCards, type WorkboardWorktreeRuntime } from "./dispatcher.js";
import { workboardSqliteBackendEntrypoint } from "./sqlite-backend-entrypoint.test-support.js";
import { createWorkboardSqliteStores } from "./sqlite-store.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

const execFileAsync = promisify(execFile);
async function git(cwd: string, ...args: string[]) {
  return (await execFileAsync("git", ["-C", cwd, ...args])).stdout.trim();
}

describe("native dispatcher exact source binding", () => {
  const templates = useAutoCleanupTempDirTracker(afterAll);
  const dirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async () => {
      await store?.close();
      for (const release of preparationReleases.splice(0)) {
        await release();
      }
      for (const record of createdRecords.values()) {
        await worktrees.release({ path: record.path });
      }
      closeOpenClawStateDatabaseForTest();
      clearRuntimeConfigSnapshot();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      cleanup();
    }),
  );
  let template: string;
  let repoRoot: string;
  let a: string;
  let b: string;
  let worktrees: WorkboardWorktreeRuntime;
  let store: ReturnType<typeof createWorkboardSqliteTestStore>;
  const createdRecords = new Map<
    string,
    Awaited<ReturnType<WorkboardWorktreeRuntime["create"]>> & { ownerId: string }
  >();
  const preparationReleases: Array<() => Promise<void>> = [];
  let afterCreate: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    template = templates.make("openclaw-dispatch-source-template-");
    const repo = path.join(template, "repo");
    await fs.mkdir(repo);
    await git(repo, "init", "-b", "main");
    await git(repo, "config", "user.name", "OpenClaw Test");
    await git(repo, "config", "user.email", "openclaw-test@example.invalid");
    await fs.writeFile(path.join(repo, "README.md"), "base\n");
    await git(repo, "add", "README.md");
    await git(repo, "commit", "-m", "candidate A");
    const remote = path.join(template, "remote.git");
    await git(template, "init", "--bare", remote);
    await git(repo, "remote", "add", "origin", remote);
    await git(repo, "push", "-u", "origin", "main");
  });

  beforeEach(async () => {
    createdRecords.clear();
    afterCreate = undefined;
    const dir = dirs.make("openclaw-dispatch-source-");
    await fs.cp(template, dir, { recursive: true });
    repoRoot = await fs.realpath(path.join(dir, "repo"));
    await git(repoRoot, "remote", "set-url", "origin", path.join(dir, "remote.git"));
    a = await git(repoRoot, "rev-parse", "HEAD");
    await fs.writeFile(path.join(repoRoot, "README.md"), "candidate B\n");
    await git(repoRoot, "commit", "-am", "candidate B");
    b = await git(repoRoot, "rev-parse", "HEAD");
    const configPath = path.join(dir, "openclaw.json");
    await fs.writeFile(configPath, JSON.stringify({ worktreeAcceleration: false }));
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(dir, "state"));
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    clearRuntimeConfigSnapshot();
    const fixture = createPluginRegistryFixture({ worktreeAcceleration: false });
    registerVirtualTestPlugin({
      ...fixture,
      id: "exact-native-workboard-fixture",
      name: "Exact native Workboard fixture",
      register(api) {
        const native = api.runtime.worktrees;
        worktrees = {
          ...native,
          async create(input) {
            // Every allocation, reuse, restore, and preparation lease is the
            // public native runtime operation. Record facts, never fabricate a checkout.
            const created = await native.create(input);
            createdRecords.set(created.id, { ...created, ownerId: input.ownerId });
            if (created.releasePreparation) {
              preparationReleases.push(created.releasePreparation);
            }
            try {
              await afterCreate?.();
              return created;
            } catch (error) {
              await created.releasePreparation?.();
              throw error;
            }
          },
        };
      },
    });
    const workerModuleUrl = resolveRuntimeWorkerUrl(workboardSqliteBackendEntrypoint);
    store = createWorkboardSqliteTestStore({
      createStores: (dbPath) => ({
        ...createWorkboardSqliteStores({ dbPath, workerModuleUrl }),
        verifyCheckout: worktrees.verifyCheckout,
      }),
    });
  });

  const workspace = (checkoutCommit: string): WorkboardWorkspace => ({
    kind: "worktree",
    path: repoRoot,
    repoRoot,
    checkoutCommit,
    branch: "main",
  });
  const dispatch = (run: ReturnType<typeof vi.fn>, options = {}) =>
    dispatchAndStartWorkboardCards({
      store,
      worktrees,
      subagent: { run },
      options: {
        materializeWorktree: true,
        workspaceAccess: { unrestricted: true },
        maxStarts: 2,
        ...options,
      },
    });

  it("launches fresh immutable B and retains source through completion", async () => {
    const card = await store.create({
      title: "exact B",
      agentId: "reviewer",
      status: "ready",
      workspace: workspace(b),
      workspaceAccess: { unrestricted: true },
    });
    const run = vi.fn(async ({ cwd }: { cwd: string }) => {
      expect(await git(cwd, "rev-parse", "HEAD")).toBe(b);
      expect(await fs.readFile(path.join(cwd, "README.md"), "utf8")).toBe("candidate B\n");
      return { runId: "review-b" };
    });
    expect((await dispatch(run)).started).toHaveLength(1);
    const actual = (await store.get(card.id))!;
    expect(actual.execution?.source).toMatchObject({
      checkoutCommit: b,
      path: run.mock.calls[0][0].cwd,
      repoRoot,
    });
    expect(actual.metadata?.automation?.launch).toMatchObject({
      phase: "accepted",
      source: { checkoutCommit: b },
    });
    await expect(
      store.complete(card.id, {
        token: actual.metadata?.claim?.token,
        summary: `PASS ${b}`,
        proof: { status: "passed", note: b },
      }),
    ).resolves.toMatchObject({ status: "done", execution: { source: { checkoutCommit: b } } });
  });

  it.each([false, true])(
    "rejects retained A for B, then recovers same card in isolated B (snapshot=%s)",
    async (snapshot) => {
      const card = await store.create({
        title: "reused review",
        agentId: "reviewer",
        status: "ready",
        workspace: workspace(a),
        workspaceAccess: { unrestricted: true },
      });
      const initialRun = vi.fn().mockResolvedValue({ runId: "review-a" });
      expect((await dispatch(initialRun)).started).toHaveLength(1);
      const initial = (await store.get(card.id))!;
      await store.complete(card.id, {
        token: initial.metadata?.claim?.token,
        proof: { status: "passed", note: a },
      });
      const retained = [...createdRecords.values()].find((record) => record.ownerId === card.id)!;
      if (snapshot) {
        expect(
          await worktrees.removeIfLossless({
            path: retained.path,
            ownerKind: "workboard",
            ownerId: card.id,
          }),
        ).toBe(true);
      }
      await store.update(card.id, { status: "ready", workspace: workspace(b) });
      const run = vi.fn().mockResolvedValue({ runId: "recovery-b" });
      const rejected = await dispatch(run);
      expect(rejected.started).toEqual([]);
      expect(rejected.startFailures).toEqual([
        expect.objectContaining({
          cardId: card.id,
          error: expect.stringContaining("revision mismatch"),
          source: expect.objectContaining({ checkoutCommit: b }),
        }),
      ]);
      expect(run).not.toHaveBeenCalled();
      if (snapshot) {
        await expect(fs.access(retained.path)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        expect(await git(retained.path, "rev-parse", "HEAD")).toBe(a);
      }
      const recoveryOwner = await store.create({
        title: "Recovery checkout holder",
        status: "backlog",
      });
      const isolated = await worktrees.create({
        repoRoot,
        name: "isolated-review-b",
        ownerKind: "workboard",
        ownerId: recoveryOwner.id,
        checkoutCommit: b,
        requireExactSource: true,
      });
      await store.update(card.id, {
        workspace: { kind: "dir", path: isolated.path, repoRoot, checkoutCommit: b },
      });
      await store.unblock(card.id);
      await store.promote(card.id);
      const recovered = await dispatch(run);
      expect(recovered.started).toHaveLength(1);
      expect(run).toHaveBeenCalledOnce();
      expect(run.mock.calls[0][0].cwd).toBe(isolated.path);
      const current = (await store.get(card.id))!;
      await expect(
        store.complete(card.id, {
          token: current.metadata?.claim?.token,
          proof: { status: "passed", note: b },
        }),
      ).resolves.toMatchObject({ status: "done", execution: { source: { checkoutCommit: b } } });
      const evidence = (await store.get(card.id))?.metadata?.automation?.reviewEvidence;
      expect(evidence?.map((entry) => entry.source.checkoutCommit)).toEqual([a, b]);
      expect(evidence?.map((entry) => entry.attemptId)).toEqual(["review-a", "recovery-b"]);
      if (snapshot) {
        const restored = await worktrees.create({
          repoRoot,
          name: managedWorktreeName(card.id),
          ownerKind: "workboard",
          ownerId: card.id,
          checkoutCommit: a,
          requireExactSource: true,
        });
        try {
          expect(restored.id).toBe(retained.id);
          expect(restored.path).toBe(retained.path);
          expect(await git(restored.path, "rev-parse", "HEAD")).toBe(a);
        } finally {
          await restored.releasePreparation?.();
        }
      } else {
        expect(await git(retained.path, "rev-parse", "HEAD")).toBe(a);
      }
    },
  );

  it("reuses correct A and admits only one simultaneous worker", async () => {
    const card = await store.create({
      title: "same exact A",
      agentId: "reviewer",
      status: "ready",
      workspace: workspace(a),
      workspaceAccess: { unrestricted: true },
    });
    const retained = await worktrees.create({
      repoRoot,
      name: managedWorktreeName(card.id),
      ownerKind: "workboard",
      ownerId: card.id,
      checkoutCommit: a,
      requireExactSource: true,
    });
    const run = vi.fn().mockResolvedValue({ runId: "same-a" });
    const results = await Promise.all([dispatch(run), dispatch(run)]);
    expect(results.flatMap((result) => result.started)).toHaveLength(1);
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0][0].cwd).toBe(retained.path);
  });

  it("rejects candidate mutation during materialization without overwriting the new binding", async () => {
    const card = await store.create({
      title: "moving candidate",
      status: "ready",
      workspace: workspace(a),
      workspaceAccess: { unrestricted: true },
    });
    afterCreate = async () => {
      await store.update(card.id, { workspace: workspace(b) });
    };
    const run = vi.fn();
    const result = await dispatch(run);
    expect(result.started).toEqual([]);
    expect(run).not.toHaveBeenCalled();
    expect((await store.get(card.id))?.metadata?.automation?.workspace?.checkoutCommit).toBe(b);
    expect(await git([...createdRecords.values()][0].path, "rev-parse", "HEAD")).toBe(a);
  });

  it("claim expiry during materialization prevents launch and preserves source", async () => {
    const card = await store.create({
      title: "expired review",
      status: "ready",
      workspace: workspace(a),
      workspaceAccess: { unrestricted: true },
    });
    afterCreate = async () => {
      const current = (await store.get(card.id))!;
      await store.update(card.id, {
        metadata: { claim: { ...current.metadata?.claim, expiresAt: Date.now() - 1 } },
      });
    };
    const run = vi.fn();
    expect((await dispatch(run)).started).toEqual([]);
    expect(run).not.toHaveBeenCalled();
    expect(await git([...createdRecords.values()][0].path, "rev-parse", "HEAD")).toBe(a);
  });

  it("failed worker launch preserves the exact checkout and supports native retry", async () => {
    const card = await store.create({
      title: "retry launch",
      agentId: "reviewer",
      status: "ready",
      workspace: workspace(b),
      workspaceAccess: { unrestricted: true },
    });
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("worker cancelled before start"))
      .mockResolvedValue({ runId: "retry-b" });
    expect((await dispatch(run)).started).toEqual([]);
    const preserved = [...createdRecords.values()][0];
    expect(await git(preserved.path, "rev-parse", "HEAD")).toBe(b);
    const registrations = await git(repoRoot, "worktree", "list", "--porcelain");
    const registeredCheckout = registrations
      .split("\n\n")
      .find((entry) => entry.includes(`worktree ${preserved.path}\n`));
    expect(registeredCheckout).toBeDefined();
    expect(registeredCheckout).not.toMatch(/(?:^|\n)locked(?: |$)/u);
    await store.unblock(card.id);
    await store.promote(card.id);
    expect((await dispatch(run)).started).toHaveLength(1);
    expect(run.mock.calls[1][0].cwd).toBe(preserved.path);
  });

  it.each(["dir", "worktree"] as const)(
    "checks restricted %s source without materializing forbidden worktrees",
    async (kind) => {
      const access = { unrestricted: false as const, roots: [repoRoot], writable: true };
      const card = await store.create({
        title: "restricted source",
        status: "ready",
        workspace: { kind, path: repoRoot, repoRoot, checkoutCommit: a },
        workspaceAccess: access,
      });
      const create = vi.spyOn(worktrees, "create");
      const run = vi.fn().mockResolvedValue({ runId: "restricted-b" });
      const options = {
        resolveAgentWorkspaceRuntime: () => ({ sandboxed: true, workspaceAccess: access }),
      };
      const result = await dispatch(run, options);
      expect(result.started).toEqual([]);
      expect(result.startFailures[0]?.error).toContain("revision mismatch");
      expect(run).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      await store.update(card.id, {
        workspace: { kind, path: repoRoot, repoRoot, checkoutCommit: b },
      });
      await store.unblock(card.id);
      await store.promote(card.id);
      expect((await dispatch(run, options)).started).toHaveLength(1);
      expect(run.mock.calls[0][0].cwd).toBe(repoRoot);
      expect(create).not.toHaveBeenCalled();
    },
  );

  it("one mismatch does not block an unrelated healthy exact card", async () => {
    const first = await store.create({
      title: "wrong source",
      priority: "urgent",
      agentId: "one",
      status: "ready",
      workspace: workspace(b),
      workspaceAccess: { unrestricted: true },
    });
    await worktrees.create({
      repoRoot,
      name: managedWorktreeName(first.id),
      ownerKind: "workboard",
      ownerId: first.id,
      checkoutCommit: a,
      requireExactSource: true,
    });
    const healthy = await store.create({
      title: "healthy",
      agentId: "two",
      status: "ready",
      workspace: workspace(b),
      workspaceAccess: { unrestricted: true },
    });
    const run = vi.fn().mockResolvedValue({ runId: "healthy-b" });
    const result = await dispatch(run);
    expect(result.startFailures.map((failure) => failure.cardId)).toEqual([first.id]);
    expect(result.started.map((started) => started.cardId)).toEqual([healthy.id]);
    expect(run).toHaveBeenCalledOnce();
  });
});

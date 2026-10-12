import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { lockState } from "../../agents/worktrees/git-lock.js";
import * as runLeases from "../../agents/worktrees/run-lease.js";
import { testing as runLeaseTesting } from "../../agents/worktrees/run-lease.test-support.js";
import { ManagedWorktreeService, managedWorktrees } from "../../agents/worktrees/service.js";
import { useManagedWorktreeTestRepository } from "../../agents/worktrees/service.test-support.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { createPluginRuntime } from "./index.js";

const execFileAsync = promisify(execFile);

describe("native exact Workboard preparation lease", () => {
  const initializeRepository = useManagedWorktreeTestRepository();
  const ownedReleases: Array<() => Promise<void>> = [];
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async () => {
      for (const release of ownedReleases.splice(0)) {
        await release();
      }
      // Original raw acquire has no tokened release; retire that test-owned
      // guard too when reproducing the pre-fix facade behavior.
      for (const record of await service.list()) {
        await service.releaseByPath(record.path);
      }
      await closeOpenClawStateDatabaseAsync();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      runLeaseTesting.resetForTest();
      cleanup();
    }),
  );
  let repo: string;
  let env: NodeJS.ProcessEnv;
  let commit: string;
  let service: ManagedWorktreeService;

  beforeEach(async () => {
    const root = tempDirs.make("openclaw-preparation-lease-");
    repo = await initializeRepository(root);
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
    env = { ...process.env };
    service = new ManagedWorktreeService({
      env,
      getConfig: () => ({ worktreeAcceleration: false }),
    });
    commit = (await execFileAsync("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
    // The actual runtime facade still owns lease admission. This fixture only
    // supplies its real native service with an isolated state/configuration.
    vi.spyOn(managedWorktrees, "create").mockImplementation((params) => service.create(params));
  });

  function request() {
    return {
      repoRoot: repo,
      name: "card-c",
      checkoutCommit: commit,
      requireExactSource: true,
      ownerKind: "workboard" as const,
      ownerId: "card-c",
    };
  }

  it("releases failed-start preparation while preserving another native holder", async () => {
    const record = await service.create(request());
    const workerLease = await runLeases.acquireWorktreeRunLease(record.id, { env });
    ownedReleases.push(workerLease.release);
    const preparation = await createPluginRuntime().worktrees.create(request());
    expect(preparation.releasePreparation).toBeTypeOf("function");
    if (!preparation.releasePreparation) {
      throw new Error("preparation lease release is missing");
    }
    ownedReleases.push(preparation.releasePreparation);
    await preparation.releasePreparation();
    await preparation.releasePreparation();
    expect(runLeases.hasLiveWorktreeRunLease(env, record.id)).toBe(true);
    expect((await lockState(record)).kind).toBe("live");
    await expect(
      service.remove({ id: record.id, reason: "failed worker launch fixture" }),
    ).rejects.toThrow("busy");
    await workerLease.release();
    expect(runLeases.hasLiveWorktreeRunLease(env, record.id)).toBe(false);
    expect((await lockState(record)).kind).toBe("none");
  });

  it("drops its owned preparation lease after authority expires during admission", async () => {
    let expired = false;
    const acquire = runLeases.acquireWorktreeRunLease;
    vi.spyOn(runLeases, "acquireWorktreeRunLease").mockImplementation(async (...args) => {
      const lease = await acquire(...args);
      ownedReleases.push(lease.release);
      expired = true;
      return lease;
    });
    await expect(
      createPluginRuntime().worktrees.create({
        ...request(),
        commitGuard: () => {
          if (expired) {
            throw new Error("preparation authority expired");
          }
        },
      }),
    ).rejects.toThrow("preparation authority expired");
    const record = service.findLiveByOwner("workboard", "card-c");
    expect(record).toBeDefined();
    if (!record) {
      throw new Error("retained preparation source is missing");
    }
    expect(runLeases.hasLiveWorktreeRunLease(env, record.id)).toBe(false);
    expect((await lockState(record)).kind).toBe("none");
  });

  it("preserves ordinary raw acquire and release behavior", async () => {
    const ordinary = { ...request(), requireExactSource: undefined };
    const record = await createPluginRuntime().worktrees.create(ordinary);
    expect(record.releasePreparation).toBeUndefined();
    const persisted = service.findLiveByOwner("workboard", "card-c");
    expect(persisted).toBeDefined();
    if (!persisted) {
      throw new Error("ordinary source is missing");
    }
    expect((await lockState(persisted)).kind).toBe("live");
    await createPluginRuntime().worktrees.release({ path: record.path });
    expect((await lockState(persisted)).kind).toBe("none");
  });
});

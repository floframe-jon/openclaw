import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import * as gitOperations from "./git.js";
import { ManagedWorktreeService } from "./service.js";
import { useManagedWorktreeTestRepository } from "./service.test-support.js";

const execFileAsync = promisify(execFile);
async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", ["-C", cwd, ...args])).stdout.trim();
}

describe("managed worktree exact source binding", () => {
  const initializeRepository = useManagedWorktreeTestRepository();
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async () => {
      vi.restoreAllMocks();
      await closeOpenClawStateDatabaseAsync();
      cleanup();
    }),
  );
  let repo: string;
  let service: ManagedWorktreeService;
  let a: string;
  let b: string;

  beforeEach(async () => {
    const root = tempDirs.make("openclaw-exact-source-");
    repo = await initializeRepository(root);
    a = await git(repo, "rev-parse", "HEAD");
    await fs.writeFile(path.join(repo, "README.md"), "candidate B\n");
    await git(repo, "add", "README.md");
    await git(repo, "commit", "-m", "candidate B");
    b = await git(repo, "rev-parse", "HEAD");
    service = new ManagedWorktreeService({
      env: { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") },
      getConfig: () => ({ worktreeAcceleration: false }),
    });
  });

  it.each([true, false])("rejects retained A requested as B (owner=%s)", async (owner) => {
    const binding = {
      repoRoot: repo,
      name: "same-card",
      ...(owner ? { ownerKind: "workboard" as const, ownerId: "card-c" } : {}),
    };
    const retained = await service.create({
      ...binding,
      baseRef: a,
      requireExactSource: true,
      checkoutCommit: a,
    });
    await expect(
      service.create({ ...binding, baseRef: b, requireExactSource: true, checkoutCommit: b }),
    ).rejects.toMatchObject({
      name: "WorktreeSourceMismatchError",
      details: {
        reason: "revision",
        expectedCommit: b,
        actualCommit: a,
        recovery: "isolated-workspace",
      },
    });
    expect(await git(retained.path, "rev-parse", "HEAD")).toBe(a);
    expect(await fs.readFile(path.join(retained.path, "README.md"), "utf8")).toBe("base\n");
    expect(
      (await service.create({ ...binding, requireExactSource: true, checkoutCommit: a })).id,
    ).toBe(retained.id);
  });

  it("rejects snapshot A requested as B before restoring it", async () => {
    const binding = {
      repoRoot: repo,
      name: "same-card",
      ownerKind: "workboard" as const,
      ownerId: "card-c",
    };
    const retained = await service.create({
      ...binding,
      baseRef: a,
      requireExactSource: true,
      checkoutCommit: a,
    });
    const removed = await service.remove({ id: retained.id, reason: "test snapshot" });
    expect(removed.snapshotRef).toBeTruthy();
    await expect(
      service.create({ ...binding, requireExactSource: true, checkoutCommit: b }),
    ).rejects.toMatchObject({
      name: "WorktreeSourceMismatchError",
      details: { reason: "revision", expectedCommit: b, actualCommit: a },
    });
    await expect(fs.access(retained.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await git(repo, "rev-parse", removed.snapshotRef!)).toMatch(/^[a-f0-9]{40}$/u);
    const restored = await service.create({
      ...binding,
      requireExactSource: true,
      checkoutCommit: a,
    });
    expect(restored.id).toBe(retained.id);
    expect(await git(restored.path, "rev-parse", "HEAD")).toBe(a);
  });

  it("materializes frozen B, verifies its repository, and preserves another owner's A", async () => {
    const retained = await service.create({
      repoRoot: repo,
      name: "review-a",
      requireExactSource: true,
      checkoutCommit: a,
      ownerKind: "workboard",
      ownerId: "card-c",
    });
    await expect(
      service.create({
        repoRoot: repo,
        name: "review-a",
        requireExactSource: true,
        checkoutCommit: b,
        ownerKind: "workboard",
        ownerId: "different-card",
      }),
    ).rejects.toThrow("name is already in use");
    // A different name alone cannot override the card's retained ownership.
    await expect(
      service.create({
        repoRoot: repo,
        name: "review-b",
        requireExactSource: true,
        checkoutCommit: b,
        ownerKind: "workboard",
        ownerId: "card-c",
      }),
    ).rejects.toMatchObject({ details: { reason: "revision" } });
    const recovered = await service.create({
      repoRoot: repo,
      name: "review-b",
      baseRef: "main",
      requireExactSource: true,
      checkoutCommit: b,
    });
    expect(await fs.readFile(path.join(recovered.path, "README.md"), "utf8")).toBe("candidate B\n");
    expect(
      await service.verifyCheckout({ path: recovered.path, repoRoot: repo, checkoutCommit: b }),
    ).toMatchObject({
      path: recovered.path,
      repoRoot: repo,
      headCommit: b,
      repoFingerprint: recovered.repoFingerprint,
    });
    const otherRepo = path.join(path.dirname(repo), "other-repo");
    await git(path.dirname(repo), "clone", repo, otherRepo);
    await expect(
      service.verifyCheckout({ path: recovered.path, repoRoot: otherRepo, checkoutCommit: b }),
    ).rejects.toMatchObject({ details: { reason: "repository", actualCommit: b } });
    expect(await git(retained.path, "rev-parse", "HEAD")).toBe(a);
  });

  it("preserves builder commits, dirty tracked and untracked work across resume and restore", async () => {
    const binding = {
      repoRoot: repo,
      name: "builder",
      ownerKind: "workboard" as const,
      ownerId: "builder-card",
    };
    const retained = await service.create({ ...binding, baseRef: a, checkoutCommit: a });
    await fs.writeFile(path.join(retained.path, "README.md"), "builder commit\n");
    await git(retained.path, "add", "README.md");
    await git(retained.path, "commit", "-m", "builder work");
    const builderHead = await git(retained.path, "rev-parse", "HEAD");
    await fs.writeFile(path.join(retained.path, "README.md"), "unsaved tracked work\n");
    await fs.writeFile(path.join(retained.path, "draft.ts"), "unsaved untracked work\n");
    expect((await service.create({ ...binding, baseRef: b, checkoutCommit: b })).id).toBe(
      retained.id,
    );
    await service.remove({ id: retained.id, reason: "builder resume fixture" });
    await expect(
      service.create({ ...binding, requireExactSource: true, checkoutCommit: builderHead }),
    ).rejects.toMatchObject({ details: { reason: "dirty" } });
    await expect(fs.access(retained.path)).rejects.toMatchObject({ code: "ENOENT" });
    const restored = await service.create({ ...binding, baseRef: b, checkoutCommit: b });
    expect(await git(restored.path, "rev-parse", "HEAD")).toBe(builderHead);
    expect(await fs.readFile(path.join(restored.path, "README.md"), "utf8")).toBe(
      "unsaved tracked work\n",
    );
    expect(await fs.readFile(path.join(restored.path, "draft.ts"), "utf8")).toBe(
      "unsaved untracked work\n",
    );
  });

  it("rejects tracked or untracked source and does not trust local exclusion rules", async () => {
    const binding = { repoRoot: repo, name: "dirty", requireExactSource: true, checkoutCommit: b };
    const retained = await service.create(binding);
    await fs.writeFile(path.join(retained.path, "README.md"), "changed\n");
    await expect(service.create(binding)).rejects.toMatchObject({ details: { reason: "dirty" } });
    await git(retained.path, "checkout", "--", "README.md");
    await fs.writeFile(path.join(retained.path, "draft.ts"), "hidden source\n");
    await fs.appendFile(path.join(repo, ".git", "info", "exclude"), "\ndraft.ts\n");
    expect(await git(retained.path, "status", "--porcelain")).toBe("");
    await expect(service.create(binding)).rejects.toMatchObject({ details: { reason: "dirty" } });
    expect(await fs.readFile(path.join(retained.path, "draft.ts"), "utf8")).toBe("hidden source\n");
  });

  it.skipIf(process.platform === "win32")(
    "checks after setup and allows only checkout-declared ignored artifacts",
    async () => {
      await fs.mkdir(path.join(repo, ".openclaw"));
      const setup = path.join(repo, ".openclaw", "worktree-setup.sh");
      await fs.writeFile(setup, "#!/bin/sh\nmkdir -p cache\necho setup > cache/result\n");
      await fs.chmod(setup, 0o755);
      await fs.writeFile(path.join(repo, ".gitignore"), "cache/\n");
      await git(repo, "add", ".openclaw", ".gitignore");
      await git(repo, "commit", "-m", "declared setup cache");
      const candidate = await git(repo, "rev-parse", "HEAD");
      const clean = await service.create({
        repoRoot: repo,
        name: "setup-cache",
        requireExactSource: true,
        checkoutCommit: candidate,
      });
      expect(await fs.readFile(path.join(clean.path, "cache", "result"), "utf8")).toBe("setup\n");
      await fs.writeFile(setup, "#!/bin/sh\necho changed > README.md\n");
      await expect(
        service.create({
          repoRoot: repo,
          name: "setup-mutation",
          requireExactSource: true,
          checkoutCommit: candidate,
        }),
      ).rejects.toMatchObject({ details: { reason: "dirty" } });
      expect((await service.list()).map((record) => record.id)).toEqual([clean.id]);
    },
  );

  it("rejects nonimmutable or missing commit requests before creating a workspace", async () => {
    await expect(
      service.create({ repoRoot: repo, name: "no-commit", requireExactSource: true }),
    ).rejects.toThrow("requires checkoutCommit");
    await expect(
      service.create({
        repoRoot: repo,
        name: "moving",
        requireExactSource: true,
        checkoutCommit: "main",
      }),
    ).rejects.toThrow("full immutable");
    await expect(
      service.create({
        repoRoot: repo,
        name: "missing",
        requireExactSource: true,
        checkoutCommit: "f".repeat(40),
      }),
    ).rejects.toThrow("does not resolve");
    expect(await service.list()).toEqual([]);
    const retained = await service.create({ repoRoot: repo, name: "no-commit", checkoutCommit: a });
    await expect(
      service.create({ repoRoot: repo, name: "no-commit", requireExactSource: true }),
    ).rejects.toThrow("requires checkoutCommit");
    expect(await git(retained.path, "rev-parse", "HEAD")).toBe(a);
  });

  it("admits concurrent exact requests into one owner's current checkout", async () => {
    const binding = {
      repoRoot: repo,
      requireExactSource: true,
      checkoutCommit: b,
      ownerKind: "workboard" as const,
      ownerId: "card-c",
    };
    const [first, second] = await Promise.all([
      service.create({ ...binding, name: "first" }),
      service.create({ ...binding, name: "second" }),
    ]);
    expect(first.id).toBe(second.id);
    expect((await service.list()).filter((record) => record.ownerId === "card-c")).toHaveLength(1);
  });

  it.each(["tracked", "untracked"])(
    "rejects late %s writes after the initial clean scan with unchanged HEAD",
    async (kind) => {
      const retained = await service.create({
        repoRoot: repo,
        name: "late-write",
        checkoutCommit: b,
      });
      const requireGit = gitOperations.requireGit;
      let headReads = 0;
      vi.spyOn(gitOperations, "requireGit").mockImplementation(async (cwd, args, options) => {
        const result = await requireGit(cwd, args, options);
        if (cwd === retained.path && args.join(" ") === "rev-parse --verify HEAD^{commit}") {
          headReads += 1;
          if (headReads === 2) {
            // A real source write in the final HEAD read's completion window;
            // the Git result and commit stay unchanged. No sleeps or fake status.
            await fs.writeFile(
              path.join(retained.path, kind === "tracked" ? "README.md" : "late.ts"),
              "late source mutation\n",
            );
          }
        }
        return result;
      });
      await expect(
        service.verifyCheckout({ path: retained.path, repoRoot: repo, checkoutCommit: b }),
      ).rejects.toMatchObject({ details: { reason: "dirty", actualCommit: b } });
      expect(headReads).toBe(2);
      expect(await git(retained.path, "rev-parse", "HEAD")).toBe(b);
    },
  );
});

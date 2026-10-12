import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveStateDir } from "../../config/paths.js";
import { runGitWorkerOperation } from "../../infra/git-worker.js";
import type { WorktreeAllocationGuard } from "./allocation.js";
import { resolveWorktreeBase } from "./base-ref.js";
import {
  directorySizeBytes,
  estimateWorktreeGitBytes,
  WORKTREE_SETUP_HEADROOM_BYTES,
} from "./capacity.js";
import { resolveWorktreeSourceProfile } from "./checkout-profiles.js";
import { addManagedWorktree } from "./checkout.js";
import { commandError, runGit } from "./git.js";
import {
  canResetFailedWorktreeAdd,
  generateName,
  resetFailedWorktreeAdd,
  type ResolvedRepository,
} from "./service-preparation.js";
import type { CreateManagedWorktreeParams } from "./types.js";

export type MaterializedRepositoryWorktree = {
  name: string;
  worktreePath: string;
  branch: string;
  recordBase: string;
  provisionedBytes: number;
  setupBytes: number;
  runRepositorySetup: boolean;
};

type WorktreeMaterializationContext = {
  env: NodeJS.ProcessEnv;
  now: () => number;
  getConfig?: () => OpenClawConfig;
  requireSpace: (target: string, repository: ResolvedRepository, bytes?: number) => void;
};

async function worktreesRoot(context: WorktreeMaterializationContext): Promise<string> {
  const root =
    context.getConfig?.().worktreeRoot ?? path.join(resolveStateDir(context.env), "worktrees");
  await fs.mkdir(root, { recursive: true });
  // Git canonicalizes paths in `git worktree list`; minting below the real root keeps
  // lock-state and adoption comparisons aligned when the state path traverses symlinks.
  return await fs.realpath(root);
}

export async function materializeRepositoryWorktree(
  params: CreateManagedWorktreeParams & WorktreeAllocationGuard,
  repository: ResolvedRepository,
  inferredName: string,
  suppliedName: string | undefined,
  context: WorktreeMaterializationContext,
): Promise<MaterializedRepositoryWorktree> {
  const root = path.join(await worktreesRoot(context), repository.fingerprint);
  const name =
    suppliedName ??
    (await generateName(
      context.env,
      repository.repoRoot,
      repository.fingerprint,
      root,
      params,
      params.suggestedName ?? inferredName,
    ));
  const worktreePath = path.join(root, name);
  const branch = `openclaw/${name}`;
  const branchExists = await runGit(repository.repoRoot, [
    "show-ref",
    "--quiet",
    "--verify",
    `refs/heads/${branch}`,
  ]);
  if (branchExists.code === 0) {
    throw new Error(`branch already exists: ${branch}`);
  }
  if (branchExists.code !== 1) {
    throw commandError("git show-ref --verify", branchExists);
  }
  // Default-base resolution fetches remote refs; it is an effect, not just discovery.
  params.signal?.throwIfAborted();
  params.commitGuard?.();
  context.requireSpace(worktreePath, repository);
  params.commitGuard?.();
  if (params.checkoutCommit && !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(params.checkoutCommit)) {
    throw new Error("Worktree checkout commit is invalid");
  }
  const base = params.checkoutCommit
    ? {
        commit: params.checkoutCommit,
        gitOperand: params.checkoutCommit,
        recordRef: params.baseRef ?? params.checkoutCommit,
        remote: false,
      }
    : await resolveWorktreeBase(
        repository.repoRoot,
        params.baseRef,
        params.signal,
        params.commitGuard,
      );
  let gitBytes = 0;
  const provisionedBytes =
    params.provisionIgnoredFiles === false
      ? 0
      : (
          await runGitWorkerOperation(
            {
              type: "worktree.provisioning-inspection",
              input: { sourceRoot: repository.sourceRoot },
            },
            { signal: params.signal, assertCurrent: params.commitGuard },
          )
        ).estimatedBytes;
  const setupStat =
    params.runSetupScript === false
      ? undefined
      : await fs
          .stat(path.join(repository.sourceRoot, ".openclaw", "worktree-setup.sh"))
          .catch(() => undefined);
  const runRepositorySetup = setupStat?.isFile() === true && (setupStat.mode & 0o111) !== 0;
  const setupBytes = runRepositorySetup
    ? Math.max(
        WORKTREE_SETUP_HEADROOM_BYTES,
        await directorySizeBytes(repository.sourceRoot, true, {
          signal: params.signal,
          assertCurrent: params.commitGuard,
        }),
      )
    : 0;
  params.signal?.throwIfAborted();
  params.commitGuard?.();
  let gitBase = params.profiles?.length ? base.commit : base.gitOperand;
  let recordBase = base.recordRef;
  const addCheckout = async () => {
    // Resolve on every attempt, including the remote-base fallback to local HEAD.
    // Never pair one commit's source selection with another commit's checkout.
    const sourceProfile = params.profiles?.length
      ? await resolveWorktreeSourceProfile(repository.repoRoot, gitBase, params.profiles, {
          signal: params.signal,
          commitGuard: () => params.commitGuard?.(),
        })
      : undefined;
    params.signal?.throwIfAborted();
    params.commitGuard?.();
    await fs.mkdir(root, { recursive: true });
    return await addManagedWorktree({
      env: context.env,
      now: context.now,
      enabled: context.getConfig?.().worktreeAcceleration !== false,
      repoRoot: repository.repoRoot,
      commonDir: repository.commonDir,
      worktreeRoot: path.dirname(root),
      destination: worktreePath,
      sourceOnly: params.provisionIgnoredFiles === false,
      branch,
      base: sourceProfile?.commit ?? gitBase,
      sourceProfile,
      prepareCommit: async (commit) => {
        return (gitBytes = await estimateWorktreeGitBytes(repository.repoRoot, commit, {
          signal: params.signal,
          assertCurrent: params.commitGuard,
        }));
      },
      requireSpace: (cloneBytes) =>
        context.requireSpace(
          worktreePath,
          repository,
          (cloneBytes ?? 2 * gitBytes) + 2 * provisionedBytes + setupBytes,
        ),
      signal: params.signal,
      commitGuard: () => params.commitGuard?.(),
      rollbackGuard: params.rollbackGuard,
    });
  };
  let added = await addCheckout();
  if (added.code !== 0 && base.remote) {
    if (!(await canResetFailedWorktreeAdd(repository.repoRoot, worktreePath, branch, added))) {
      throw commandError("git worktree add", added);
    }
    await resetFailedWorktreeAdd(repository.repoRoot, worktreePath, branch, params.rollbackGuard);
    params.signal?.throwIfAborted();
    params.commitGuard?.();
    gitBase = "HEAD";
    recordBase = "HEAD";
    added = await addCheckout();
  }
  if (added.code !== 0) {
    throw commandError("git worktree add", added);
  }
  return {
    name,
    worktreePath,
    branch,
    recordBase,
    provisionedBytes,
    setupBytes,
    runRepositorySetup,
  };
}

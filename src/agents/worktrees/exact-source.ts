import { requireGit } from "./git.js";
import { resolveRepository, type ResolvedRepository } from "./service-preparation.js";
import type { ManagedWorktreeRecord } from "./types.js";

export type VerifyWorktreeCheckoutParams = {
  path: string;
  repoRoot: string;
  checkoutCommit: string;
  signal?: AbortSignal;
  commitGuard?: () => void;
};

export type VerifiedWorktreeCheckout = {
  path: string;
  repoRoot: string;
  commonDir: string;
  repoFingerprint: string;
  headCommit: string;
};

export type WorktreeSourceMismatchDetails = {
  reason: "revision" | "dirty" | "repository" | "snapshot";
  expectedCommit: string;
  actualCommit?: string;
  path: string;
  expectedRepoRoot: string;
  actualRepoRoot?: string;
  expectedCommonDir: string;
  actualCommonDir?: string;
  recovery: "isolated-workspace";
};

/** A preserved checkout is a resume target, not permission to review another candidate. */
export class WorktreeSourceMismatchError extends Error {
  constructor(readonly details: WorktreeSourceMismatchDetails) {
    super(
      `Exact source ${details.reason} mismatch at ${details.path}: expected ${details.expectedCommit}, actual ${details.actualCommit ?? "unverified"}. Preserve this checkout or snapshot and bind an isolated workspace at the requested commit.`,
    );
    this.name = "WorktreeSourceMismatchError";
  }
}

export function assertCheckoutCommit(commit: string): void {
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(commit)) {
    throw new Error("Worktree checkout commit must be a full immutable Git commit ID");
  }
}

function mismatch(
  reason: WorktreeSourceMismatchDetails["reason"],
  params: Pick<VerifyWorktreeCheckoutParams, "path" | "checkoutCommit">,
  expected: ResolvedRepository,
  actual?: ResolvedRepository,
  actualCommit?: string,
): never {
  throw new WorktreeSourceMismatchError({
    reason,
    expectedCommit: params.checkoutCommit,
    actualCommit,
    path: actual?.sourceRoot ?? params.path,
    expectedRepoRoot: expected.repoRoot,
    actualRepoRoot: actual?.repoRoot,
    expectedCommonDir: expected.commonDir,
    actualCommonDir: actual?.commonDir,
    recovery: "isolated-workspace",
  });
}

/** The native owner verifies source for managed reuse, explicit directories, and completion. */
export async function verifyWorktreeCheckout(
  params: VerifyWorktreeCheckoutParams,
): Promise<VerifiedWorktreeCheckout> {
  assertCheckoutCommit(params.checkoutCommit);
  params.signal?.throwIfAborted();
  params.commitGuard?.();
  const expected = await resolveRepository(params.repoRoot);
  const actual = await resolveRepository(params.path);
  const options = { signal: params.signal, beforeRun: params.commitGuard };
  const headCommit = await requireGit(
    actual.sourceRoot,
    ["rev-parse", "--verify", "HEAD^{commit}"],
    options,
  );
  if (actual.commonDir !== expected.commonDir || actual.fingerprint !== expected.fingerprint) {
    mismatch("repository", params, expected, actual, headCommit);
  }
  if (headCommit !== params.checkoutCommit) {
    mismatch("revision", params, expected, actual, headCommit);
  }
  const tracked = await requireGit(
    actual.sourceRoot,
    ["status", "--porcelain=v1", "-z", "--untracked-files=no", "--ignore-submodules=none"],
    options,
  );
  // Only checkout-owned .gitignore declarations exempt setup/cache output. Global
  // excludes and .git/info/exclude cannot hide untracked review source.
  const untracked = await requireGit(
    actual.sourceRoot,
    ["ls-files", "--others", "--exclude-per-directory=.gitignore", "-z"],
    options,
  );
  if (tracked || untracked) {
    mismatch("dirty", params, expected, actual, headCommit);
  }
  const finalHead = await requireGit(
    actual.sourceRoot,
    ["rev-parse", "--verify", "HEAD^{commit}"],
    options,
  );
  if (finalHead !== headCommit) {
    mismatch("revision", params, expected, actual, finalHead);
  }
  // The final HEAD read can yield after the first source scan. Repeat strict
  // untracked membership, then observe HEAD and index/working-source changes
  // together in the last native Git result before the synchronous return.
  const finalUntracked = await requireGit(
    actual.sourceRoot,
    ["ls-files", "--others", "--exclude-per-directory=.gitignore", "-z"],
    options,
  );
  if (finalUntracked) {
    mismatch("dirty", params, expected, actual, finalHead);
  }
  const finalStatus = await requireGit(
    actual.sourceRoot,
    [
      "status",
      "--porcelain=v2",
      "--branch",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=none",
    ],
    options,
  );
  const statusFields = finalStatus.split("\0").filter(Boolean);
  const observedHead = statusFields
    .find((field) => field.startsWith("# branch.oid "))
    ?.slice("# branch.oid ".length);
  if (observedHead !== params.checkoutCommit) {
    mismatch("revision", params, expected, actual, observedHead);
  }
  if (statusFields.some((field) => !field.startsWith("# "))) {
    mismatch("dirty", params, expected, actual, observedHead);
  }
  params.signal?.throwIfAborted();
  params.commitGuard?.();
  return {
    path: actual.sourceRoot,
    repoRoot: actual.repoRoot,
    commonDir: actual.commonDir,
    repoFingerprint: actual.fingerprint,
    headCommit,
  };
}

/** Reject an incompatible snapshot before native restore changes its lifecycle or path. */
export async function verifyWorktreeSnapshotSource(
  record: ManagedWorktreeRecord,
  params: Omit<VerifyWorktreeCheckoutParams, "path">,
): Promise<void> {
  assertCheckoutCommit(params.checkoutCommit);
  const expected = await resolveRepository(params.repoRoot);
  const actual = await resolveRepository(record.repoRoot);
  const snapshotSource = { ...actual, sourceRoot: record.path };
  const options = { signal: params.signal, beforeRun: params.commitGuard };
  const binding = { path: record.path, checkoutCommit: params.checkoutCommit };
  if (actual.commonDir !== expected.commonDir || actual.fingerprint !== record.repoFingerprint) {
    mismatch("repository", binding, expected, snapshotSource);
  }
  const snapshot = await requireGit(
    actual.repoRoot,
    ["rev-parse", "--verify", `${record.snapshotRef}^{commit}`],
    options,
  );
  const head = await requireGit(
    actual.repoRoot,
    ["rev-parse", "--verify", `${snapshot}^`],
    options,
  );
  if (head !== params.checkoutCommit) {
    mismatch("revision", binding, expected, snapshotSource, head);
  }
  // Exact-state snapshots preserve arbitrary index and filesystem state. They
  // remain available through explicit restore, never implicit exact-review reuse.
  if (record.snapshotRef?.startsWith("refs/openclaw/snapshots/exact-")) {
    mismatch("snapshot", binding, expected, snapshotSource, head);
  }
  const snapshotTree = await requireGit(
    actual.repoRoot,
    ["rev-parse", `${snapshot}^{tree}`],
    options,
  );
  const sourceTree = await requireGit(actual.repoRoot, ["rev-parse", `${head}^{tree}`], options);
  if (snapshotTree !== sourceTree) {
    mismatch("dirty", binding, expected, snapshotSource, head);
  }
  params.signal?.throwIfAborted();
  params.commitGuard?.();
}

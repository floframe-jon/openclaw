import {
  WORKBOARD_PROOF_STATUSES,
  type WorkboardWorkspace,
  type WorkboardExecution,
  type WorkboardAutomation,
} from "@openclaw/workboard-contract";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { MAX_CARD_PROOF } from "./store-constants.js";
import {
  normalizeBoundedString,
  normalizeEnumValue,
  normalizeTimestamp,
} from "./store-normalization-values.js";
import { isAbsoluteWorkspacePath } from "./workspace-path.js";

export function normalizeWorkspace(
  value: unknown,
  fallback?: WorkboardWorkspace,
): WorkboardWorkspace | undefined {
  if (!isRecord(value)) {
    return fallback;
  }
  const record = value;
  const kind =
    record.kind === "scratch" || record.kind === "dir" || record.kind === "worktree"
      ? record.kind
      : fallback?.kind;
  if (!kind) {
    throw new Error("workspace kind must be scratch, dir, or worktree.");
  }
  const workspacePath = normalizeBoundedString(record.path, fallback?.path, 2000, "workspace path");
  if (kind === "dir" && (!workspacePath || !isAbsoluteWorkspacePath(workspacePath))) {
    throw new Error("dir workspace path must be absolute.");
  }
  const workspaceFallback = workspacePath === fallback?.path ? fallback : undefined;
  const branch = normalizeBoundedString(
    record.branch,
    workspaceFallback?.branch,
    160,
    "workspace branch",
  );
  const sourcePath = normalizeBoundedString(
    record.sourcePath,
    workspaceFallback?.sourcePath,
    2000,
    "workspace source path",
  );
  if (sourcePath && !isAbsoluteWorkspacePath(sourcePath)) {
    throw new Error("workspace source path must be absolute.");
  }
  const sourceBranch = normalizeBoundedString(
    record.sourceBranch,
    workspaceFallback?.sourceBranch,
    160,
    "workspace source branch",
  );
  const repoRoot = normalizeBoundedString(
    record.repoRoot,
    workspaceFallback?.repoRoot,
    2000,
    "workspace repository",
  );
  const checkoutCommit = normalizeBoundedString(
    record.checkoutCommit,
    workspaceFallback?.checkoutCommit,
    64,
    "workspace checkout commit",
  );
  if (repoRoot || checkoutCommit) {
    if (
      kind === "scratch" ||
      !repoRoot ||
      !isAbsoluteWorkspacePath(repoRoot) ||
      !checkoutCommit ||
      !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(checkoutCommit)
    ) {
      throw new Error(
        "exact workspace requires an absolute repoRoot and full immutable checkoutCommit.",
      );
    }
  }
  return {
    kind,
    ...(workspacePath ? { path: workspacePath } : {}),
    ...(branch ? { branch } : {}),
    ...(kind === "worktree" && sourcePath ? { sourcePath } : {}),
    ...(kind === "worktree" && sourceBranch ? { sourceBranch } : {}),
    ...(repoRoot && checkoutCommit ? { repoRoot, checkoutCommit } : {}),
  };
}

export function normalizeSourceBinding(
  record: Record<string, unknown>,
): NonNullable<WorkboardExecution["source"]> {
  const readPath = (field: string) => {
    const value = normalizeBoundedString(
      record[field],
      undefined,
      2000,
      `execution source ${field}`,
    );
    if (!value || !isAbsoluteWorkspacePath(value)) {
      throw new Error(`execution source ${field} must be absolute.`);
    }
    return value;
  };
  const repoFingerprint = normalizeBoundedString(
    record.repoFingerprint,
    undefined,
    160,
    "execution source repository fingerprint",
  );
  const checkoutCommit = normalizeBoundedString(
    record.checkoutCommit,
    undefined,
    64,
    "execution source checkout commit",
  );
  if (
    !repoFingerprint ||
    !checkoutCommit ||
    !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(checkoutCommit)
  ) {
    throw new Error(
      "execution source requires a repository fingerprint and full immutable checkoutCommit.",
    );
  }
  return {
    path: readPath("path"),
    repoRoot: readPath("repoRoot"),
    commonDir: readPath("commonDir"),
    repoFingerprint,
    checkoutCommit,
  };
}

export function normalizeReviewEvidence(
  value: unknown,
): NonNullable<WorkboardAutomation["reviewEvidence"]> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.slice(-MAX_CARD_PROOF).map((record: unknown) => {
    if (!isRecord(record) || !isRecord(record.source)) {
      throw new Error("exact review evidence requires a source binding.");
    }
    const attemptId = normalizeBoundedString(record.attemptId, undefined, 160, "review attempt");
    const proofId = normalizeBoundedString(record.proofId, undefined, 120, "review proof");
    const status = normalizeEnumValue(record.status, WORKBOARD_PROOF_STATUSES, "unknown");
    const verifiedAt = normalizeTimestamp(record.verifiedAt, 0);
    if (!attemptId || !proofId || !verifiedAt || status === "unknown") {
      throw new Error(
        "exact review evidence requires an attempt, proof, result, and verification time.",
      );
    }
    return {
      attemptId,
      proofId,
      source: normalizeSourceBinding(record.source),
      status,
      verifiedAt,
    };
  });
}

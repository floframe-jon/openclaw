import { isDeepStrictEqual } from "node:util";
import type {
  WorkboardCard,
  WorkboardSourceBinding,
  WorkboardWorkspace,
  WorkboardWorkspaceAccess,
  WorkboardLaunchState,
} from "@openclaw/workboard-contract";
import { safeEqualSecret } from "openclaw/plugin-sdk/security-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { cardBoardId } from "./store-card-helpers.js";
import type { WorkboardMutationScope, WorkboardUpdateCardOptions } from "./store-inputs.js";

export type WorkboardExecutionAuthority = {
  boardId: string;
  agentId?: string;
  workspace?: WorkboardWorkspace;
  workspaceAccess?: WorkboardWorkspaceAccess;
};

export type WorkboardVerifyCheckout = (input: {
  path: string;
  repoRoot: string;
  checkoutCommit: string;
}) => Promise<{
  path: string;
  repoRoot: string;
  commonDir: string;
  repoFingerprint: string;
  headCommit: string;
}>;

export function executionAuthority(card: WorkboardCard): WorkboardExecutionAuthority {
  return {
    boardId: cardBoardId(card),
    agentId: card.agentId,
    workspace: card.metadata?.automation?.workspace,
    workspaceAccess: card.metadata?.automation?.workspaceAccess,
  };
}

export function assertExecutionAuthority(
  card: WorkboardCard,
  expected: WorkboardExecutionAuthority,
): void {
  const actual = executionAuthority(card);
  if (
    actual.boardId !== expected.boardId ||
    actual.agentId !== expected.agentId ||
    !isDeepStrictEqual(actual.workspace, expected.workspace) ||
    !isDeepStrictEqual(actual.workspaceAccess, expected.workspaceAccess)
  ) {
    throw new Error("card workspace authority changed during execution preparation.");
  }
}

export function assertCurrentExecutionClaim(
  card: WorkboardCard,
  scope: WorkboardMutationScope | undefined,
): void {
  const claim = card.metadata?.claim;
  const token = normalizeOptionalString(scope?.token);
  if (!claim || !token || !safeEqualSecret(token, claim.token)) {
    throw new Error("exact execution requires the current claim token.");
  }
  if (claim.expiresAt === undefined || claim.expiresAt <= Date.now()) {
    throw new Error("execution claim expired before source verification.");
  }
}

export function assertExecutionSourceBinding(
  card: WorkboardCard,
  source: WorkboardSourceBinding,
): void {
  const workspace = card.metadata?.automation?.workspace;
  if (
    !workspace ||
    workspace.checkoutCommit !== source.checkoutCommit ||
    workspace.repoRoot !== source.repoRoot ||
    workspace.path !== source.path
  ) {
    throw new Error("exact execution source no longer matches the card workspace.");
  }
}

export async function verifyExecutionSource(
  card: WorkboardCard,
  verifyCheckout: WorkboardVerifyCheckout | undefined,
): Promise<WorkboardSourceBinding> {
  const source = card.execution?.source;
  if (!source || !card.execution?.runId) {
    throw new Error("exact completion requires a source-bound execution attempt.");
  }
  assertExecutionSourceBinding(card, source);
  if (!verifyCheckout) {
    throw new Error("exact completion requires native checkout verification.");
  }
  const actual = await verifyCheckout(source);
  if (
    actual.path !== source.path ||
    actual.repoRoot !== source.repoRoot ||
    actual.commonDir !== source.commonDir ||
    actual.repoFingerprint !== source.repoFingerprint ||
    actual.headCommit !== source.checkoutCommit
  ) {
    throw new Error("exact execution source changed before completion.");
  }
  return source;
}

type WorkboardPreparedLaunch = Extract<WorkboardLaunchState, { phase: "prepared" }>;

export function preparedLaunchMatchesCard(
  card: WorkboardCard,
  expected: WorkboardPreparedLaunch,
): boolean {
  const launch = card.metadata?.automation?.launch;
  return (
    launch?.phase === "prepared" &&
    launch.requestedSessionKey === expected.requestedSessionKey &&
    launch.provisionalRunId === expected.provisionalRunId &&
    launch.preparedAt === expected.preparedAt &&
    card.sessionKey === expected.requestedSessionKey &&
    card.runId === expected.provisionalRunId &&
    card.execution?.sessionKey === expected.requestedSessionKey &&
    card.execution?.runId === expected.provisionalRunId &&
    isDeepStrictEqual(launch.source, expected.source)
  );
}

export type WorkboardExactSourceUpdateOptions = Pick<WorkboardUpdateCardOptions, "ownerSlot"> & {
  verifiedSourceCompletion?: WorkboardSourceBinding;
};

export function assertExactSourceCreation(
  card: Pick<WorkboardCard, "status" | "metadata" | "execution">,
): void {
  if (
    card.status === "done" &&
    (card.metadata?.automation?.workspace?.checkoutCommit || card.execution?.source)
  ) {
    throw new Error("exact review completion must use verified workboard_complete.");
  }
}

export function assertExactSourceMutation(
  existing: WorkboardCard,
  next: WorkboardCard,
  options: WorkboardExactSourceUpdateOptions,
): void {
  if (
    existing.execution?.source &&
    existing.metadata?.claim &&
    next.metadata?.claim &&
    !options.ownerSlot
  ) {
    // A live exact attempt owns its candidate throughout asynchronous worker preparation.
    // Native reclaim/block ends the claim before a replacement candidate can be bound.
    assertExecutionAuthority(next, executionAuthority(existing));
    if (!isDeepStrictEqual(next.execution?.source, existing.execution.source)) {
      throw new Error(
        "a claimed exact execution source cannot be replaced; reclaim the attempt first.",
      );
    }
  }
  if (
    next.status === "done" &&
    existing.status !== "done" &&
    (existing.execution?.source || existing.metadata?.automation?.workspace?.checkoutCommit) &&
    (!options.verifiedSourceCompletion ||
      !isDeepStrictEqual(options.verifiedSourceCompletion, existing.execution?.source))
  ) {
    throw new Error("exact review completion must use verified workboard_complete.");
  }
}

export function assertExactSourceCompletionClaim(
  existing: WorkboardCard,
  options: WorkboardExactSourceUpdateOptions,
): void {
  if (
    options.verifiedSourceCompletion &&
    (!existing.metadata?.claim?.expiresAt || existing.metadata.claim.expiresAt <= Date.now())
  ) {
    throw new Error("execution claim expired before source completion.");
  }
}

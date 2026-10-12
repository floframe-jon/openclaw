import type {
  WorkboardCard,
  WorkboardWorkspace,
  WorkboardWorkspaceAccess,
  WorkboardLaunchState,
} from "@openclaw/workboard-contract";
import {
  assertCurrentExecutionClaim,
  assertExecutionAuthority,
  assertExecutionSourceBinding,
  preparedLaunchMatchesCard,
  type WorkboardExecutionAuthority,
} from "./store-exact-source.js";
import type { WorkboardMutationScope } from "./store-inputs.js";
import { WorkboardNotificationStore } from "./store-notifications.js";

type WorkboardPreparedLaunch = Extract<WorkboardLaunchState, { phase: "prepared" }>;

export class WorkboardExecutionStore extends WorkboardNotificationStore {
  async checkExecutionSource(
    id: string,
    input: { scope: WorkboardMutationScope; expectedAuthority: WorkboardExecutionAuthority },
  ): Promise<WorkboardCard> {
    const card = await this.requireCard(id);
    if (card.status !== "running") {
      throw new Error("card stopped before execution preparation.");
    }
    assertCurrentExecutionClaim(card, input.scope);
    assertExecutionAuthority(card, input.expectedAuthority);
    return card;
  }

  async bindExecutionWorkspace(
    id: string,
    input: {
      scope: WorkboardMutationScope;
      expectedAuthority: WorkboardExecutionAuthority;
      workspace: WorkboardWorkspace;
      workspaceAccess: WorkboardWorkspaceAccess;
      assertOwnerCurrent?: () => void;
    },
  ): Promise<{ before: WorkboardCard; after: WorkboardCard }> {
    return await this.enqueueMutation(async () => {
      let before: WorkboardCard | undefined;
      const result = await this.updateLatestCard(id, (card) => {
        if (card.status !== "running") {
          throw new Error("card stopped before execution preparation.");
        }
        assertCurrentExecutionClaim(card, input.scope);
        assertExecutionAuthority(card, input.expectedAuthority);
        before = card;
        return { workspace: input.workspace, workspaceAccess: input.workspaceAccess };
      });
      if (!before) {
        throw new Error("execution workspace was not bound.");
      }
      return { before, after: result.card };
    }, input.assertOwnerCurrent);
  }
  async assertExecutionLaunchCurrent(
    id: string,
    input: {
      scope: WorkboardMutationScope;
      expectedAuthority: WorkboardExecutionAuthority;
      expectedLaunch: WorkboardPreparedLaunch;
    },
  ): Promise<void> {
    const card = await this.checkExecutionSource(id, input);
    if (!preparedLaunchMatchesCard(card, input.expectedLaunch)) {
      throw new Error("prepared execution attempt is no longer current.");
    }
    if (card.execution?.source) {
      assertExecutionSourceBinding(card, card.execution.source);
    }
  }
}

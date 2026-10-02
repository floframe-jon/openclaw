import { AsyncLocalStorage } from "node:async_hooks";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import {
  getInProcessGatewayRequestContext,
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import type { PluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.types.js";
import { getSpawnBroker, runWithSpawnBroker } from "../process/spawn-broker/context.js";
import { useSpawnBrokerTestFixture } from "../process/spawn-broker/host.test-support.js";
import { spawnWithFallback } from "../process/spawn-utils.js";
import { createScheduledGatewayRunner } from "./scheduled-run-gateway-context.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

it.each(["bound", "unbound"] as const)(
  "keeps %s scheduled ownership without borrowing either caller's request facts",
  async (binding) => {
    const ownedContext = {} as GatewayRequestContext;
    const callerContext = {} as GatewayRequestContext;
    const resolveOwnedContext = binding === "bound" ? () => ownedContext : undefined;
    const makeCaller = (
      pluginId: string,
      context: GatewayRequestContext,
    ): PluginRuntimeGatewayRequestScope => ({
      pluginId,
      context,
      client: { connId: pluginId } as PluginRuntimeGatewayRequestScope["client"],
      resolveGatewayContext: () => context,
      signal: new AbortController().signal,
      hasCurrentClientAuthority: () => true,
      revalidate: async () => {},
      assertNodeExecutionCurrent: () => {},
      invokeWithSessionNodeAuthority: async () => undefined,
      nodePlacementGrantAuthority: {
        agentId: "main",
        sessionKey: pluginId,
        runId: pluginId,
        assertCurrent: () => {},
      },
      gatewayMethodDispatchAllowed: true,
      isWebchatConnect: () => true,
    });
    const firstCaller = makeCaller("creator", {} as GatewayRequestContext);
    const laterCaller = makeCaller("wakeup", callerContext);
    const scheduled = withPluginRuntimeGatewayRequestScope(firstCaller, () =>
      createScheduledGatewayRunner(resolveOwnedContext),
    );
    const unrelatedContext = new AsyncLocalStorage<string>();
    const assertOwnedScope = () => {
      const scope = expectDefined(getPluginRuntimeGatewayRequestScope(), "scheduled scope");
      expect(scope).toEqual({
        isWebchatConnect: expect.any(Function),
        resolveGatewayContext: resolveOwnedContext,
      });
      expect(scope.isWebchatConnect(scope.client?.connect)).toBe(false);
      expect(getInProcessGatewayRequestContext()).toBe(
        binding === "bound" ? ownedContext : undefined,
      );
      expect(unrelatedContext.getStore()).toBe("unrelated callback");
    };
    await unrelatedContext.run("unrelated callback", () =>
      withPluginRuntimeGatewayRequestScope(laterCaller, async () => {
        const wake = await scheduled(async () => {
          await Promise.resolve();
          assertOwnedScope();
          return AsyncLocalStorage.snapshot();
        });
        expect(getPluginRuntimeGatewayRequestScope()).toBe(laterCaller);
        await wake(async () => {
          await Promise.resolve();
          assertOwnedScope();
        });
        expect(getPluginRuntimeGatewayRequestScope()).toBe(laterCaller);
        expect(getInProcessGatewayRequestContext()).toBe(callerContext);
      }),
    );
  },
);

describe.skipIf(process.platform === "win32" || Boolean(process.versions.bun))(
  "scheduled Gateway broker ownership",
  () => {
    const createBroker = useSpawnBrokerTestFixture(afterEach);
    it("restores only its transport and never borrows another Gateway's broker", async () => {
      const firstBroker = expectDefined(await createBroker(), "first broker");
      const secondBroker = expectDefined(await createBroker(), "second broker");
      const runFirst = runWithSpawnBroker(firstBroker, () => createScheduledGatewayRunner());
      const runWithoutBroker = createScheduledGatewayRunner();
      const callbackContext = new AsyncLocalStorage<string>();
      await callbackContext.run("callback", () =>
        runWithSpawnBroker(secondBroker, () =>
          withGatewayToolCallerIdentity({ agentId: "main", sessionKey: "request" }, async () => {
            await runFirst(async () => {
              await Promise.resolve();
              expect(getSpawnBroker()).toBe(firstBroker);
              expect(getGatewayToolCallerIdentity()).toBeUndefined();
              expect(callbackContext.getStore()).toBe("callback");
            });
            expect(getSpawnBroker()).toBe(secondBroker);
            expect(getGatewayToolCallerIdentity()?.sessionKey).toBe("request");
            await runWithoutBroker(async () => {
              expect(getSpawnBroker()).toBeUndefined();
            });
          }),
        ),
      );

      await firstBroker.close();
      await expect(
        runWithSpawnBroker(secondBroker, () =>
          runFirst(() =>
            spawnWithFallback({
              argv: [process.execPath, "-e", "process.exit(0)"],
              options: { stdio: "ignore" },
            }),
          ),
        ),
      ).rejects.toThrow("Spawn broker is unavailable");
    });
  },
);

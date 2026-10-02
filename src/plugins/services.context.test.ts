import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, describe, expect, it } from "vitest";
import {
  operatorToolGatewayAuthority,
  withOperatorToolGatewayAuthority,
} from "../gateway/operator-tool-gateway-authority.js";
import type {
  GatewayRequestContext,
  GatewayRequestOptions,
} from "../gateway/server-methods/types.js";
import { PluginInstance } from "./plugin-instance.js";
import {
  isPluginRegistryPreparing,
  withPluginRegistryPreparationScope,
} from "./registry-lifecycle.js";
import { bindPluginRegistryRuntime } from "./registry-runtime-binding.js";
import {
  bindGatewayContextResolver,
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "./runtime/gateway-request-scope.js";
import { createPluginRuntime } from "./runtime/index.js";
import { startPluginServices, type PluginServicesHandle } from "./services.js";
import { createRegistry, createServiceConfig } from "./services.test-support.js";
import { createPluginRecord } from "./status.test-helpers.js";

describe("plugin service startup ownership", () => {
  const handles = new Set<PluginServicesHandle>();
  const instances = new Set<PluginInstance>();
  afterEach(async () => {
    await Promise.allSettled([...handles].map((handle) => handle.stop()));
    await Promise.allSettled([...instances].map((instance) => instance.dispose()));
    handles.clear();
    instances.clear();
  });

  it.each(["cold", "candidate", "projection", "unbound", "operator-tool"] as const)(
    "starts %s services without borrowing request authority and preserves owned callback context",
    async (kind) => {
      let wake: ReturnType<typeof AsyncLocalStorage.snapshot> | undefined;
      let startupScope: ReturnType<typeof getPluginRuntimeGatewayRequestScope>;
      let preparing = false;
      const registry = createRegistry([
        {
          id: "queue",
          async start() {
            await Promise.resolve();
            expect(operatorToolGatewayAuthority.getStore()).toBeUndefined();
            startupScope = getPluginRuntimeGatewayRequestScope();
            preparing = isPluginRegistryPreparing(registry);
            wake = AsyncLocalStorage.snapshot();
          },
        },
      ]);
      const record = createPluginRecord({ id: "plugin:test" });
      registry.plugins.push(record);
      const instance = new PluginInstance(record.id, { record, registry });
      instances.add(instance);
      const runtime = createPluginRuntime();
      bindPluginRegistryRuntime(registry, runtime);
      const context = {} as GatewayRequestContext;
      let live = true;
      // Capture the execution fence, not a raw canonical resolver or the caller's resolver.
      const resolver = () => (live ? context : undefined);
      if (kind !== "unbound") {
        bindGatewayContextResolver(runtime.subagent, resolver);
      }
      const caller = {
        context: {} as GatewayRequestContext,
        client: { connId: "caller" } as GatewayRequestOptions["client"],
        isWebchatConnect: () => true,
        pluginId: "different-caller",
        gatewayMethodDispatchAllowed: true,
        revalidate: async () => {},
        resolveGatewayContext: () => context,
      };
      const start = async () => {
        const handle = await startPluginServices({
          // One-shot diagnostics projects services with an object spread.
          registry: kind === "projection" ? { ...registry } : registry,
          config: createServiceConfig(),
        });
        handles.add(handle);
      };
      await withPluginRuntimeGatewayRequestScope(caller, async () => {
        if (kind === "cold") {
          await start();
        } else {
          const prepare = () => withPluginRegistryPreparationScope(registry, start);
          if (kind === "operator-tool") {
            await withOperatorToolGatewayAuthority(
              {
                authenticatedUserProfile: {
                  profileId: "test",
                  displayName: "Test",
                  hasAvatar: false,
                  updatedAt: 1,
                },
                scopes: ["operator.read"],
              },
              async () => {
                const authority = operatorToolGatewayAuthority.getStore();
                await prepare();
                expect(operatorToolGatewayAuthority.getStore()).toBe(authority);
              },
            );
          } else {
            await prepare();
          }
        }
        expect(getPluginRuntimeGatewayRequestScope()).toBe(caller);
      });
      expect(preparing).toBe(kind !== "cold");
      expect(startupScope).toMatchObject({
        pluginId: record.id,
        pluginSource: record.source,
        pluginOrigin: record.origin,
        pluginRegistry: registry,
      });
      expect(startupScope?.client).toBeUndefined();
      expect(startupScope?.context).toBeUndefined();
      expect(startupScope?.gatewayMethodDispatchAllowed).toBeUndefined();
      expect(startupScope?.revalidate).toBeUndefined();
      expect(startupScope?.isWebchatConnect(undefined)).toBe(false);
      expect(startupScope?.resolveGatewayContext).toBe(kind === "unbound" ? undefined : resolver);
      await withPluginRuntimeGatewayRequestScope(caller, async () => {
        await wake?.(async () => {
          await Promise.resolve();
          const scope = getPluginRuntimeGatewayRequestScope();
          expect(operatorToolGatewayAuthority.getStore()).toBeUndefined();
          expect(scope).toBe(startupScope);
          expect(scope?.client).toBeUndefined();
          expect(scope?.resolveGatewayContext?.()).toBe(kind === "unbound" ? undefined : context);
          instance.run(() =>
            expect(getPluginRuntimeGatewayRequestScope()?.pluginId).toBe(record.id),
          );
        });
        expect(getPluginRuntimeGatewayRequestScope()).toBe(caller);
      });
      live = false;
      wake?.(() =>
        expect(getPluginRuntimeGatewayRequestScope()?.resolveGatewayContext?.()).toBeUndefined(),
      );
      await [...handles][0]?.stop();
      await instance.dispose();
      expect(() => wake?.(() => instance.run(() => {}))).toThrow(/reloaded|disabled/i);
    },
  );
});

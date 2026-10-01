import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { getFreePort } from "../test-utils/ports.js";
import {
  clearInstanceBindingProbeCoordinators,
  INSTANCE_BINDING_PROBE_METHOD,
  installInstanceBindingProbeCoordinator,
  writeInstanceBindingProbePlugin,
  type InstanceBindingProbeCoordinator,
  type InstanceBindingProbeResult,
} from "./server-plugins.lifecycle.test-fixtures.js";
import {
  installInstanceBindingConfigIo,
  requireBoundRuntime,
  requestInstanceBindingProbe,
} from "./server-plugins.lifecycle.test-support.js";
import {
  connectWebchatClient,
  installGatewayTestHooks,
  rpcReq,
  startTestGatewayServer,
} from "./test-helpers.server.js";

vi.doUnmock("../plugins/loader.js");
installGatewayTestHooks({ scope: "suite" });
installInstanceBindingConfigIo();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function prepareInstanceBindingTest() {
  const coordinator = installInstanceBindingProbeCoordinator();
  const bundledRoot = tempDirs.make("openclaw-service-context-");
  await writeInstanceBindingProbePlugin(bundledRoot, coordinator.channelName);
  process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = "0";
  delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
  process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledRoot;
  process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = "1";
  process.env.OPENCLAW_SKIP_CHANNELS = "1";
  process.env.OPENCLAW_SKIP_CRON = "1";
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  if (!configPath) {
    throw new Error("Gateway fixture did not install its config path");
  }
  await fs.writeFile(
    configPath,
    JSON.stringify({
      plugins: {
        enabled: true,
        allow: ["instance-binding-probe"],
        entries: { "instance-binding-probe": { enabled: true } },
      },
    }),
  );
  return { coordinator };
}

describe("Gateway background service context", () => {
  const started: Array<Awaited<ReturnType<typeof startTestGatewayServer>>> = [];
  const sockets: Array<Awaited<ReturnType<typeof connectWebchatClient>>> = [];
  afterEach(async () => {
    const closing = sockets.splice(0).map((socket) => {
      const done =
        socket.readyState === socket.CLOSED
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              socket.once("close", resolve);
            });
      socket.close();
      return done;
    });
    try {
      for (const server of started.splice(0).toReversed()) {
        await server.close({ reason: "service context fixture cleanup" });
      }
      await Promise.all(closing);
    } finally {
      clearInstanceBindingProbeCoordinators();
      delete process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;
    }
  });

  it(
    "detaches cold and authenticated reload service startup while preserving ordinary RPC scope",
    { timeout: 600_000 },
    async () => {
      const { coordinator } = await prepareInstanceBindingTest();
      const probe: NonNullable<InstanceBindingProbeCoordinator["serviceScopeProbe"]> = {
        read() {
          const scope = getPluginRuntimeGatewayRequestScope();
          const context = scope?.resolveGatewayContext?.();
          return {
            pluginId: scope?.pluginId,
            ...(scope?.pluginRegistry
              ? { registryId: coordinator.identify(scope.pluginRegistry) }
              : {}),
            ...(context?.sessionCompanion
              ? { sessionsId: coordinator.identify(context.sessionCompanion) }
              : {}),
            hasClient: Boolean(scope?.client),
            hasContext: Boolean(scope?.context),
            isWebchat: Boolean(scope?.isWebchatConnect(scope.client?.connect)),
          };
        },
        starts: [],
        wakes: new Map(),
        stops: [],
      };
      coordinator.serviceScopeProbe = probe;
      const port = await getFreePort();
      const server = await startTestGatewayServer(port, {
        auth: { mode: "none" },
        controlUiEnabled: false,
        sidecarStartup: "start",
      });
      started.push(server);
      await server.startupSettled;
      expect(probe.starts).toHaveLength(1);
      const cold = probe.starts[0]!;
      expect(cold.scope).toMatchObject({
        pluginId: "instance-binding-probe",
        hasClient: false,
        hasContext: false,
        isWebchat: false,
      });
      expect(cold.scope.registryId).toBe(coordinator.identify(getActivePluginRegistry()!));
      expect.soft(cold.scope.sessionsId).toBeTypeOf("number");
      const oldWake = probe.wakes.get(cold.registryId)!;
      const { runtime: oldRuntime } = await requireBoundRuntime(coordinator.runtimes, "cold");
      const socket = await connectWebchatClient({ port, scopes: ["operator.admin"] });
      sockets.push(socket);
      const before = await rpcReq<InstanceBindingProbeResult>(
        socket,
        INSTANCE_BINDING_PROBE_METHOD,
        {},
      );
      expect(before.ok, before.error?.message).toBe(true);
      expect(before.payload?.requestScope).toMatchObject({ hasClient: true, hasContext: true });
      expect(before.payload?.serviceScope).toEqual(cold.scope);
      const reload = await rpcReq(socket, "plugins.reload", {
        plugins: [{ pluginId: "instance-binding-probe" }],
      });
      expect(reload.ok, reload.error?.message).toBe(true);
      expect(probe.starts).toHaveLength(2);
      const replacement = probe.starts[1]!;
      expect(replacement.scope).toMatchObject({
        pluginId: "instance-binding-probe",
        hasClient: false,
        hasContext: false,
        isWebchat: false,
        sessionsId: cold.scope.sessionsId,
      });
      expect(replacement.scope.registryId).toBe(coordinator.identify(getActivePluginRegistry()!));
      expect(replacement.scope.registryId).not.toBe(cold.scope.registryId);
      const after = await rpcReq<InstanceBindingProbeResult>(
        socket,
        INSTANCE_BINDING_PROBE_METHOD,
        {},
      );
      expect(after.ok, after.error?.message).toBe(true);
      expect(after.payload?.requestScope).toMatchObject({ hasClient: true, hasContext: true });
      expect(after.payload?.serviceScope).toEqual(replacement.scope);
      expect(probe.stops).toEqual([cold.registryId]);
      expect(() => oldWake()).toThrow("service stopped");
      await expect(requestInstanceBindingProbe(oldRuntime)).rejects.toThrow(
        /retir|active|unavailable|disposed/i,
      );
      console.info(
        "SERVICE_CONTEXT_PROOF:" +
          JSON.stringify({
            cold,
            replacement,
            before: before.payload,
            after: after.payload,
            stops: probe.stops,
          }),
      );
    },
  );
});

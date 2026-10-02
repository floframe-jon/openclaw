import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";
import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.js";
import { refreshPreparedModelRuntimeSnapshots } from "../agents/prepared-model-runtime.js";
import { closePreparedModelRuntimeSnapshots } from "../agents/prepared-model-runtime.lifecycle.js";
import { createDefaultDeps } from "../cli/deps.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import { createPluginRuntimeResolver } from "../plugins/registry-runtime.js";
import { createPluginRegistryState } from "../plugins/registry-state.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { startPluginServices, type PluginServicesHandle } from "../plugins/services.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { seedInstalledPluginIndex } from "../plugins/test-helpers/installed-plugin-index.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createInternalAgentTurnFacade } from "./agent-turn/internal-facade.js";
import { createChatRunState } from "./server-chat-state.js";
import type { GatewayRequestContext, GatewayRequestOptions } from "./server-methods/types.js";
import { withOperatorToolGatewayAuthority } from "./server-plugin-in-process-dispatch.js";
import {
  createGatewaySubagentRuntime,
  resolvePluginSubagentOverridePolicies,
} from "./server-plugin-subagent-runtime.js";

const PLUGIN_ID = "service-worker";
const HARNESS_ID = "service-native";
const PROVIDER = "service-proof";
const MODEL = "subscription-model";

describe("service-owned public subagent native authorization", () => {
  it.each(["cold", "request", "operator-tool"] as const)(
    "uses configured native selection from %s startup and a later client wake",
    async (startup) => {
      await withOpenClawTestState({ label: "plugin-service-native" }, async (state) => {
        const worktree = state.path("worker-worktree");
        await fs.mkdir(worktree);
        const pluginDir = state.statePath("extensions", PLUGIN_ID);
        await fs.mkdir(pluginDir, { recursive: true });
        const fixtureChannel = channel(`openclaw.service-native:${state.root}`);
        const attempts: Array<{
          provider: string;
          modelId: string;
          cwd?: string;
          agentHarnessId?: string;
        }> = [];
        const observeAttempt = (message: unknown) => {
          attempts.push(message as (typeof attempts)[number]);
        };
        await fs.writeFile(
          `${pluginDir}/openclaw.plugin.json`,
          JSON.stringify({
            id: PLUGIN_ID,
            activation: { onStartup: false, onAgentHarnesses: [HARNESS_ID] },
            configSchema: { type: "object", additionalProperties: false },
          }),
        );
        await fs.writeFile(
          `${pluginDir}/package.json`,
          JSON.stringify({
            name: "@openclaw/service-worker-fixture",
            version: "1.0.0",
            type: "module",
            openclaw: { extensions: ["./index.js"] },
          }),
        );
        // The generated plugin replaces only inference. The host owns loading,
        // native admission, model selection, session storage, and command dispatch.
        await fs.writeFile(
          `${pluginDir}/index.js`,
          `
          import { channel } from "node:diagnostics_channel";
          export default {
            id: ${JSON.stringify(PLUGIN_ID)},
            register(api) {
              api.registerAgentHarness({
                id: ${JSON.stringify(HARNESS_ID)}, label: "Synthetic native service harness",
                authBootstrap: "harness", supports: () => ({ supported: true }),
                loadModelCatalog: async () => [{ provider: ${JSON.stringify(PROVIDER)}, id: ${JSON.stringify(MODEL)}, name: "Synthetic subscription model", nativeRuntime: ${JSON.stringify(HARNESS_ID)} }],
                readModelCatalogReadiness: () => ({ accountType: "subscription", authMode: "oauth" }),
                async runAttempt(params) {
                  channel(${JSON.stringify(fixtureChannel.name)}).publish({ provider: params.provider, modelId: params.modelId, cwd: params.cwd, agentHarnessId: params.agentHarnessId });
                  const assistant = {
                    role: "assistant", content: [{ type: "text", text: "native service proof" }],
                    api: "openai-responses", provider: ${JSON.stringify(PROVIDER)}, model: ${JSON.stringify(MODEL)},
                    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
                    stopReason: "stop", timestamp: Date.now(),
                  };
                  return {
                    terminal: { kind: "ok" }, sessionIdUsed: params.sessionId,
                    messagesSnapshot: [assistant], assistantTexts: ["native service proof"], toolMetas: [], lastAssistant: assistant,
                    didSendViaMessagingTool: false, messagingToolSentTexts: [], messagingToolSentMediaUrls: [], messagingToolSentTargets: [],
                    cloudCodeAssistFormatError: false, replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
                    itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
                  };
                },
              });
            },
          };
        `,
        );
        const config: OpenClawConfig = {
          plugins: {
            enabled: true,
            allow: [PLUGIN_ID],
            slots: { memory: "none" },
            entries: {
              [PLUGIN_ID]: {
                enabled: true,
                subagent: {
                  allowModelOverride: true,
                  allowedModels: [`${PROVIDER}/${MODEL}`],
                },
              },
            },
          },
          models: {
            providers: {
              [PROVIDER]: {
                api: "openai-responses",
                baseUrl: "https://example.invalid/v1",
                models: [
                  {
                    id: MODEL,
                    name: "Synthetic subscription model",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 128_000,
                    maxTokens: 4096,
                  },
                ],
              },
            },
          },
          agents: {
            defaults: {
              workspace: state.workspaceDir,
              model: { primary: `${PROVIDER}/${MODEL}` },
              models: { [`${PROVIDER}/${MODEL}`]: { agentRuntime: { id: HARNESS_ID } } },
              modelPolicy: { allow: [`${PROVIDER}/${MODEL}`] },
            },
            list: [{ id: "main", default: true }],
          },
        };
        await state.writeConfig(config);
        await seedInstalledPluginIndex(
          { [PLUGIN_ID]: { source: "path", sourcePath: pluginDir, installPath: pluginDir } },
          {
            stateDir: state.stateDir,
            config,
            candidates: [
              {
                idHint: PLUGIN_ID,
                source: `${pluginDir}/index.js`,
                rootDir: pluginDir,
                origin: "global",
              },
            ],
          },
        );
        setRuntimeConfigSnapshot(config);
        const work = new AsyncWorkScope();
        const context = {
          trackExecution: (run: () => Promise<unknown>) => work.track(run),
          deps: createDefaultDeps(),
          dedupe: new Map(),
          addChatRun: vi.fn(),
          removeChatRun: vi.fn(),
          chatAbortControllers: new Map(),
          chatQueuedTurns: new Map(),
          chatRunState: createChatRunState(),
          agentRunSeq: new Map(),
          broadcast: vi.fn(),
          nodeSendToSession: vi.fn(),
          broadcastToConnIds: vi.fn(),
          getSessionEventSubscriberConnIds: () => new Set(),
          getRuntimeConfig: () => config,
          logGateway: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        } as unknown as GatewayRequestContext;
        context.createAgentTurnFacade = (principal) =>
          createInternalAgentTurnFacade({ ...principal, getContext: () => context });
        const lifetime = new AbortController();
        const resolveContext = () => (lifetime.signal.aborted ? undefined : context);
        context.resolveGatewayContext = resolveContext;
        const subagent = createGatewaySubagentRuntime(
          resolveContext,
          resolvePluginSubagentOverridePolicies(config),
          lifetime.signal,
        );
        const hostRuntime = createPluginRuntime({ subagent });
        const registryState = createPluginRegistryState({
          coreGatewayMethodNames: [],
          logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
          runtime: hostRuntime,
        });
        const registry = registryState.registry;
        const record = createPluginRecord({
          id: PLUGIN_ID,
          origin: "global",
          rootDir: pluginDir,
          source: `${pluginDir}/index.js`,
        });
        registry.plugins.push(record);
        const instance = new PluginInstance(record.id, { record, registry });
        const runtime = createPluginRuntimeResolver(registryState).resolvePluginRuntime(record);
        let snapshot: ReturnType<typeof AsyncLocalStorage.snapshot> | undefined;
        registry.services.push({
          pluginId: PLUGIN_ID,
          source: record.source,
          origin: record.origin,
          id: "worker-queue",
          service: {
            id: "worker-queue",
            start() {
              snapshot = AsyncLocalStorage.snapshot();
            },
          },
        });
        const previous = captureActivePluginRegistrySnapshot();
        let services: PluginServicesHandle | undefined;
        const caller = {
          client: {
            connId: "read-only-wakeup",
            connect: {
              minProtocol: PROTOCOL_VERSION,
              maxProtocol: PROTOCOL_VERSION,
              role: "operator",
              scopes: ["operator.read"],
              client: { id: "test", mode: "test", platform: "test", version: "1" },
            },
          } as NonNullable<GatewayRequestOptions["client"]>,
          context,
          isWebchatConnect: () => false,
        };
        try {
          fixtureChannel.subscribe(observeAttempt);
          setActivePluginRegistry(registry, "service-native-proof", "explicit", state.workspaceDir);
          await refreshPreparedModelRuntimeSnapshots(config, { gatewayLifecycle: true });
          const start = async () => {
            services = await startPluginServices({ registry, config });
          };
          if (startup === "operator-tool") {
            await withPluginRuntimeGatewayRequestScope(caller, () =>
              withOperatorToolGatewayAuthority(
                {
                  authenticatedUserProfile: {
                    profileId: "synthetic-reader",
                    displayName: "Synthetic reader",
                    hasAvatar: false,
                    updatedAt: 1,
                  },
                  scopes: ["operator.read"],
                },
                start,
              ),
            );
          } else if (startup === "request") {
            await withPluginRuntimeGatewayRequestScope(caller, start);
          } else {
            await start();
          }
          const run = (id: string, model = MODEL, cwd = worktree) =>
            runtime.subagent.run({
              sessionKey: `agent:main:${id}`,
              message: "native authorization proof",
              provider: PROVIDER,
              model,
              cwd,
              idempotencyKey: id,
              promptMode: "minimal",
              deliver: false,
            });
          if (!snapshot || !services) {
            throw new Error("service startup did not produce its handle and owned callback");
          }
          const wake = snapshot;
          await expect(wake(() => run(`startup-${startup}`))).resolves.toMatchObject({
            runId: `startup-${startup}`,
          });
          const terminal = await wake(() =>
            runtime.subagent.waitForRun({ runId: `startup-${startup}`, timeoutMs: 10_000 }),
          );
          expect(terminal.status, terminal.error).toBe("ok");
          expect(attempts).toHaveLength(1);
          expect(attempts[0]).toMatchObject({
            provider: PROVIDER,
            modelId: MODEL,
            cwd: worktree,
            agentHarnessId: HARNESS_ID,
          });
          await withPluginRuntimeGatewayRequestScope(caller, async () => {
            await expect(wake(() => run(`later-${startup}`))).resolves.toMatchObject({
              runId: `later-${startup}`,
            });
            await expect(
              wake(() =>
                runtime.subagent.waitForRun({ runId: `later-${startup}`, timeoutMs: 10_000 }),
              ),
            ).resolves.toMatchObject({ status: "ok" });
          });
          expect(attempts).toHaveLength(2);
          await expect(wake(() => run("forbidden-model", "not-allowlisted"))).rejects.toThrow(
            /allowlist/,
          );
          await expect(
            wake(() => run("relative-worktree", MODEL, "relative/worktree")),
          ).rejects.toThrow(/cwd must be absolute/);
          expect(attempts).toHaveLength(2);
          lifetime.abort(new Error("retired native runtime"));
          await expect(wake(() => run("retired-host"))).rejects.toThrow(/retired|binding|abort/i);
          await services.stop();
          services = undefined;
          await instance.dispose();
          await expect(wake(() => run("retired-plugin"))).rejects.toThrow(
            /active|unavailable|retired|reloaded|disabled/i,
          );
          expect(attempts).toHaveLength(2);
        } finally {
          lifetime.abort();
          await services?.stop();
          await work.drain();
          await instance.dispose();
          await closePreparedModelRuntimeSnapshots();
          restoreActivePluginRegistrySnapshot(previous);
          fixtureChannel.unsubscribe(observeAttempt);
        }
      });
    },
  );
});

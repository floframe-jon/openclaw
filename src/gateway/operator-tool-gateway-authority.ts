import { AsyncLocalStorage } from "node:async_hooks";
import type { GatewayOperatorRoleActor } from "./server-methods/shared-types.js";
import type { GatewayRequestOptions } from "./server-methods/types.js";

type OperatorToolGatewayAuthority = {
  authenticatedUserProfile: NonNullable<
    NonNullable<GatewayRequestOptions["client"]>["authenticatedUserProfile"]
  >;
  scopes: readonly string[];
  operatorRoleActor?: GatewayOperatorRoleActor;
  signal: AbortSignal;
};

export const operatorToolGatewayAuthority = new AsyncLocalStorage<OperatorToolGatewayAuthority>();

/** Retains operator attribution and authority only for the awaited tool invocation. */
export async function withOperatorToolGatewayAuthority<T>(
  authority: Omit<OperatorToolGatewayAuthority, "signal">,
  run: () => Promise<T>,
): Promise<T> {
  const lifetime = new AbortController();
  try {
    return await operatorToolGatewayAuthority.run({ ...authority, signal: lifetime.signal }, run);
  } finally {
    lifetime.abort(new Error("operator tool invocation authority expired"));
  }
}

/** Host-owned background work must not retain its initiating tool invocation. */
export function runWithoutOperatorToolGatewayAuthority<T>(run: () => T): T {
  return operatorToolGatewayAuthority.exit(run);
}

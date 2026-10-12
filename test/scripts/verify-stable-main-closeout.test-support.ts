import { spawnSync } from "node:child_process";
import path from "node:path";

export function runWithdrawnCloseoutFixture(
  args: string[],
  params: { bin: string; lookups: "allowed" | "forbidden" },
) {
  return spawnSync(process.execPath, ["scripts/verify-stable-main-closeout.mjs", ...args], {
    cwd: path.resolve("."),
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_REPOSITORY: "openclaw/openclaw",
      PATH: `${params.bin}:${process.env.PATH}`,
      WITHDRAWAL_LOOKUPS: params.lookups,
    },
  });
}

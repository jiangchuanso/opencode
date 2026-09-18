import { chmodSync, existsSync, statSync } from "node:fs"
import path from "node:path"
import { Flag } from "@opencode-ai/core/flag/flag"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"
import { which } from "@opencode-ai/core/util/which"

type McpEntry = NonNullable<ConfigV1.Info["mcp"]>[string]

// MCP servers that ship inside the CLI package instead of being configured by
// the user. The binaries are vendored at build time by
// packages/opencode/script/vendor-officecli.ts and land next to the compiled
// `opencode` executable, so no download is needed on the host — which is what
// makes them usable on an air-gapped machine.

const OFFICECLI = process.platform === "win32" ? "officecli.exe" : "officecli"

/**
 * Resolve the bundled OfficeCLI binary. Returns undefined when it was not
 * vendored (development checkouts, `--skip-officecli` builds) so the caller can
 * simply omit the server.
 */
export function officeCliBinary(): string | undefined {
  const candidates = [
    // Escape hatch for a non-vendored install and for tests.
    Flag.OPENCODE_OFFICECLI_PATH,
    // Release tarball and platform npm package: sibling of the running CLI.
    path.join(path.dirname(process.execPath), OFFICECLI),
    // A copy the user installed themselves.
    which("officecli"),
  ]

  for (const candidate of candidates) {
    if (!candidate) continue
    if (!existsSync(candidate)) continue
    try {
      if (statSync(candidate).isDirectory()) continue
      // npm tarballs and archive extraction can drop the executable bit.
      if (process.platform !== "win32") chmodSync(candidate, 0o755)
    } catch {
      continue
    }
    return candidate
  }

  return undefined
}

function resolve(): Record<string, ConfigMCPV1.Info> {
  if (Flag.OPENCODE_DISABLE_OFFICECLI) return {}
  const binary = officeCliBinary()
  if (!binary) return {}

  return {
    officecli: {
      type: "local",
      // `officecli mcp` without a target starts the stdio MCP server.
      command: [binary, "mcp"],
      enabled: true,
    },
  }
}

// Resolution stats and chmods paths, so memoize — but keyed on the inputs, so
// flipping the environment at runtime (tests, CLI tooling) still takes effect.
let cached: { key: string; servers: Record<string, ConfigMCPV1.Info> } | undefined

function servers() {
  const key = `${Flag.OPENCODE_DISABLE_OFFICECLI}|${Flag.OPENCODE_OFFICECLI_PATH ?? ""}`
  if (cached?.key !== key) cached = { key, servers: resolve() }
  return cached.servers
}

export const BundledMcp = {
  /** Bundled servers, keyed by MCP server name. */
  servers,
  /**
   * Bundled servers merged underneath user config, so an explicit
   * `mcp.officecli` entry — including `enabled: false` — always wins. Every
   * consumer (startup, status, tool listing, CLI) goes through this so they can
   * never disagree about which servers exist.
   */
  resolved: (cfg: ConfigV1.Info): Record<string, McpEntry> => ({ ...servers(), ...(cfg.mcp ?? {}) }),
  officeCliBinary,
} as const

export * as BundledMcpConfig from "./bundled"

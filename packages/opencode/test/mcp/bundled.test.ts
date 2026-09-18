import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { BundledMcp } from "@/mcp/bundled"

// The bundled binary is vendored next to the compiled CLI and exposed as a local
// stdio MCP server; OPENCODE_OFFICECLI_PATH stands in for the vendored copy so
// the resolution can be exercised without a release artifact.
let dir: string
let binary: string
const previous = {
  path: process.env["OPENCODE_OFFICECLI_PATH"],
  disabled: process.env["OPENCODE_DISABLE_OFFICECLI"],
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "opencode-bundled-mcp-"))
  binary = path.join(dir, process.platform === "win32" ? "officecli.exe" : "officecli")
  writeFileSync(binary, "")
  delete process.env["OPENCODE_DISABLE_OFFICECLI"]
  process.env["OPENCODE_OFFICECLI_PATH"] = binary
})

afterEach(() => {
  if (previous.path === undefined) delete process.env["OPENCODE_OFFICECLI_PATH"]
  else process.env["OPENCODE_OFFICECLI_PATH"] = previous.path
  if (previous.disabled === undefined) delete process.env["OPENCODE_DISABLE_OFFICECLI"]
  else process.env["OPENCODE_DISABLE_OFFICECLI"] = previous.disabled
  rmSync(dir, { recursive: true, force: true })
})

describe("mcp.bundled", () => {
  test("registers the vendored binary as a local stdio MCP server", () => {
    expect(BundledMcp.servers()).toEqual({
      officecli: {
        type: "local",
        command: [binary, "mcp"],
        enabled: true,
      },
    })
  })

  test("resolves bundled servers underneath user config", () => {
    const merged = BundledMcp.resolved({
      mcp: {
        officecli: { type: "local", command: ["custom-officecli", "mcp"], enabled: false },
        other: { type: "remote", url: "https://example.test/mcp" },
      },
    })

    // A user entry — including an explicit disable — always wins.
    expect(merged["officecli"]).toEqual({ type: "local", command: ["custom-officecli", "mcp"], enabled: false })
    expect(merged["other"]).toEqual({ type: "remote", url: "https://example.test/mcp" })
  })

  test("ignores a binary path that does not exist", () => {
    const missing = path.join(dir, "missing-officecli")
    process.env["OPENCODE_OFFICECLI_PATH"] = missing

    expect(BundledMcp.officeCliBinary()).not.toBe(missing)
    expect(BundledMcp.servers()["officecli"]?.command[0]).not.toBe(missing)
  })

  test("registers nothing when the bundled server is disabled", () => {
    process.env["OPENCODE_DISABLE_OFFICECLI"] = "1"

    expect(BundledMcp.servers()).toEqual({})
    expect(BundledMcp.resolved({ mcp: { other: { type: "remote", url: "https://example.test/mcp" } } })).toEqual({
      other: { type: "remote", url: "https://example.test/mcp" },
    })
  })
})

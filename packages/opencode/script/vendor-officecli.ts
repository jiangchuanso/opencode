#!/usr/bin/env bun
//
// Vendors the OfficeCLI binary into each platform build so a host with no
// network still gets Office document tools (see src/mcp/bundled.ts, which
// registers the very same binary as a local MCP server).
//
// The binary is fetched from the official release mirror, verified against the
// published SHA256SUMS, and cached. A cache hit (or a matching file already in
// place) short-circuits the download, which is what makes repeated and offline
// builds work: fetch once somewhere with internet, copy the cache directory to
// the offline machine, and builds will find it here.
//
// Layout: dist/<target>/bin/officecli[.exe] — the same directory the compiled
// opencode binary lives in, so the runtime can resolve it as a sibling.

import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync, rmSync } from "node:fs"
import { chmod, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export const VERSION = process.env["OPENCODE_OFFICECLI_VERSION"] ?? "1.0.123"

const TAG = `v${VERSION.split("+")[0].split("-")[0]}`
const MIRROR_BASE = "https://d.officecli.ai/releases/download"
const GITHUB_BASE = "https://github.com/iOfficeAI/OfficeCLI/releases/download"
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000

export interface Target {
  os: string
  arch: "arm64" | "x64"
  abi?: "musl"
}

/** Release asset name for an opencode build target. */
export function asset(input: Target) {
  if (input.os === "win32") return input.arch === "arm64" ? "officecli-win-arm64.exe" : "officecli-win-x64.exe"
  if (input.os === "darwin") return input.arch === "arm64" ? "officecli-mac-arm64" : "officecli-mac-x64"
  const variant = input.abi === "musl" ? "-alpine" : ""
  return `officecli-linux${variant}-${input.arch}`
}

/** File name the binary is vendored as, next to the compiled opencode binary. */
export function binaryName(os: string) {
  return os === "win32" ? "officecli.exe" : "officecli"
}

export function cacheDir() {
  const override = process.env["OPENCODE_OFFICECLI_CACHE"]
  if (override) return override
  // Same convention as the CLI's own cache (xdg-basedir falls back to ~/.cache).
  return path.join(process.env["XDG_CACHE_HOME"] ?? path.join(os.homedir(), ".cache"), "opencode", "officecli")
}

async function exists(file: string) {
  try {
    return (await stat(file)).isFile()
  } catch {
    return false
  }
}

async function sha256(file: string) {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex")
}

async function fetchBytes(url: string) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": "opencode-vendor-officecli" },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`)
  return Buffer.from(await response.arrayBuffer())
}

/**
 * Some build hosts reset the in-process TLS handshake (corporate middleboxes,
 * TLS-inspecting proxies) while a system `curl` reaches the same URL, so fall
 * back to it. curl is preinstalled on Windows 10+, macOS and every supported
 * Linux distribution.
 */
function curlBytes(url: string) {
  const file = path.join(os.tmpdir(), `opencode-vendor-${process.pid}-${Math.random().toString(36).slice(2)}`)
  try {
    // Capture stderr so a failing download reports curl's own diagnosis.
    execFileSync("curl", ["-fsSL", "--retry", "3", "--connect-timeout", "30", "-o", file, url], {
      stdio: ["ignore", "ignore", "pipe"],
    })
    return readFileSync(file)
  } finally {
    rmSync(file, { force: true })
  }
}

async function download(url: string) {
  try {
    return await fetchBytes(url)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.warn(`  fetch failed for ${url} (${reason}), retrying with curl`)
    return curlBytes(url)
  }
}

/** Mirror first (failures surface fast), GitHub as fallback — same order as the upstream installer. */
async function downloadAny(asset: string) {
  const urls = [
    `${MIRROR_BASE}/${TAG}/${asset}`,
    `${GITHUB_BASE}/${TAG}/${asset}`,
  ]
  let last: unknown
  for (const url of urls) {
    try {
      return await download(url)
    } catch (error) {
      last = error
      console.warn(`  ${url} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`Could not download ${asset} @ ${TAG}: ${last instanceof Error ? last.message : String(last)}`)
}

async function checksums(cache: string) {
  const cached = path.join(cache, `${TAG}-SHA256SUMS`)
  if (await exists(cached)) return parse(await readFile(cached, "utf8"))

  const body = await downloadAny("SHA256SUMS")
  await mkdir(cache, { recursive: true })
  await writeFile(cached, body)
  return parse(body.toString("utf8"))
}

function parse(text: string) {
  const result = new Map<string, string>()
  for (const line of text.split("\n")) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 2) continue
    // "<hex>  <name>"; a leading "*" marks binary mode, same rule as the upstream installer.
    result.set(parts[1].replace(/^\*/, ""), parts[0].toLowerCase())
  }
  return result
}

export interface VendorInput {
  target: Target
  outfile: string
}

/**
 * Places the verified binary at `outfile`. Existing binaries that already match
 * the published checksum are left alone so rebuilds stay cheap.
 */
export async function vendorOfficeCli(input: VendorInput) {
  const name = asset(input.target)
  const cache = cacheDir()
  await mkdir(cache, { recursive: true })
  const expected = (await checksums(cache)).get(name)
  if (!expected) throw new Error(`${name} is not listed in ${TAG}/SHA256SUMS`)

  if (await exists(input.outfile)) {
    if ((await sha256(input.outfile)) === expected) return input.outfile
    await rm(input.outfile, { force: true })
  }

  const cached = path.join(cache, `${TAG}-${name}`)
  if (!(await exists(cached)) || (await sha256(cached)) !== expected) {
    await rm(cached, { force: true })
    console.log(`  vendoring ${name} @ ${TAG}`)
    await writeFile(cached, await downloadAny(name))
    const actual = await sha256(cached)
    if (actual !== expected) {
      await rm(cached, { force: true })
      throw new Error(`Checksum mismatch for ${name} (expected ${expected}, got ${actual})`)
    }
  }

  await mkdir(path.dirname(input.outfile), { recursive: true })
  // Copy through a temp file so an interrupted run never leaves a partial binary.
  const temp = `${input.outfile}.${process.pid}.tmp`
  await copyFile(cached, temp)
  if (input.target.os !== "win32") await chmod(temp, 0o755)
  await rename(temp, input.outfile)
  return input.outfile
}

if (import.meta.main) {
  // Standalone: vendor into dist/<opencode-target>/bin for every target.
  const targets: Target[] = [
    { os: "linux", arch: "arm64" },
    { os: "linux", arch: "x64" },
    { os: "linux", arch: "arm64", abi: "musl" },
    { os: "linux", arch: "x64", abi: "musl" },
    { os: "darwin", arch: "arm64" },
    { os: "darwin", arch: "x64" },
    { os: "win32", arch: "arm64" },
    { os: "win32", arch: "x64" },
  ]
  const dist = path.resolve(import.meta.dir, "..", "dist")
  for (const target of targets) {
    const label = `${target.os === "win32" ? "windows" : target.os}-${target.arch}` +
      (target.abi === "musl" ? "-musl" : "")
    const outfile = path.join(dist, `opencode-${label}`, "bin", binaryName(target.os))
    console.log(`officecli -> ${outfile}`)
    await vendorOfficeCli({ target, outfile })
  }
}

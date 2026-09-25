#!/usr/bin/env bun
/**
 * Self extracting entry point for the offline runtime bundle.
 *
 * `script/offline/build.ts --sfx` compiles this file with `bun build --compile`,
 * appends the payload tarball to the result, then appends a 32 byte footer:
 *
 *   [0,16)   "OPENCODE-OFFLINE"
 *   [16,24)  uint64 little endian payload offset
 *   [24,32)  uint64 little endian payload length
 *
 * Running the produced .exe streams the payload out of its own executable and
 * extracts it into the runtime cache directory.
 */
import path from "node:path"
import fs from "node:fs/promises"
import os from "node:os"

const MAGIC = "OPENCODE-OFFLINE"
const FOOTER_SIZE = 32

const argv = process.argv.slice(2)
const value = (name: string) => {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? undefined : argv[index + 1]
}

const fail = (message: string): never => {
  console.error(`opencode offline bundle: ${message}`)
  process.exit(1)
}

const target = value("target") ?? path.join(os.homedir(), ".cache", "opencode")
const executable = process.execPath

const size = (await fs.stat(executable)).size
if (size < FOOTER_SIZE) fail("this executable does not contain an offline payload")

const handle = await fs.open(executable, "r")
const footer = Buffer.alloc(FOOTER_SIZE)
await handle.read(footer, 0, FOOTER_SIZE, size - FOOTER_SIZE)
await handle.close()

if (footer.subarray(0, MAGIC.length).toString("utf8") !== MAGIC) fail("this executable does not contain an offline payload")

const offset = Number(footer.readBigUInt64LE(16))
const length = Number(footer.readBigUInt64LE(24))
if (length <= 0 || offset + length > size) fail("this executable has a corrupt offline payload footer")

if (argv.includes("--dry-run")) {
  console.log(`payload ${(length / 1024 / 1024).toFixed(1)} MB -> ${target}`)
  process.exit(0)
}

const archive = path.join(os.tmpdir(), `opencode-offline-${process.pid}.tar.gz`)
console.log(`opencode offline bundle: extracting ${(length / 1024 / 1024).toFixed(1)} MB into ${target}`)

await Bun.write(archive, Bun.file(executable).slice(offset, offset + length))
await fs.mkdir(target, { recursive: true })

const tar = Bun.which("tar") ?? "tar"
const extracted = await Bun.spawn([tar, "-xzf", archive, "-C", target], {
  stdout: "inherit",
  stderr: "inherit",
}).exited
await fs.rm(archive, { force: true })

if (extracted !== 0) fail(`tar exited with ${extracted}; nothing was installed`)

console.log("opencode offline bundle: installed")
console.log("")
console.log("Set OPENCODE_OFFLINE=1 before starting opencode so every best-effort")
console.log("remote call (catalog, update check, LSP and package downloads) is skipped.")
console.log("Override the destination with --target <dir> if the cache lives elsewhere.")

#!/usr/bin/env bun
/**
 * Builds the offline runtime bundle for air-gapped hosts.
 *
 * The payload mirrors the runtime cache layout (`<cache>/opencode`), so on the
 * target machine it is enough to extract it into that directory:
 *
 *   Linux/macOS   <home>/.cache/opencode        (XDG_CACHE_HOME wins)
 *   Windows       %USERPROFILE%\.cache\opencode
 *
 * `xdg-basedir` resolves `~/.cache` on every platform (see node_modules/xdg-basedir/index.js),
 * and both `which()` and `Npm.which()` look inside those directories first.
 *
 * Outputs, under `--out` (default `dist/offline`):
 *   opencode-offline-<platform>-<arch>.tar.gz   universal payload
 *   opencode-offline-<platform>-<arch>.exe      Windows self extracting (--sfx)
 *   opencode-offline_<version>_<arch>.deb       Debian package (--deb)
 *   REPORT.txt                                  what was staged, skipped and why
 *
 * Examples:
 *   bun run script/offline/build.ts --list
 *   bun run script/offline/build.ts --platform win32 --arch x64 --sfx
 *   bun run script/offline/build.ts --platform linux --arch arm64 --deb
 */
import path from "node:path"
import fs from "node:fs/promises"
import { createReadStream, createWriteStream } from "node:fs"
import { pipeline } from "node:stream/promises"
import {
  COMPONENTS,
  PATH_ONLY_SERVERS,
  exists,
  githubFetch,
  type Arch,
  type Component,
  type Context,
  type ExtractOptions,
  type Platform,
  type RunOptions,
  type Target,
} from "./manifest"
import pkg from "../../package.json"

const argv = process.argv.slice(2)
const flag = (name: string) => argv.includes(`--${name}`)
const value = (name: string) => {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? undefined : argv[index + 1]
}
const list = (name: string) =>
  value(name)
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean)

if (flag("list")) {
  for (const component of COMPONENTS) {
    const marks = [component.requiresHost ? "host" : "", component.optional ? "optional" : ""].filter(Boolean).join(",")
    console.log(`${component.id.padEnd(16)} ${marks.padEnd(16)} ${component.description}`)
  }
  console.log(`\npath-only servers (never downloaded by opencode): ${PATH_ONLY_SERVERS.join(", ")}`)
  process.exit(0)
}

const platform = (value("platform") ?? process.platform) as Platform
const arch = (value("arch") ?? process.arch) as Arch
if (!["linux", "darwin", "win32"].includes(platform)) throw new Error(`unsupported platform: ${platform}`)
if (!["x64", "arm64"].includes(arch)) throw new Error(`unsupported arch: ${arch}`)

const target: Target = { platform, arch }
const hostMatches = platform === process.platform && arch === process.arch
if (!hostMatches && !flag("allow-cross")) {
  throw new Error(
    `building ${platform}-${arch} on ${process.platform}-${process.arch} skips every npm and toolchain component ` +
      `(the .bin shims are host specific). Re-run on a ${platform}-${arch} host, or pass --allow-cross for an archive-only payload.`,
  )
}
const out = path.resolve(value("out") ?? path.join(import.meta.dirname, "..", "..", "dist", "offline"))
const name = `opencode-offline-${platform}-${arch}`
const work = path.join(out, `.work-${platform}-${arch}`)
const root = path.join(work, "payload")
const temp = path.join(work, "tmp")

const only = list("only")
const skip = list("skip")
const report: string[] = []
const log = (message: string) => console.log(`[offline] ${message}`)
const note = (message: string) => {
  console.log(`[offline] ${message}`)
  report.push(message)
}

const quote = (input: string) => input.replaceAll("'", "''")

async function run(cmd: string[], options: RunOptions = {}) {
  const proc = Bun.spawn(cmd, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
  if (code !== 0) throw new Error(`command failed (${code}): ${cmd.join(" ")}\n${stderr.trim()}`)
  return code
}

async function runNothrow(cmd: string[], options: RunOptions = {}) {
  const proc = Bun.spawn(cmd, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  })
  return proc.exited
}

async function download(url: string, destination: string) {
  const response = await githubFetch(url, { "user-agent": "opencode-offline-bundle" })
  if (!response.ok) throw new Error(`download failed (${response.status}): ${url}`)
  await fs.mkdir(path.dirname(destination), { recursive: true })
  await Bun.write(destination, response)
}

async function extract(archive: string, destination: string, options: ExtractOptions = {}) {
  await fs.mkdir(destination, { recursive: true })
  if (archive.toLowerCase().endsWith(".zip")) {
    if (options.strip) throw new Error(`strip is not supported for zip archives: ${archive}`)
    if (process.platform === "win32") {
      const script = [
        "$global:ProgressPreference = 'SilentlyContinue'",
        `Expand-Archive -LiteralPath '${quote(archive)}' -DestinationPath '${quote(destination)}' -Force`,
      ].join("; ")
      await run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script])
      return
    }
    await run(["unzip", "-o", "-q", archive, "-d", destination])
    return
  }
  const args = ["-xf", archive, "-C", destination]
  if (options.strip) args.push(`--strip-components=${options.strip}`)
  await run(["tar", ...args])
}

async function npm(packageName: string) {
  const dir = path.join(root, "packages", packageName)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, "package.json"),
    `${JSON.stringify({ name: `opencode-offline-${packageName.replaceAll("@", "").replaceAll("/", "-")}`, private: true }, null, 2)}\n`,
  )
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm"
  await run([
    npmCommand,
    "install",
    "--prefix",
    dir,
    "--no-audit",
    "--no-fund",
    "--no-package-lock",
    "--loglevel=error",
    `${packageName}@latest`,
  ])
}

const ctx: Context = {
  target,
  root,
  temp,
  hostMatches,
  log,
  run,
  runNothrow,
  text: async (cmd, options = {}) => {
    const proc = Bun.spawn(cmd, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()])
    if (code !== 0) throw new Error(`command failed (${code}): ${cmd.join(" ")}`)
    return stdout
  },
  download,
  extract,
  npm,
}

async function match(artifact: string) {
  // Components declare artifacts relative to the payload root; resolve them
  // there instead of against the working directory the script was started from.
  const resolved = path.resolve(root, artifact)
  if (!resolved.includes("*")) return exists(resolved)
  const relative = path.relative(root, resolved)
  for await (const _ of new Bun.Glob(relative).scan({ cwd: root, dot: true })) return true
  return false
}

/**
 * The runtime only skips its download when the exact path it checks already
 * exists, so every component has to prove its artifacts landed there.
 */
async function verify(component: Component) {
  const missing: string[] = []
  for (const artifact of component.artifacts(ctx)) {
    if (!(await match(artifact))) missing.push(path.relative(root, artifact))
  }
  return missing
}

await fs.rm(work, { recursive: true, force: true })
await fs.mkdir(root, { recursive: true })
await fs.mkdir(temp, { recursive: true })

log(`target ${platform}-${arch}${hostMatches ? "" : " (cross build)"}`)
log(`payload ${root}`)

const selected = COMPONENTS.filter(
  (component) => (only ? only.includes(component.id) : true) && !(skip ?? []).includes(component.id),
)
const staged: Component[] = []

for (const component of selected) {
  if (component.requiresHost && !hostMatches) {
    note(`skipped  ${component.id}: needs a ${platform}-${arch} build host (re-run on that host)`)
    continue
  }
  process.stdout.write(`[offline] staging  ${component.id} ... `)
  try {
    await component.run(ctx)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const lines = message.split("\n")
    console.log("failed")
    if (!component.optional) {
      report.push(`failed   ${component.id}: ${lines[0]}`)
      throw error
    }
    note(`warning  ${component.id}: ${lines[0]}`)
    continue
  }
  const missing = await verify(component)
  if (missing.length > 0) {
    console.log("incomplete")
    if (!component.optional) {
      report.push(`failed   ${component.id}: expected ${missing.join(", ")}`)
      throw new Error(`${component.id} did not produce ${missing.join(", ")}`)
    }
    note(`warning  ${component.id}: missing ${missing.join(", ")}`)
    continue
  }
  console.log("ok")
  report.push(`staged   ${component.id}`)
  staged.push(component)
}

if (!flag("no-models")) {
  process.stdout.write("[offline] staging  models.json ... ")
  try {
    await download("https://models.dev/api.json", path.join(root, "models.json"))
    console.log("ok")
    report.push("staged   models.json")
  } catch (error) {
    console.log("skipped")
    note(`warning  models.json: ${error instanceof Error ? error.message : String(error)}`)
  }
}

await fs.rm(temp, { recursive: true, force: true })
await fs.mkdir(out, { recursive: true })

const lines = [
  `opencode offline runtime bundle`,
  `version:  ${pkg.version}`,
  `target:   ${platform}-${arch}`,
  `built on: ${process.platform}-${process.arch}`,
  `host match: ${hostMatches}`,
  "",
  ...report,
  "",
  "install",
  `  Linux/macOS  tar -xzf ${name}.tar.gz -C "\${XDG_CACHE_HOME:-$HOME/.cache}/opencode"`,
  `  Windows      ${name}.exe`,
  "",
  `path-only servers (install the language toolchain yourself, opencode never downloads them):`,
  `  ${PATH_ONLY_SERVERS.join(", ")}`,
  "",
  "verify on the target host: OPENCODE_OFFLINE=1 with lsp enabled; the runtime logs",
  "'enabled LSP servers' and any server it could not start is marked broken in-session.",
  "",
].join("\n")
await fs.writeFile(path.join(out, "REPORT.txt"), lines)

const tarball = path.join(out, `${name}.tar.gz`)
await run(["tar", "-czf", tarball, "-C", root, "."])
log(`wrote ${tarball}`)

if (flag("sfx")) {
  if (platform !== "win32") throw new Error("--sfx only supports a win32 target")
  const stub = path.join(work, `stub-${arch}.exe`)
  const sfx = path.join(out, `${name}.exe`)
  await run([
    process.execPath,
    "build",
    path.join(import.meta.dirname, "sfx.ts"),
    "--compile",
    "--minify",
    "--outfile",
    stub,
    `--target=bun-windows-${arch}`,
  ])
  await fs.copyFile(stub, sfx)
  const stubSize = (await fs.stat(stub)).size
  const payloadSize = (await fs.stat(tarball)).size
  await pipeline(createReadStream(tarball), createWriteStream(sfx, { flags: "a" }))
  const footer = Buffer.alloc(32)
  footer.write("OPENCODE-OFFLINE", 0, "utf8")
  footer.writeBigUInt64LE(BigInt(stubSize), 16)
  footer.writeBigUInt64LE(BigInt(payloadSize), 24)
  await fs.appendFile(sfx, footer)
  log(`wrote ${sfx} (${Math.round((stubSize + payloadSize) / 1024 / 1024)} MB)`)
}

if (flag("deb")) {
  if (platform !== "linux") throw new Error("--deb only supports a linux target")
  const debArch = arch === "arm64" ? "arm64" : "amd64"
  const debRoot = path.join(work, "deb")
  const payloadDir = path.join(debRoot, "usr", "lib", "opencode", "offline")
  await fs.mkdir(path.dirname(payloadDir), { recursive: true })
  await fs.cp(root, payloadDir, { recursive: true })
  await fs.mkdir(path.join(debRoot, "DEBIAN"), { recursive: true })
  await fs.mkdir(path.join(debRoot, "usr", "bin"), { recursive: true })
  await fs.writeFile(
    path.join(debRoot, "DEBIAN", "control"),
    [
      "Package: opencode-offline-runtime",
      `Version: ${pkg.version}`,
      "Section: devel",
      "Priority: optional",
      `Architecture: ${debArch}`,
      "Maintainer: opencode",
      "Depends: tar",
      "Description: Prefetched runtime downloads for offline opencode.",
      " Ships the language servers, ripgrep and the model catalog that opencode",
      " would otherwise fetch from the network on first use, and copies them into",
      " each user's cache directory.",
      "",
    ].join("\n"),
  )
  await fs.writeFile(
    path.join(debRoot, "DEBIAN", "postinst"),
    ["#!/bin/sh", "set -e", "/usr/bin/opencode-offline-apply --all || true", "exit 0", ""].join("\n"),
    { mode: 0o755 },
  )
  await fs.writeFile(path.join(debRoot, "usr", "bin", "opencode-offline-apply"), applyScript(), { mode: 0o755 })
  const deb = path.join(out, `opencode-offline_${pkg.version}_${debArch}.deb`)
  await run(["dpkg-deb", "--build", "--root-owner-group", debRoot, deb])
  log(`wrote ${deb}`)
}

log("done")
for (const line of report) log(line)

/**
 * Copies the packaged payload into each user's cache directory. The package
 * cannot know every account up front, so this stays available after install for
 * accounts created later (`opencode-offline-apply`).
 */
function applyScript() {
  return `#!/bin/sh
# Copies the prefetched opencode runtime payload into a user's cache directory.
# Usage: opencode-offline-apply [--all]
set -e

SOURCE=/usr/lib/opencode/offline

apply_user() {
  home=$1
  account=$2
  [ -n "$home" ] || return 0
  [ -d "$home" ] || return 0
  target="\${XDG_CACHE_HOME:-$home/.cache}/opencode"
  mkdir -p "$target"
  cp -a "$SOURCE/." "$target/"
  chown -R "$account" "$target" 2>/dev/null || true
}

case "$1" in
  --all)
    if command -v getent >/dev/null 2>&1; then
      getent passwd | while IFS=: read -r name _ uid _ _ home shell; do
        [ "$uid" -ge 1000 ] || continue
        case "$shell" in */nologin|*/false) continue ;; esac
        [ -d "$home" ] || continue
        echo "opencode-offline: apply to $name ($home)"
        apply_user "$home" "$name"
      done
    else
      apply_user "$HOME" "$(id -un)"
    fi
    ;;
  *)
    apply_user "$HOME" "$(id -un)"
    ;;
esac
`
}

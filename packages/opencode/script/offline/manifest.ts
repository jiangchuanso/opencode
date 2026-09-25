/**
 * Offline runtime bundle recipes.
 *
 * Each component reproduces what the runtime would download or install on first
 * use, but stages the result into a payload tree that mirrors the runtime cache
 * layout (`<cache>/opencode`). An offline host then only needs the payload
 * copied into place; nothing is downloaded at runtime.
 *
 * Keep this in sync with `src/lsp/server.ts` and `packages/core/src/ripgrep/binary.ts`.
 * `artifacts` mirrors the "already installed" check a server performs before it
 * reaches for the network, so a green build guarantees an offline hit.
 */
import path from "node:path"
import fs from "node:fs/promises"

export type Platform = "linux" | "darwin" | "win32"
export type Arch = "x64" | "arm64"

export interface Target {
  readonly platform: Platform
  readonly arch: Arch
}

export interface RunOptions {
  readonly cwd?: string
  readonly env?: Record<string, string>
}

export interface ExtractOptions {
  readonly strip?: number
}

export interface Context {
  readonly target: Target
  /** Payload root. Mirrors the runtime `<cache>/opencode` directory. */
  readonly root: string
  /** Scratch space, wiped between builds. */
  readonly temp: string
  readonly hostMatches: boolean
  readonly log: (message: string) => void
  readonly run: (cmd: string[], options?: RunOptions) => Promise<number>
  readonly runNothrow: (cmd: string[], options?: RunOptions) => Promise<number>
  readonly text: (cmd: string[], options?: RunOptions) => Promise<string>
  readonly download: (url: string, destination: string) => Promise<void>
  readonly extract: (archive: string, destination: string, options?: ExtractOptions) => Promise<void>
  /** Install an npm package so `Npm.which(pkg)` resolves without network. */
  readonly npm: (pkg: string) => Promise<void>
}

export interface Component {
  readonly id: string
  readonly description: string
  /** Can only be produced on a matching host; skipped (with a warning) when crossing. */
  readonly requiresHost?: boolean
  /** A failure is reported as a warning instead of aborting the build. */
  readonly optional?: boolean
  readonly run: (ctx: Context) => Promise<void>
  /** Paths (glob allowed) that must exist under the payload root. */
  readonly artifacts: (ctx: Context) => string[]
}

export async function exists(file: string) {
  return fs
    .stat(file)
    .then(() => true)
    .catch(() => false)
}

async function copy(source: string, destination: string) {
  await fs.mkdir(path.dirname(destination), { recursive: true })
  await fs.copyFile(source, destination)
  if (process.platform !== "win32") await fs.chmod(destination, 0o755).catch(() => {})
}

const exe = (ctx: Context) => (ctx.target.platform === "win32" ? ".exe" : "")
const bin = (ctx: Context, ...parts: string[]) => path.join(ctx.root, "bin", ...parts)
const npmDir = (ctx: Context, name: string) => path.join(ctx.root, "packages", name)
const npmBin = (ctx: Context, name: string, command: string) =>
  path.join(npmDir(ctx, name), "node_modules", ".bin", command)

interface Asset {
  readonly name: string
  readonly browser_download_url: string
}

interface Release {
  readonly tag: string
  readonly name: string
  readonly assets: Asset[]
}

async function release(repo: string): Promise<Release> {
  const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { "user-agent": "opencode-offline-bundle", accept: "application/vnd.github+json" },
  })
  if (!response.ok) throw new Error(`github release lookup failed for ${repo} (${response.status})`)
  const raw = (await response.json()) as {
    tag_name?: unknown
    name?: unknown
    assets?: { name?: unknown; browser_download_url?: unknown }[]
  }
  return {
    tag: typeof raw.tag_name === "string" ? raw.tag_name : "",
    name: typeof raw.name === "string" ? raw.name : "",
    assets: (raw.assets ?? []).flatMap((item) =>
      typeof item.name === "string" && typeof item.browser_download_url === "string"
        ? [{ name: item.name, browser_download_url: item.browser_download_url }]
        : [],
    ),
  }
}

function requireAsset(input: Release, wanted: string, repo: string) {
  const asset = input.assets.find((item) => item.name === wanted)
  if (!asset) throw new Error(`${repo} ${input.tag} has no asset named ${wanted}`)
  return asset
}

async function stageRelease(ctx: Context, options: { repo: string; asset: string; into: string; strip?: number }) {
  const input = await release(options.repo)
  const destination = path.join(ctx.root, options.into)
  await fs.mkdir(destination, { recursive: true })
  const archive = path.join(ctx.temp, options.asset)
  await ctx.download(requireAsset(input, options.asset, options.repo).browser_download_url, archive)
  await ctx.extract(archive, destination, { strip: options.strip })
  return input
}

// ---------------------------------------------------------------------------
// ripgrep: packages/core/src/ripgrep/binary.ts
// ---------------------------------------------------------------------------

const RIPGREP_VERSION = "15.1.0"
const RIPGREP_PLATFORM = {
  "arm64-darwin": "aarch64-apple-darwin",
  "arm64-linux": "aarch64-unknown-linux-gnu",
  "x64-darwin": "x86_64-apple-darwin",
  "x64-linux": "x86_64-unknown-linux-musl",
  "arm64-win32": "aarch64-pc-windows-msvc",
  "x64-win32": "x86_64-pc-windows-msvc",
} as const

const ripgrep: Component = {
  id: "ripgrep",
  description: "ripgrep binary used by the grep/glob tools (not covered by OPENCODE_OFFLINE)",
  run: async (ctx) => {
    const key = `${ctx.target.arch}-${ctx.target.platform}` as keyof typeof RIPGREP_PLATFORM
    const platform = RIPGREP_PLATFORM[key]
    if (!platform) throw new Error(`ripgrep has no build for ${key}`)
    const extension = ctx.target.platform === "win32" ? "zip" : "tar.gz"
    const name = `ripgrep-${RIPGREP_VERSION}-${platform}.${extension}`
    const archive = path.join(ctx.temp, name)
    await ctx.download(`https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}/${name}`, archive)
    const unpacked = path.join(ctx.temp, `ripgrep-${RIPGREP_VERSION}`)
    await ctx.extract(archive, unpacked)
    await copy(
      path.join(unpacked, `ripgrep-${RIPGREP_VERSION}-${platform}`, `rg${exe(ctx)}`),
      bin(ctx, `rg${exe(ctx)}`),
    )
  },
  artifacts: (ctx) => [path.join("bin", `rg${exe(ctx)}`)],
}

// ---------------------------------------------------------------------------
// npm backed servers: satisfied by pre-populating `Npm.which`'s bin directory
// (packages/core/src/npm.ts:209-244)
// ---------------------------------------------------------------------------

const npmComponent = (id: string, name: string, command: string, description: string): Component => ({
  id,
  description,
  requiresHost: true,
  run: (ctx) => ctx.npm(name),
  artifacts: (ctx) => [npmBin(ctx, name, command)],
})

// ---------------------------------------------------------------------------
// archive backed servers: extracted straight into the path the runtime checks
// ---------------------------------------------------------------------------

const zls: Component = {
  id: "zls",
  description: "Zig language server (zigtools/zls)",
  run: async (ctx) => {
    const arch = ctx.target.arch === "arm64" ? "aarch64" : "x86_64"
    const platform = ctx.target.platform === "darwin" ? "macos" : ctx.target.platform === "win32" ? "windows" : "linux"
    const extension = ctx.target.platform === "win32" ? "zip" : "tar.xz"
    await stageRelease(ctx, { repo: "zigtools/zls", asset: `zls-${arch}-${platform}.${extension}`, into: "bin" })
  },
  artifacts: (ctx) => [path.join("bin", `zls${exe(ctx)}`)],
}

const clangd: Component = {
  id: "clangd",
  description: "clangd (clangd/clangd) extracted into bin, plus the bin/clangd shortcut",
  // Upstream publishes a single Linux build and it is x86_64, so an arm64 payload
  // cannot carry clangd. A miss is reported as a warning instead of aborting.
  optional: true,
  run: async (ctx) => {
    const input = await release("clangd/clangd")
    if (ctx.target.platform === "linux" && ctx.target.arch === "arm64")
      throw new Error(`clangd ${input.tag} publishes no aarch64 linux build`)
    const token = ctx.target.platform === "darwin" ? "mac" : ctx.target.platform === "win32" ? "windows" : "linux"
    const matches = input.assets.filter(
      (item) => item.name.includes(token) && (input.tag === "" || item.name.includes(input.tag)),
    )
    const asset =
      matches.find((item) => item.name.endsWith(".zip")) ??
      matches.find((item) => item.name.endsWith(".tar.xz")) ??
      matches[0]
    if (!asset) throw new Error(`clangd ${input.tag} has no asset for ${token}`)
    const archive = path.join(ctx.temp, asset.name)
    await ctx.download(asset.browser_download_url, archive)
    await ctx.extract(archive, bin(ctx))
    await copy(path.join(bin(ctx), `clangd_${input.tag}`, "bin", `clangd${exe(ctx)}`), bin(ctx, `clangd${exe(ctx)}`))
  },
  artifacts: (ctx) => [path.join("bin", `clangd${exe(ctx)}`)],
}

const luaLanguageServer: Component = {
  id: "lua-ls",
  description: "lua-language-server (LuaLS) plus a launcher so which() resolves it offline",
  run: async (ctx) => {
    const { arch, platform } = ctx.target
    const input = await release("LuaLS/lua-language-server")
    const extension = platform === "win32" ? "zip" : "tar.gz"
    const name = `lua-language-server-${input.tag}-${platform}-${arch}.${extension}`
    const archive = path.join(ctx.temp, name)
    await ctx.download(requireAsset(input, name, "LuaLS/lua-language-server").browser_download_url, archive)
    const installDir = bin(ctx, `lua-language-server-${arch}-${platform}`)
    await fs.mkdir(installDir, { recursive: true })
    await ctx.extract(archive, installDir)

    // bin/lua-language-server must exist: `which()` only searches BIN, and the
    // server passes no arguments, so the launcher has to resolve its siblings.
    const target = path.join(`lua-language-server-${arch}-${platform}`, "bin", `lua-language-server${exe(ctx)}`)
    const launcher = bin(ctx, platform === "win32" ? "lua-language-server.cmd" : "lua-language-server")
    await fs.rm(launcher, { force: true })
    if (platform === "win32") {
      await fs.writeFile(launcher, `@echo off\r\n"%~dp0${target.replaceAll("/", "\\")}" %*\r\n`)
    } else {
      await fs.symlink(target, launcher)
    }
  },
  artifacts: (ctx) => [
    path.join(
      "bin",
      `lua-language-server-${ctx.target.arch}-${ctx.target.platform}`,
      "bin",
      `lua-language-server${exe(ctx)}`,
    ),
    ctx.target.platform === "win32"
      ? path.join("bin", "lua-language-server.cmd")
      : path.join("bin", "lua-language-server"),
  ],
}

const texlab: Component = {
  id: "texlab",
  description: "texlab (latex-lsp/texlab)",
  run: async (ctx) => {
    const arch = ctx.target.arch === "arm64" ? "aarch64" : "x86_64"
    const platform = ctx.target.platform === "darwin" ? "macos" : ctx.target.platform === "win32" ? "windows" : "linux"
    const extension = ctx.target.platform === "win32" ? "zip" : "tar.gz"
    await stageRelease(ctx, { repo: "latex-lsp/texlab", asset: `texlab-${arch}-${platform}.${extension}`, into: "bin" })
  },
  artifacts: (ctx) => [path.join("bin", `texlab${exe(ctx)}`)],
}

const tinymist: Component = {
  id: "tinymist",
  description: "tinymist (Myriad-Dreamin/tinymist); the tar.gz wraps its payload in a directory",
  run: async (ctx) => {
    const arch = ctx.target.arch === "arm64" ? "aarch64" : "x86_64"
    const platform =
      ctx.target.platform === "darwin"
        ? "apple-darwin"
        : ctx.target.platform === "win32"
          ? "pc-windows-msvc"
          : "unknown-linux-gnu"
    const extension = ctx.target.platform === "win32" ? "zip" : "tar.gz"
    await stageRelease(ctx, {
      repo: "Myriad-Dreamin/tinymist",
      asset: `tinymist-${arch}-${platform}.${extension}`,
      into: "bin",
      strip: extension === "zip" ? undefined : 1,
    })
  },
  artifacts: (ctx) => [path.join("bin", `tinymist${exe(ctx)}`)],
}

const kotlinLs: Component = {
  id: "kotlin-ls",
  description: "Kotlin language server, fetched from the JetBrains CDN named by the latest GitHub release",
  // The CDN path is derived from the latest release name, and JetBrains has moved
  // it before (every target 404s against kotlin-lsp/263.4702.0). server.ts treats a
  // failed download as "no kotlin-ls", so a miss here warns instead of aborting.
  optional: true,
  run: async (ctx) => {
    const input = await release("Kotlin/kotlin-lsp")
    const version = input.name.replace(/^v/, "")
    if (!version) throw new Error("kotlin-lsp release has no name to derive a version from")
    const arch = ctx.target.arch === "arm64" ? "aarch64" : "x64"
    const platform = ctx.target.platform === "darwin" ? "mac" : ctx.target.platform === "win32" ? "win" : "linux"
    const name = `kotlin-lsp-${version}-${platform}-${arch}.zip`
    const archive = path.join(ctx.temp, name)
    await ctx.download(`https://download-cdn.jetbrains.com/kotlin-lsp/${version}/${name}`, archive)
    await ctx.extract(archive, bin(ctx, "kotlin-ls"))
  },
  artifacts: (ctx) => [
    path.join("bin", "kotlin-ls", ctx.target.platform === "win32" ? "kotlin-lsp.cmd" : "kotlin-lsp.sh"),
  ],
}

const terraformLs: Component = {
  id: "terraform-ls",
  description: "terraform-ls from the HashiCorp releases API",
  run: async (ctx) => {
    const response = await fetch("https://api.releases.hashicorp.com/v1/releases/terraform-ls/latest", {
      headers: { "user-agent": "opencode-offline-bundle" },
    })
    if (!response.ok) throw new Error(`terraform-ls release lookup failed (${response.status})`)
    const input = (await response.json()) as {
      version?: string
      builds?: { arch?: string; os?: string; url?: string }[]
    }
    const arch = ctx.target.arch === "arm64" ? "arm64" : "amd64"
    const os = ctx.target.platform === "win32" ? "windows" : ctx.target.platform
    const build = (input.builds ?? []).find((item) => item.arch === arch && item.os === os)
    if (!build?.url) throw new Error(`terraform-ls ${input.version} has no ${os}/${arch} build`)
    const archive = path.join(ctx.temp, "terraform-ls.zip")
    await ctx.download(build.url, archive)
    await ctx.extract(archive, bin(ctx))
  },
  artifacts: (ctx) => [path.join("bin", `terraform-ls${exe(ctx)}`)],
}

const jdtls: Component = {
  id: "jdtls",
  description: "Eclipse JDT language server snapshot; distPath must contain plugins/",
  run: async (ctx) => {
    const archive = path.join(ctx.temp, "jdt-language-server-latest.tar.gz")
    await ctx.download(
      "https://www.eclipse.org/downloads/download.php?file=/jdtls/snapshots/jdt-language-server-latest.tar.gz",
      archive,
    )
    await ctx.extract(archive, bin(ctx, "jdtls"))
  },
  artifacts: () => [path.join("bin", "jdtls", "plugins", "org.eclipse.equinox.launcher_*.jar")],
}

const elixirLs: Component = {
  id: "elixir-ls",
  description: "elixir-ls prebuilt release placed at bin/elixir-ls-master/release (avoids the runtime's mix compile)",
  optional: true,
  run: async (ctx) => {
    const input = await release("elixir-lsp/elixir-ls")
    const asset = input.assets.find((item) => /^elixir-ls-v.*\.zip$/.test(item.name))
    if (!asset) throw new Error(`elixir-ls ${input.tag} has no prebuilt zip asset`)
    const archive = path.join(ctx.temp, asset.name)
    await ctx.download(asset.browser_download_url, archive)
    await ctx.extract(archive, bin(ctx, "elixir-ls-master", "release"))
  },
  artifacts: (ctx) => [
    path.join(
      "bin",
      "elixir-ls-master",
      "release",
      ctx.target.platform === "win32" ? "language_server.bat" : "language_server.sh",
    ),
  ],
}

const eslint: Component = {
  id: "eslint",
  description: "vscode-eslint server, built with npm at bundle time (the runtime does npm install + compile)",
  requiresHost: true,
  optional: true,
  run: async (ctx) => {
    const archive = path.join(ctx.temp, "vscode-eslint-main.zip")
    await ctx.download("https://github.com/microsoft/vscode-eslint/archive/refs/heads/main.zip", archive)
    const unpacked = path.join(ctx.temp, "vscode-eslint-unpacked")
    await ctx.extract(archive, unpacked)
    const source = path.join(unpacked, "vscode-eslint-main")
    if (!(await exists(source))) throw new Error("vscode-eslint archive did not contain vscode-eslint-main")
    const destination = bin(ctx, "vscode-eslint")
    await fs.rm(destination, { force: true, recursive: true })
    await fs.rename(source, destination)

    const npm = process.platform === "win32" ? "npm.cmd" : "npm"
    await ctx.run([npm, "install", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: destination })
    await ctx.run([npm, "run", "compile"], { cwd: destination })
  },
  artifacts: () => [path.join("bin", "vscode-eslint", "server", "out", "eslintServer.js")],
}

// ---------------------------------------------------------------------------
// toolchain produced servers. The runtime shells out to go/gem/dotnet on first
// use; we run the same command at bundle time with the output redirected into
// bin, which every one of these servers probes through which() first.
// ---------------------------------------------------------------------------

const toolchainComponent = (
  id: string,
  description: string,
  tool: string,
  install: (ctx: Context) => Promise<void>,
  artifacts: (ctx: Context) => string[],
): Component => ({
  id,
  description,
  requiresHost: true,
  optional: true,
  run: async (ctx) => {
    const found = await ctx.runNothrow([tool, "--version"])
    if (found !== 0) throw new Error(`${tool} is not available on this host`)
    await install(ctx)
  },
  artifacts,
})

const gopls = toolchainComponent(
  "gopls",
  "Go language server via go install (mirrors server.ts:372)",
  "go",
  async (ctx) => {
    await ctx.run(["go", "install", "golang.org/x/tools/gopls@latest"], { env: { GOBIN: bin(ctx) } })
  },
  (ctx) => [path.join("bin", `gopls${exe(ctx)}`)],
)

const fsautocomplete = toolchainComponent(
  "fsharp",
  "F# language server via dotnet tool install --tool-path (mirrors server.ts:835)",
  "dotnet",
  async (ctx) => {
    await ctx.run(["dotnet", "tool", "install", "fsautocomplete", "--tool-path", bin(ctx)])
  },
  (ctx) => [path.join("bin", `fsautocomplete${exe(ctx)}`)],
)

const roslyn = toolchainComponent(
  "csharp",
  "C#/Razor language server via dotnet tool install --tool-path (the runtime installs it globally)",
  "dotnet",
  async (ctx) => {
    await ctx.run(["dotnet", "tool", "install", "roslyn-language-server", "--prerelease", "--tool-path", bin(ctx)])
  },
  (ctx) => [
    path.join("bin", ctx.target.platform === "win32" ? "roslyn-language-server.cmd" : "roslyn-language-server"),
  ],
)

const rubocop = toolchainComponent(
  "ruby-lsp",
  "rubocop --lsp via gem install --bindir (mirrors server.ts:405)",
  "gem",
  async (ctx) => {
    await ctx.run(["gem", "install", "rubocop", "--no-document", "--bindir", bin(ctx)])
  },
  (ctx) => [path.join("bin", ctx.target.platform === "win32" ? "rubocop.bat" : "rubocop")],
)

export const COMPONENTS: Component[] = [
  ripgrep,
  npmComponent(
    "typescript",
    "typescript-language-server",
    "typescript-language-server",
    "TypeScript/JavaScript server; note server.ts has no offline guard, so this must be pre-populated",
  ),
  npmComponent("vue", "@vue/language-server", "vue-language-server", "Vue language server"),
  npmComponent("pyright", "pyright", "pyright-langserver", "Pyright language server"),
  npmComponent("svelte", "svelte-language-server", "svelteserver", "Svelte language server"),
  npmComponent("astro", "@astrojs/language-server", "astro-ls", "Astro language server"),
  npmComponent("yaml-ls", "yaml-language-server", "yaml-language-server", "YAML language server"),
  npmComponent("intelephense", "intelephense", "intelephense", "PHP intelephense"),
  npmComponent("bash", "bash-language-server", "bash-language-server", "Bash language server"),
  // npm installs this package under its own name, but the executable it ships is
  // `docker-langserver` — that is also what server.ts looks for with which().
  npmComponent("dockerfile", "dockerfile-language-server-nodejs", "docker-langserver", "Dockerfile language server"),
  npmComponent("biome", "biome", "biome", "Biome; note server.ts has no offline guard"),
  zls,
  clangd,
  luaLanguageServer,
  texlab,
  tinymist,
  kotlinLs,
  terraformLs,
  jdtls,
  elixirLs,
  eslint,
  gopls,
  fsautocomplete,
  roslyn,
  rubocop,
]

/**
 * Servers that opencode never downloads: they are only picked up from the host
 * PATH. Shipping them means shipping the language toolchain, so the bundle can
 * only report them.
 */
export const PATH_ONLY_SERVERS = [
  "deno",
  "oxlint",
  "ty",
  "prisma",
  "dart",
  "ocaml-lsp",
  "rust",
  "sourcekit-lsp",
  "gleam",
  "clojure-lsp",
  "nixd",
  "haskell-language-server",
  "julials",
] as const

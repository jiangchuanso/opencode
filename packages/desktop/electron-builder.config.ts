import { execFile } from "node:child_process"
import { chmodSync, mkdirSync, writeFileSync } from "node:fs"
import { stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import type { CustomMacSignOptions } from "app-builder-lib"
import type { Configuration } from "electron-builder"

const execFileAsync = promisify(execFile)

const packageDir = path.dirname(fileURLToPath(import.meta.url))

const rootDir = path.resolve(packageDir, "../..")

const signScript = path.join(rootDir, "script", "sign-windows.ps1")

// The Electron 42 packaging update briefly installed Linux launchers/icons under
// "opencode-desktop". Keep that hidden desktop entry around so existing GNOME/KDE
// pins still resolve after the canonical app id changes back to ai.opencode.desktop.
const legacyDesktopEntry = path.join(packageDir, "resources", "linux", "opencode-desktop.desktop")

const legacyDesktopEntryFpm = `${legacyDesktopEntry}=/usr/share/applications/opencode-desktop.desktop`

const metainfoFpm = (appId: string) =>
  `${path.join(packageDir, "resources", `${appId}.metainfo.xml`)}=/usr/share/metainfo/${appId}.metainfo.xml`

// Kylin V10 SP1 desktop is an Ubuntu 20.04 base (glibc 2.31, GTK 3), which is the
// oldest Linux these packages install on, so every dependency is spelled as it
// exists in focal. libasound2 was renamed to libasound2t64 in Ubuntu 24.04, so it
// is listed as an alternative to keep one deb installable on both.
const DEB_DEPENDS = [
  "libgtk-3-0",
  "libnss3",
  "libnotify4",
  "libsecret-1-0",
  "libatspi2.0-0",
  "libxss1",
  "libxtst6",
  "libx11-6",
  "libxcb1",
  "libxcomposite1",
  "libxdamage1",
  "libxext6",
  "libxfixes3",
  "libxrandr2",
  "libxkbcommon0",
  "libgbm1",
  "libdrm2",
  "libuuid1",
  "libasound2 | libasound2t64",
  "xdg-utils",
]

// hicolor is the only icon theme these packages ship, and some shells (including
// Kylin's UKUI theme stack) do not inherit it, so the same icon also lands in
// pixmaps where the legacy fallback lookup always finds it.
const pixmapFpm = (appId: string) =>
  `${path.join(packageDir, "resources", "icons", "icon.png")}=/usr/share/pixmaps/${appId}.png`

// fpm writes the archive with its own default file modes, so Chromium's SUID
// sandbox helper can be installed without its setuid bit. Kylin and other hardened
// kernels sometimes disable unprivileged user namespaces, and then that helper is
// the only way Chromium can sandbox itself. Refreshing the launcher and icon
// caches from the same script is what makes the menu entry show its icon without
// waiting for the next login.
// fpm 2.1.4 (Ruby 3.4.3) rejects the `--after-install=/path` equals form and
// requires every flag before the first positional argument. electron-builder's
// native `afterInstall`/`afterRemove` options emit the space form
// (`--after-install <path>`) in the correct position, so the scripts are passed
// through those options instead of being appended to the `fpm` array.
const maintainerFpm = (appId: string): { afterInstall: string; afterRemove: string } => {
  const dir = path.join(os.tmpdir(), "opencode-desktop-fpm")
  mkdirSync(dir, { recursive: true })

  const afterInstall = path.join(dir, `${appId}.after-install.sh`)
  const afterRemove = path.join(dir, `${appId}.after-remove.sh`)

  writeFileSync(
    afterInstall,
    `#!/bin/sh
set -e

for sandbox in /opt/*/chrome-sandbox; do
  [ -f "$sandbox" ] || continue
  app_dir=\${sandbox%/chrome-sandbox}
  [ -f "$app_dir/${appId}" ] || continue
  chown root:root "$sandbox" 2>/dev/null || true
  chmod 4755 "$sandbox" 2>/dev/null || true
done

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database -q /usr/share/applications || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true
fi

exit 0
`,
  )
  writeFileSync(
    afterRemove,
    `#!/bin/sh
set -e

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database -q /usr/share/applications || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true
fi

exit 0
`,
  )
  chmodSync(afterInstall, 0o755)
  chmodSync(afterRemove, 0o755)

  return { afterInstall, afterRemove }
}

async function signWindows(configuration: { path: string }) {
  if (process.platform !== "win32") return

  if (process.env.GITHUB_ACTIONS !== "true") return

  await execFileAsync(
    "pwsh",
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", signScript, configuration.path],
    { cwd: rootDir, windowsHide: true },
  )
}

function macSignOptions(options: CustomMacSignOptions): CustomMacSignOptions {
  return {
    ...options,
    optionsForFile: (file) => {
      const defaults = options.optionsForFile?.(file)

      if (file !== path.join(options.app, "Contents/Resources/opencode-cli")) return defaults ?? {}

      // The Bun CLI loads bun-pty's native library; Electron and its helpers do not need this exception.
      return { ...defaults, entitlements: path.join(packageDir, "resources/entitlements.cli.plist") }
    },
  }
}

const channel = (() => {
  const raw = process.env.OPENCODE_CHANNEL

  if (raw === "dev" || raw === "beta" || raw === "prod") return raw

  if (raw === "latest") return "prod"

  return "dev"
})()

const APP_IDS = {
  dev: "ai.opencode.desktop.dev",
  beta: "ai.opencode.desktop.beta",
  prod: "ai.opencode.desktop",
} as const

const getBase = (appId: string): Configuration => ({
  artifactName: "opencode-desktop-${os}-${arch}.${ext}",
  directories: {
    output: "dist",
    buildResources: "resources",
  },
  // Linux launchers are .desktop files, so this is the desktop file name,
  // not just the app id. For prod, app id "ai.opencode.desktop" becomes
  // "ai.opencode.desktop.desktop".
  // https://developer.gnome.org/documentation/guidelines/maintainer/integrating.html
  // https://www.electron.build/docs/linux/
  extraMetadata: {
    desktopName: `${appId}.desktop`,
  },
  files: [
    "out/**/*",
    "resources/**/*",
    "!resources/opencode-cli*",
    // Log export imports Zip.js as ESM. Keep index.js and lib, including its inline worker.
    "!**/node_modules/@zip.js/zip.js/dist{,/**/*}",
    "!**/node_modules/@zip.js/zip.js/{index.cjs,index.min.js,index-fflate.js,deno.json,eslint.config.mjs}",
    // Nothing executes type declarations or source maps, and every entry costs startup time: the
    // main process parses the whole asar header before it runs any JavaScript.
    "!**/node_modules/**/*.d.{ts,cts,mts}",
    "!**/node_modules/**/*.d.{ts,cts,mts}.map",
    "!**/node_modules/**/*.{js,cjs,mjs}.map",
    // These packages execute compiled JavaScript, not their sources.
    "!**/node_modules/ajv/lib{,/**/*}",
    "!**/node_modules/ajv-formats/src{,/**/*}",
    // Keep js-yaml's CommonJS sources and dist/js-yaml.mjs ESM entry, not browser bundles or its CLI.
    "!**/node_modules/js-yaml/dist/{js-yaml.js,js-yaml.min.js,*.map}",
    "!**/node_modules/js-yaml/bin{,/**/*}",
  ],
  extraResources: [
    {
      from: "resources/",
      to: "",
      filter: ["opencode-cli", "opencode-cli.exe", "opencode-cli.version"],
    },
  ],
  afterPack: async (context) => {
    const cli = path.join(
      context.packager.getResourcesDir(context.appOutDir),
      context.electronPlatformName === "win32" ? "opencode-cli.exe" : "opencode-cli",
    )

    const file = await stat(cli)

    if (!file.isFile() || file.size === 0) throw new Error(`Bundled CLI must be a non-empty file: ${cli}`)
    const version = path.join(path.dirname(cli), "opencode-cli.version")

    if ((await stat(version)).size === 0) throw new Error(`Bundled CLI version must be a non-empty file: ${version}`)
  },
  mac: {
    category: "public.app-category.developer-tools",
    icon: `resources/icons/icon.icns`,
    extendInfo: {
      NSAutoFillRequiresTextContentTypeForOneTimeCodeOnMac: true,
    },
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "resources/entitlements.plist",
    entitlementsInherit: "resources/entitlements.plist",
    sign: async (options) => {
      const { sign } = await import("app-builder-lib/out/codeSign/macCodeSign")
      await sign(macSignOptions(options))
    },
    notarize: true,
    target: ["dmg", "zip"],
  },
  protocols: {
    name: "OpenCode",
    schemes: ["opencode"],
  },
  win: {
    icon: `resources/icons/icon.ico`,
    signtoolOptions: {
      sign: signWindows,
    },
    target: ["nsis"],
    verifyUpdateCodeSignature: false,
  },
  nsis: {
    include: path.join(packageDir, "resources", "windows", "installer.nsh"),
    oneClick: true,
    perMachine: false,
    installerIcon: `resources/icons/icon.ico`,
    installerHeaderIcon: `resources/icons/icon.ico`,
  },
  linux: {
    icon: `resources/icons`,
    category: "Development",
    executableName: appId,
    desktop: {
      entry: {
        // Match the installed .desktop file and hicolor icon basename so
        // Linux shells can associate the running Electron window with its launcher.
        StartupWMClass: appId,
      },
    },
    target: ["AppImage", "deb", "rpm"],
  },
})

const linuxFpm = (appId: string, extra: string[] = []) => [metainfoFpm(appId), pixmapFpm(appId), ...extra]

function getConfig() {
  const appId = APP_IDS[channel]
  const base = getBase(appId)
  const { afterInstall, afterRemove } = maintainerFpm(appId)

  switch (channel) {
    case "dev": {
      return {
        ...base,
        appId,
        productName: "OpenCode Dev",
        deb: { depends: DEB_DEPENDS, fpm: linuxFpm(appId), afterInstall, afterRemove },
        rpm: { packageName: "opencode-dev", fpm: linuxFpm(appId), afterInstall, afterRemove },
      }
    }

    case "beta": {
      return {
        ...base,
        appId,
        productName: "OpenCode Beta",
        protocols: { name: "OpenCode Beta", schemes: ["opencode"] },
        publish: {
          provider: "generic",
          url: "https://opencode.ai/update/api/beta/desktop/opencode/",
          channel: "latest",
        },
        deb: { depends: DEB_DEPENDS, fpm: linuxFpm(appId), afterInstall, afterRemove },
        rpm: { packageName: "opencode-beta", fpm: linuxFpm(appId), afterInstall, afterRemove },
      }
    }

    case "prod": {
      return {
        ...base,
        appId,
        productName: "OpenCode",
        protocols: { name: "OpenCode", schemes: ["opencode"] },
        publish: {
          provider: "generic",
          url: "https://opencode.ai/update/api/latest/desktop/opencode/",
          channel: "latest",
        },
        deb: { depends: DEB_DEPENDS, fpm: linuxFpm(appId, [legacyDesktopEntryFpm]), afterInstall, afterRemove },
        rpm: { packageName: "opencode", fpm: linuxFpm(appId, [legacyDesktopEntryFpm]), afterInstall, afterRemove },
      }
    }
  }
}

export default getConfig()

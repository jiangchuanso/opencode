import { chmodSync, mkdirSync, writeFileSync } from "node:fs"
import { readdir, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { Arch, type Configuration } from "electron-builder"
import { NativeArch } from "../../script/native-arch"
import { DESKTOP_NATIVE_ENGLISH } from "@opencode/app/i18n/desktop-native"
import { CLI_BINARIES, getCurrentCli, nodePtyPackage } from "./script/utils"

const packageDir = path.dirname(fileURLToPath(import.meta.url))

// The Electron 42 packaging update briefly installed Linux launchers/icons under
// "opencode-desktop". Keep that hidden desktop entry around so existing GNOME/KDE
// pins still resolve after the canonical app id changes back to ai.opencode.desktop.
const legacyDesktopEntry = path.join(packageDir, "resources", "linux", "opencode-desktop.desktop")

const legacyDesktopEntryFpm = `${legacyDesktopEntry}=/usr/share/applications/opencode-desktop.desktop`

// rpmbuild adds /usr/lib/.build-id links for every ELF file. The bundled Electron
// binaries are byte-identical across apps on the same Electron version, so those
// links collide with other Electron RPMs (Slack, Unity Hub, ...) and rpm/zypper
// refuse to install or update. They only serve debuginfo lookup, so skip them.
// fpm only accepts flags before the first src=dest mapping, so keep this first.
const rpmNoBuildIdLinksFpm = "--rpm-rpmbuild-define=_build_id_links none"

const metainfoFpm = (appId: string) =>
  `${path.join(packageDir, "resources", `${appId}.metainfo.xml`)}=/usr/share/metainfo/${appId}.metainfo.xml`

// Dev and beta package every commit, so they trade about 5% (deb) and 17% (rpm) larger files for xz -1, which
// compresses the payload about 3x faster than the deb default (-3) and 5x faster than the rpm default (-9).
const previewCompressionFpm = (target: "deb" | "rpm") => [`--${target}-compression-level`, "1"]

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

function resolveChannel() {
  const raw = process.env.OPENCODE_CHANNEL

  if (raw === "dev" || raw === "beta" || raw === "prod") return raw

  if (raw === "latest") return "prod"

  return "dev"
}

const APP_IDS = {
  dev: "ai.opencode.desktop.dev",
  beta: "ai.opencode.desktop.beta",
  prod: "ai.opencode.desktop",
} as const

// libappimage (used by AppImageLauncher) resolves the .desktop entry inside an
// AppImage by globbing `*.desktop` at the squashfs root. If the main
// executable itself ends in `.desktop` (prod appId `ai.opencode.desktop`), the
// ELF binary matches the glob and is parsed as a desktop entry, so
// integration fails with `Malformed desktop entry: Unexpected char '\x7f' at 0`
// (0x7F is the first byte of the ELF magic).
// https://github.com/anomalyco/opencode/issues/51867
// Strip a trailing `.desktop` so the executable can never collide with the
// desktop-entry glob. Beta/dev appIds end in `.beta`/`.dev` and are unaffected.
function linuxExecutableName(appId: string): string {
  return appId.replace(/\.desktop$/, "")
}

const getBase = (appId: string): Configuration => {
  const target = getCurrentCli()
  const desktopName = `${appId}.desktop`

  return {
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
    // Release builds take their version from OPENCODE_VERSION instead of rewriting package.json.
    extraMetadata: process.env.OPENCODE_VERSION
      ? { desktopName, version: process.env.OPENCODE_VERSION }
      : { desktopName },
    files: [
      "out/**/*",
      "resources/**/*",
      "!resources/opencode-cli*",
      // Keep only the target platform's node-pty prebuild when cross-packaging with --cpu=*.
      ...CLI_BINARIES.filter((item) => item.os !== target.os || item.cpu !== target.cpu).map(
        (item) => `!**/node_modules/@lydell/node-pty-${item.os}-${item.cpu}{,/**/*}`,
      ),
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
      const arch = Arch[context.arch]

      // The --arm64 flag picks Electron while OPENCODE_TARGET picks the CLI and node-pty, so they can disagree.
      if (arch !== "x64" && arch !== "arm64") throw new Error(`Unsupported desktop architecture: ${arch}`)

      if (arch !== target.cpu) throw new Error(`Packaging ${arch} Electron with the ${target.target} CLI`)
      const resources = context.packager.getResourcesDir(context.appOutDir)
      const cli = path.join(resources, context.electronPlatformName === "win32" ? "opencode-cli.exe" : "opencode-cli")

      const file = await stat(cli)

      if (!file.isFile() || file.size === 0) throw new Error(`Bundled CLI must be a non-empty file: ${cli}`)
      await NativeArch.verify(cli, arch)
      const version = path.join(path.dirname(cli), "opencode-cli.version")

      if ((await stat(version)).size === 0) throw new Error(`Bundled CLI version must be a non-empty file: ${version}`)

      if (context.electronPlatformName !== "win32") return

      const prebuilds = path.join(
        resources,
        "app.asar.unpacked/node_modules",
        nodePtyPackage(target.target),
        "prebuilds",
        `${target.os}-${target.cpu}`,
      )

      const addon = path.join(prebuilds, "conpty.node")

      if ((await stat(addon)).size === 0) throw new Error(`Bundled node-pty must be a non-empty file: ${addon}`)
      const entries = await readdir(prebuilds, { recursive: true, withFileTypes: true })

      await Promise.all(
        entries
          .filter((entry) => entry.isFile())
          .map(async (entry) => {
            const file = path.join(entry.parentPath, entry.name)

            if (await NativeArch.isNative(file)) await NativeArch.verify(file, arch)
          }),
      )
    },
    mac: {
      category: "public.app-category.developer-tools",
      icon: `resources/icons/icon.icns`,
      extendInfo: {
        NSMicrophoneUsageDescription: DESKTOP_NATIVE_ENGLISH["desktop.microphoneUsage"],
        NSAutoFillRequiresTextContentTypeForOneTimeCodeOnMac: true,
      },
      target: ["dmg", "zip"],
    },
    protocols: {
      name: "OpenCode",
      schemes: ["opencode"],
    },
    win: {
      icon: `resources/icons/icon.ico`,
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
      executableName: linuxExecutableName(appId),
      // Derive the installed `.desktop` filename from `desktopName`
      // (`ai.opencode.desktop.desktop` for prod) instead of `executableName`,
      // so window association is unaffected by the executable rename above.
      syncDesktopName: true,
      desktop: {
        entry: {
          // Match the installed .desktop file and hicolor icon basename so
          // Linux shells can associate the running Electron window with its launcher.
          StartupWMClass: appId,
        },
      },
      target: ["AppImage", "deb", "rpm"],
    },
  }
}

const linuxFpm = (appId: string, extra: string[] = []) => [metainfoFpm(appId), pixmapFpm(appId), ...extra]

export function getConfig() {
  const channel = resolveChannel()
  const appId = APP_IDS[channel]
  const base = getBase(appId)
  const { afterInstall, afterRemove } = maintainerFpm(appId)

  switch (channel) {
    case "dev": {
      return {
        ...base,
        appId,
        productName: "OpenCode Dev",
        publish: {
          provider: "generic",
          url: "https://opencode.ai/update/api/dev/desktop/opencode/",
          channel: "latest",
        },
        deb: {
          depends: DEB_DEPENDS,
          fpm: [...previewCompressionFpm("deb"), ...linuxFpm(appId)],
          afterInstall,
          afterRemove,
        },
        rpm: {
          packageName: "opencode-dev",
          fpm: [rpmNoBuildIdLinksFpm, ...previewCompressionFpm("rpm"), ...linuxFpm(appId)],
          afterInstall,
          afterRemove,
        },
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
        deb: {
          depends: DEB_DEPENDS,
          fpm: [...previewCompressionFpm("deb"), ...linuxFpm(appId)],
          afterInstall,
          afterRemove,
        },
        rpm: {
          packageName: "opencode-beta",
          fpm: [rpmNoBuildIdLinksFpm, ...previewCompressionFpm("rpm"), ...linuxFpm(appId)],
          afterInstall,
          afterRemove,
        },
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
        rpm: {
          packageName: "opencode",
          fpm: [rpmNoBuildIdLinksFpm, ...linuxFpm(appId, [legacyDesktopEntryFpm])],
          afterInstall,
          afterRemove,
        },
      }
    }
  }
}

export default getConfig()

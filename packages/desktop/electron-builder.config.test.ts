import { expect, test } from "bun:test"
import type { Configuration } from "electron-builder"

const legacyDesktopEntry = "resources/linux/opencode-desktop.desktop"

const channels = [
  { channel: "dev", appId: "ai.opencode.desktop.dev" },
  { channel: "beta", appId: "ai.opencode.desktop.beta" },
  { channel: "prod", appId: "ai.opencode.desktop" },
] as const

for (const channel of channels) {
  test(`uses one Linux desktop identity for ${channel.channel}`, async () => {
    const previous = process.env.OPENCODE_CHANNEL
    process.env.OPENCODE_CHANNEL = channel.channel

    const module = await import(`./electron-builder.config.ts?channel=${channel.channel}`)
    const config = module.default as Configuration

    if (previous === undefined) delete process.env.OPENCODE_CHANNEL
    else process.env.OPENCODE_CHANNEL = previous

    expect(config.appId).toBe(channel.appId)
    expect(config.extraMetadata?.desktopName).toBe(`${channel.appId}.desktop`)
    expect(config.linux?.executableName).toBe(channel.appId)
    expect(config.linux?.desktop?.entry?.StartupWMClass).toBe(channel.appId)
    expect(config.deb?.fpm).toContainEqual(expect.stringContaining(`/usr/share/metainfo/${channel.appId}.metainfo.xml`))
    expect(config.rpm?.fpm).toContainEqual(expect.stringContaining(`/usr/share/metainfo/${channel.appId}.metainfo.xml`))
  })
}

test("installs on Ubuntu 20.04 based systems such as Kylin V10 SP1", async () => {
  const previous = process.env.OPENCODE_CHANNEL
  process.env.OPENCODE_CHANNEL = "prod"

  const module = await import("./electron-builder.config.ts?kylin")
  const config = module.default as Configuration

  if (previous === undefined) delete process.env.OPENCODE_CHANNEL
  else process.env.OPENCODE_CHANNEL = previous

  const depends = config.deb?.depends ?? []
  expect(depends).toContain("libgtk-3-0")
  expect(depends).toContain("libgbm1")
  // Renamed in Ubuntu 24.04, still libasound2 on 20.04.
  expect(depends).toContain("libasound2 | libasound2t64")
  expect(depends).not.toContain("libasound2t64")

  // Shells that do not inherit hicolor still find the icon through pixmaps.
  expect(config.deb?.fpm).toContainEqual(
    expect.stringContaining("/usr/share/pixmaps/ai.opencode.desktop.png"),
  )
  expect(config.deb?.fpm?.some((entry) => entry.startsWith("--after-install="))).toBe(true)
  expect(config.deb?.fpm?.some((entry) => entry.startsWith("--after-remove="))).toBe(true)
})

test("ships hicolor icon sizes the Linux shells ask for", async () => {
  for (const channel of channels) {
    for (const size of ["16x16", "48x48", "128x128", "256x256"]) {
      expect(await Bun.file(`icons/${channel.channel}/${size}.png`).exists()).toBe(true)
    }
  }
})

test("keeps a hidden prod launcher for old Linux pins", async () => {
  const previous = process.env.OPENCODE_CHANNEL
  process.env.OPENCODE_CHANNEL = "prod"

  const module = await import("./electron-builder.config.ts?compat=prod")
  const config = module.default as Configuration

  if (previous === undefined) delete process.env.OPENCODE_CHANNEL
  else process.env.OPENCODE_CHANNEL = previous

  expect(
    config.deb?.fpm?.some((entry) =>
      entry.endsWith("opencode-desktop.desktop=/usr/share/applications/opencode-desktop.desktop"),
    ),
  ).toBe(true)
  expect(
    config.rpm?.fpm?.some((entry) =>
      entry.endsWith("opencode-desktop.desktop=/usr/share/applications/opencode-desktop.desktop"),
    ),
  ).toBe(true)

  const desktop = await Bun.file(legacyDesktopEntry).text()
  expect(desktop).toContain("Exec=/opt/OpenCode/ai.opencode.desktop %U")
  expect(desktop).toContain("Icon=ai.opencode.desktop")
  expect(desktop).toContain("StartupWMClass=ai.opencode.desktop")
  expect(desktop).toContain("NoDisplay=true")
})

test("bundles the CLI outside the dev app archive", async () => {
  const previous = process.env.OPENCODE_CHANNEL
  process.env.OPENCODE_CHANNEL = "dev"
  const module = await import("./electron-builder.config.ts?cli-resource")
  const config = module.default as Configuration
  if (previous === undefined) delete process.env.OPENCODE_CHANNEL
  else process.env.OPENCODE_CHANNEL = previous

  expect(config.files).toContain("!resources/opencode-cli*")
  expect(config.extraResources).toContainEqual({
    from: "resources/",
    to: "",
    filter: ["opencode-cli*"],
  })
})

for (const channel of ["beta", "prod"] as const) {
  test(`does not bundle the CLI in ${channel} builds`, async () => {
    const previous = process.env.OPENCODE_CHANNEL
    process.env.OPENCODE_CHANNEL = channel
    const module = await import(`./electron-builder.config.ts?no-cli-resource=${channel}`)
    const config = module.default as Configuration
    if (previous === undefined) delete process.env.OPENCODE_CHANNEL
    else process.env.OPENCODE_CHANNEL = previous

    expect(config.extraResources).not.toContainEqual({
      from: "resources/",
      to: "",
      filter: ["opencode-cli*"],
    })
  })
}

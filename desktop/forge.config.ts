import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerZIP } from '@electron-forge/maker-zip';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import MakerAppImage from '@reforged/maker-appimage';
import { closeSync, openSync, readSync } from 'node:fs';

const variant =
  process.env.XTRALAB_BUILD_VARIANT ??
  (process.env.CI === 'true' ? 'release' : 'dev');
const isDev = variant === 'dev';

const productName = isDev ? 'xtralab dev' : 'xtralab';
const executableName = isDev ? 'xtralab-dev' : 'xtralab';
const appBundleId = isDev
  ? 'io.github.jtpio.xtralab.dev'
  : 'io.github.jtpio.xtralab';

// macOS release signing, enabled with XTRALAB_MACOS_SIGN=1. The Developer ID
// Application identity is auto-discovered from the keychain, and osx-sign's
// defaults (hardened runtime, secure timestamps, Electron's standard
// entitlements) are the notarization prerequisites. Notarization runs when the
// Apple credentials are also present, and staples the ticket into the app.
const signMacOS = process.env.XTRALAB_MACOS_SIGN === '1';
const appleId = process.env.APPLE_ID;
const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
const appleTeamId = process.env.APPLE_TEAM_ID;
const osxNotarize =
  signMacOS && appleId && appleIdPassword && appleTeamId
    ? { appleId, appleIdPassword, teamId: appleTeamId }
    : undefined;

// First four bytes of every Mach-O flavor (thin 32/64-bit and universal
// binaries, both byte orders), read big-endian.
const machOMagics = new Set([
  0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca,
  0xcafebabf, 0xbfbafeca
]);

function isMachO(filePath: string): boolean {
  try {
    const fd = openSync(filePath, 'r');
    try {
      const header = Buffer.alloc(4);
      if (readSync(fd, header, 0, 4, 0) < 4) {
        return false;
      }
      return machOMagics.has(header.readUInt32BE(0));
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

const config: ForgeConfig = {
  packagerConfig: {
    name: productName,
    executableName,
    appBundleId,
    appCategoryType: 'public.app-category.developer-tools',
    icon: './assets/jupyter',
    asar: true,
    extraResource: ['python/runtime'],
    ...(signMacOS
      ? {
          osxSign: {
            // The signing walk covers every binary-looking file in the bundle.
            // Notarization needs each Mach-O signed — including the bundled
            // Python runtime — but the runtime is also full of binary
            // non-Mach-O files (.pyc caches and friends), and every signature
            // costs a timestamp-server round-trip, so restrict the runtime to
            // real Mach-O binaries.
            ignore: (file: string) =>
              file.includes('/Contents/Resources/runtime/') && !isMachO(file)
          },
          ...(osxNotarize ? { osxNotarize } : {})
        }
      : {}),
    ignore: [
      /^\/out($|\/)/,
      /^\/forge\.config\.(ts|js)$/,
      /^\/node_modules($|\/)/,
      /^\/pnpm-lock\.yaml$/,
      /^\/pyproject\.toml$/,
      /^\/tsconfig.*\.json$/,
      /^\/uv\.lock$/,
      /^\/.+\.tsbuildinfo$/,
      /^\/src\/.*\.ts$/,
      /^\/scripts($|\/)/,
      /\.map$/,
      /^\/python($|\/)/,
      /^\/xtralab_desktop($|\/)/,
      /^\/\.gitignore$/,
      /^\/.*\.DS_Store$/
    ]
  },
  makers: [
    new MakerDMG(
      {
        name: productName,
        format: 'ULFO',
        icon: './assets/jupyter.icns'
      },
      ['darwin']
    ),
    // Squirrel.Mac consumes updates as a zip of the .app; the DMG stays the
    // human-facing installer.
    new MakerZIP({}, ['darwin']),
    new MakerAppImage(
      {
        options: {
          name: executableName,
          productName,
          bin: executableName,
          icon: './assets/jupyter.png',
          categories: ['Development', 'Science']
        }
      },
      ['linux']
    )
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true
    })
  ]
};

export default config;

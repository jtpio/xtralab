import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import MakerAppImage from '@reforged/maker-appimage';

const variant =
  process.env.XTRALAB_BUILD_VARIANT ??
  (process.env.CI === 'true' ? 'release' : 'dev');
const isDev = variant === 'dev';

const productName = isDev ? 'xtralab dev' : 'xtralab';
const executableName = isDev ? 'xtralab-dev' : 'xtralab';
const appBundleId = isDev
  ? 'io.github.jtpio.xtralab.dev'
  : 'io.github.jtpio.xtralab';

// Optional macOS code-signing identity (a Keychain certificate name). When set,
// the packaged app is signed with it: a Developer ID, or a self-signed cert for
// personal use. A stable signature is what lets native (clickable) notifications
// register; an unsigned build falls back to osascript.
const signIdentity = process.env.XTRALAB_SIGN_IDENTITY;

const config: ForgeConfig = {
  packagerConfig: {
    name: productName,
    executableName,
    appBundleId,
    appCategoryType: 'public.app-category.developer-tools',
    icon: './assets/jupyter',
    asar: true,
    extraResource: ['python/runtime'],
    ...(signIdentity
      ? {
          osxSign: {
            identity: signIdentity,
            // Let a self-signed cert (flagged CSSMERR_TP_NOT_TRUSTED) sign
            // directly; codesign signs with it regardless, only verification
            // needs trust.
            identityValidation: false,
            // Skip the bundled Python runtime: only the app shell needs a
            // signature to register for notifications, and the runtime is a
            // subprocess with its own signatures.
            ignore: (file: string) =>
              file.includes('/Contents/Resources/runtime/'),
            // Skip the Apple timestamp server (a network round-trip per file)
            // and hardened runtime; both are only needed for notarization.
            optionsForFile: () => ({
              hardenedRuntime: false,
              timestamp: 'none'
            })
          }
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

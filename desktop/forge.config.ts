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

// Optional macOS code-signing identity (a Keychain code-signing certificate
// name). When set, the packaged app is signed with it — a Developer ID for
// distribution, or a self-signed cert for personal/local use. A stable
// signature is what lets the bundle register with Notification Center, so native
// (clickable) notifications work; an unsigned/ad-hoc build can't.
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
            // identityValidation:false lets a self-signed cert sign directly:
            // find-identity flags it CSSMERR_TP_NOT_TRUSTED, which the default
            // validation would reject, but codesign signs with it regardless
            // (trust matters for verifying a signature, not for making one).
            identityValidation: false,
            // Don't deep-sign the bundled Python runtime — thousands of files
            // (incl. .pyc), each of which would otherwise get its own
            // network-timestamped codesign call. Only the app shell needs a
            // signature to register for notifications; the runtime runs as a
            // subprocess and keeps its own signatures.
            ignore: (file: string) =>
              file.includes('/Contents/Resources/runtime/'),
            // Local self-signed build: skip the Apple timestamp server (a
            // network round-trip per file) and hardened runtime (the latter is
            // a notarization requirement, not needed here).
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

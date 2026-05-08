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

const config: ForgeConfig = {
  packagerConfig: {
    name: productName,
    executableName,
    appBundleId,
    appCategoryType: 'public.app-category.developer-tools',
    icon: './assets/jupyter',
    asar: true,
    extraResource: ['python/runtime'],
    ignore: [
      /^\/out($|\/)/,
      /^\/forge\.config\.(ts|js)$/,
      /^\/tsconfig.*\.json$/,
      /^\/.+\.tsbuildinfo$/,
      /^\/src\/.*\.ts$/,
      /^\/scripts\/.*$/,
      /\.map$/,
      /^\/python($|\/)/,
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

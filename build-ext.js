const esbuild = require('esbuild')
const esbuildPluginTsc = require('esbuild-plugin-tsc')

/** import("esbuild").BuildOptions */
const settings = {
  entryPoints: ['ext-src/extension.ts'],
  outfile: 'build/ext-src/extension.js',
  platform: 'node',
  bundle: true,
  external: [
    'vscode'
  ],
  plugins: [
    esbuildPluginTsc({
      force: true,
      tsconfigPath: 'tsconfig.extension.json'
    })
  ]
}

esbuild.build(settings)

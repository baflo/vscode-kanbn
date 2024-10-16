const esbuild = require('esbuild')
const esbuildPluginTsc = require('esbuild-plugin-tsc')

/** import("esbuild").BuildOptions */
const settings = {
  entryPoints: ['src/index.tsx'],
  outdir: 'build/static/',
  platform: 'browser',
  bundle: true,
  loader: {
    '.html': 'file',
    '.ttf': 'file',
    '.ttf?*': 'file',
    '.woff': 'file',
    '.woff2': 'file'
  },
  plugins: [
    esbuildPluginTsc({
      force: true,
      tsconfigPath: 'tsconfig.json'
    })
  ]
}

esbuild.build(settings)

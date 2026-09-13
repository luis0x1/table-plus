import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import solid from 'vite-plugin-solid'

const iconWeights = new Set(['100', '200', '300', '400', '500', '600', '700'])
const materialSymbolPrefix = 'virtual:material-symbol/'
const requireFrom = createRequire(import.meta.url)
// The package exports map only declares an `import` condition, so resolve the icon
// sources from the package root instead of through a subpath export.
const symbolRoot = join(dirname(requireFrom.resolve('@material-symbols-svg/react/package.json')), 'dist/rounded/icons')

// Material Symbols ship as React components. Only their path data is used here,
// so the selected weight is extracted at build time and rendered by a Solid component.
function symbolPath(name: string, weight: string) {
  const source = readFileSync(join(symbolRoot, `${name}.js`), 'utf8')
  const regular = source.split(/\bfilled:/)[0]
  const path = new RegExp(`"${weight}":\\s*"([^"]+)"`).exec(regular)?.[1]
  if (!path) throw new Error(`Material Symbol ${name} has no rounded weight ${weight}`)
  return path
}

function materialSymbols(weight: string): Plugin {
  return {
    name: 'querynest-material-symbols',
    enforce: 'pre',
    resolveId(id) {
      return id.startsWith(materialSymbolPrefix) ? `\0${id}` : undefined
    },
    load(id) {
      if (!id.startsWith(`\0${materialSymbolPrefix}`)) return undefined
      const name = id.slice(`\0${materialSymbolPrefix}`.length)
      if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`Invalid Material Symbol name: ${name}`)
      return `export default ${JSON.stringify(symbolPath(name, weight))}`
    },
  }
}

export default defineConfig(({ mode }) => {
  const requestedWeight = loadEnv(mode, '.').VITE_ICON_WEIGHT?.trim() || '500'
  if (!iconWeights.has(requestedWeight)) throw new Error(`VITE_ICON_WEIGHT must be 100, 200, 300, 400, 500, 600, or 700; received ${requestedWeight}`)
  return {
    plugins: [materialSymbols(requestedWeight), solid()],
    build: { outDir: 'dist', emptyOutDir: true },
    server: { port: 34115, strictPort: true },
  }
})

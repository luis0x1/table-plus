import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const iconWeights = new Set(['100', '200', '300', '400', '500', '600', '700'])
const materialSymbolPrefix = 'virtual:material-symbol/'

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
      const component = name.split('-').map(part => part[0].toUpperCase() + part.slice(1)).join('')
      return `export { ${component}W${weight} as default } from '@material-symbols-svg/react/rounded/${name}'`
    },
  }
}

export default defineConfig(({ mode }) => {
  const requestedWeight = loadEnv(mode, '.').VITE_ICON_WEIGHT?.trim() || '500'
  if (!iconWeights.has(requestedWeight)) throw new Error(`VITE_ICON_WEIGHT must be 100, 200, 300, 400, 500, 600, or 700; received ${requestedWeight}`)
  return {
    plugins: [materialSymbols(requestedWeight), react()],
    build: { outDir: 'dist', emptyOutDir: true },
    server: { port: 34115, strictPort: true },
  }
})

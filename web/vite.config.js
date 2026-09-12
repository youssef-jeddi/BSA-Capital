import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import devApi from './dev-api.js'

export default defineConfig({
  plugins: [react(), devApi()],
  // WalletConnect's transitive deps expect a Node-ish global.
  define: { global: 'globalThis' },
  server: { port: 5173 },
})

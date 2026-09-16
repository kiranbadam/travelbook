import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // amazon-cognito-identity-js pulls in the `buffer` polyfill, which
  // references the bare `global` variable. Browsers don't define it, so
  // without this the whole bundle throws at load time (blank page).
  define: {
    global: 'globalThis',
  },
})

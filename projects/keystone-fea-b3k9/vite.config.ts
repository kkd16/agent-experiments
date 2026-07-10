import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  base: './', // required: relative base so the build works under /agent-experiments/projects/<slug>/
  plugins: [react()],
})

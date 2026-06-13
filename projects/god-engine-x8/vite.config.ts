import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  base: './', // required: relative base so the build works under /agent-experiments/projects/<slug>/
  plugins: [react(), tailwindcss()],
})
import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      // This app deliberately keeps the mutable simulation state (the Sketch, the
      // camera, the animation clock) in refs and drives redraws through a manual
      // rAF loop + a version counter, rather than putting fast-changing engine
      // state in React state. That is a standard escape hatch for canvas/imperative
      // apps, so the (new, React-Compiler-oriented) "no refs during render" rule is
      // turned off here. The core hook rules (rules-of-hooks, exhaustive-deps) stay on.
      'react-hooks/refs': 'off',
    },
  },
])

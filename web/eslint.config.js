import hooks from 'eslint-plugin-react-hooks'
import react from 'eslint-plugin-react'

/**
 * The build only catches syntax and imports. The two classes of bug that have
 * actually produced a blank screen here are a hook behind a conditional return
 * and a reference to a `const` declared further down the component; both are
 * caught below and by no-undef.
 */
export default [
  {
    files: ['src/**/*.jsx', 'src/**/*.js'],
    plugins: { 'react-hooks': hooks, react },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { window: 'readonly', document: 'readonly', localStorage: 'readonly',
                 navigator: 'readonly', fetch: 'readonly', console: 'readonly',
                 setTimeout: 'readonly', clearTimeout: 'readonly',
                 setInterval: 'readonly', clearInterval: 'readonly',
                 Buffer: 'readonly', TextEncoder: 'readonly', TextDecoder: 'readonly',
                 URLSearchParams: 'readonly', sessionStorage: 'readonly', Event: 'readonly',
                 CustomEvent: 'readonly', WebSocket: 'readonly', crypto: 'readonly' },
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'no-undef': 'error',
      'no-const-assign': 'error',
      // Without this, every component read only from JSX looks unused.
      'react/jsx-uses-vars': 'error',
      'react/jsx-uses-react': 'error',
      // Catches imports and helpers left behind by a refactor.
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }],
    },
  },
]

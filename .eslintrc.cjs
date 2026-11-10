module.exports = {
  root: true,
  env: { browser: true, es2022: true },
  parserOptions: { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true } },
  settings: { react: { version: '18.3' } },
  extends: ['eslint:recommended', 'plugin:react/recommended', 'plugin:react/jsx-runtime', 'plugin:react-hooks/recommended'],
  plugins: ['react-refresh'],
  ignorePatterns: ['dist', 'node_modules', 'test-results', 'playwright-report'],
  rules: {
    'react/prop-types': 'off',
    'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' }],
    // Security guard-rails for a wallet codebase.
    'no-eval': 'error',
    'no-implied-eval': 'error',
    'no-new-func': 'error',
    'react/no-danger': 'error',
  },
  overrides: [
    {
      files: ['src/background/**/*.js', 'src/contentscript/**/*.js', 'src/shared/**/*.js'],
      env: { browser: false, serviceworker: true, webextensions: true },
      globals: { chrome: 'readonly', AbortController: 'readonly' },
      rules: {
        // The service worker has no DOM or web storage; the original design bug was secrets in localStorage.
        'no-restricted-globals': ['error', 'window', 'document', 'localStorage', 'sessionStorage'],
      },
    },
    {
      // Content scripts and the provider run in web pages: keep them free of console noise except errors.
      files: ['src/contentscript/**/*.js'],
      env: { browser: true, webextensions: true },
      rules: { 'no-restricted-globals': 'off' },
    },
    {
      files: ['src/components/**/*.jsx', 'src/helpers/**/*.js', 'src/App.jsx', 'src/main.jsx'],
      globals: { chrome: 'readonly' },
    },
    {
      files: ['tests/**/*.js', '*.config.js', '.eslintrc.cjs'],
      env: { node: true, browser: true },
      globals: { chrome: 'writable' },
    },
  ],
};

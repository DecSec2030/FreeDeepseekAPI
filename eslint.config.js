export default [
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: {
        process: "readonly",
        fetch: "readonly",
        setTimeout: "readonly",
        setInterval: "readonly",
        Buffer: "readonly",
        WebAssembly: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        clearInterval: "readonly",
        __dirname: "readonly",
        URL: "readonly",
      }
    },
    rules: {
      "no-unused-vars": ["warn", { "argsIgnorePattern": "^_", "caughtErrors": "none" }],
      "no-undef": "error",
      "no-var": "error",
      "prefer-const": "error",
      "eqeqeq": "error",
      "no-trailing-spaces": "warn",
      "semi": ["error", "always"]
    }
  }
];

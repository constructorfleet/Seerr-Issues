import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    // Build output and deps are not ours to lint.
    ignores: ["dist/**", "node_modules/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        // Node runtime globals used across the app.
        process: "readonly",
        console: "readonly",
        setInterval: "readonly",
        fetch: "readonly",
        URL: "readonly",
        NodeJS: "readonly",
      },
    },
    rules: {
      // Allow intentionally-unused args when prefixed with `_` (e.g. Express
      // error middleware's `_next`).
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  // Keep Prettier's formatting authoritative; disable stylistic ESLint rules.
  prettier,
);

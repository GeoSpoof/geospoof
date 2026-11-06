import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettierConfig from "eslint-config-prettier";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default [
  // Global ignores
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "coverage/**",
      "build/**",
      "*.zip",
      "background/**",
      "content/**",
      "popup/**",
      ".agents/**",
      ".worktrees/**",
    ],
  },

  // Base JS recommended rules
  js.configs.recommended,

  // TypeScript recommended rules (type-aware)
  ...tseslint.configs.recommendedTypeChecked,

  // Pin the TSConfig root for every file. `recommendedTypeChecked` applies the
  // TS parser to all files; without an explicit tsconfigRootDir, newer
  // typescript-eslint tries to infer it and errors when several candidates
  // exist ("multiple candidate TSConfigRootDirs" — the repo root vs. cdk/).
  // That surfaces on the CI checkout path (…/geospoof/geospoof) even though a
  // local clone resolves to a single candidate. Harmless for the files that
  // opt out of type-aware parsing below.
  {
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: __dirname,
      },
    },
  },

  // TypeScript files configuration
  {
    files: ["src/**/*.ts", "tests/**/*.ts", "scripts/**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: __dirname,
      },
      globals: {
        browser: "readonly",
        chrome: "readonly",
        console: "readonly",
        document: "readonly",
        window: "readonly",
        navigator: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        globalThis: "readonly",
        global: "readonly",
        process: "readonly",
        URL: "readonly",
        HTMLElement: "readonly",
        HTMLInputElement: "readonly",
        HTMLDivElement: "readonly",
        Event: "readonly",
        KeyboardEvent: "readonly",
        MouseEvent: "readonly",
        MutationObserver: "readonly",
        Node: "readonly",
        NodeList: "readonly",
        Element: "readonly",
        Intl: "readonly",
        Date: "readonly",
        AbortController: "readonly",
        fetch: "readonly",
        Response: "readonly",
        Headers: "readonly",
        Request: "readonly",
      },
    },
    rules: {
      // Disable base rules that conflict with TS
      "no-unused-vars": "off",
      "no-undef": "off",
      "no-redeclare": "off",

      // TypeScript rules
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/require-await": "error",

      // Keep console allowed
      "no-console": "off",

      // Disable rules that produce false positives for this codebase
      "no-useless-assignment": "off",

      // Strict rules for source code
      "@typescript-eslint/only-throw-error": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/unbound-method": "error",
      "preserve-caught-error": "off",
    },
  },

  // JavaScript config files (no type checking)
  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        module: "readonly",
        require: "readonly",
        exports: "readonly",
      },
    },
  },

  // Root-level TypeScript config files (no type checking)
  {
    files: ["**/*.config.ts", "**/*.config.mts"],
    ...tseslint.configs.disableTypeChecked,
  },

  // Test files — relax rules that are too strict for test code
  {
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-require-imports": "warn",
      "@typescript-eslint/ban-ts-comment": "warn",
      "@typescript-eslint/prefer-promise-reject-errors": "warn",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unsafe-assignment": "warn",
      "@typescript-eslint/no-unsafe-member-access": "warn",
      "@typescript-eslint/no-unsafe-call": "warn",
      "@typescript-eslint/no-unsafe-return": "warn",
      "@typescript-eslint/no-unsafe-argument": "warn",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },

  // Prettier integration (must be last)
  prettierConfig,
];

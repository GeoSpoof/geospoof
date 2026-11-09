import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  // Build-time flags injected by Vite's `define` in production builds. Vitest
  // doesn't run that plugin, so define them here (default to the Firefox build)
  // — otherwise importing the background entry throws on top-level `__SAFARI__`.
  define: {
    __SAFARI__: "false",
    __CHROMIUM__: "false",
    __FIREFOX__: "true",
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: [
        "src/background/index.ts",
        "tests/helpers/content.test.helper.ts",
        "src/shared/utils/**/*.ts",
        "src/shared/types/settings.ts",
      ],
      exclude: ["node_modules/", "dist/", "tests/", "**/*.config.ts", "**/*.d.ts", "**/.gitkeep"],
      thresholds: {
        lines: 70,
        functions: 65,
        branches: 65,
        statements: 70,
      },
    },
    include: ["tests/**/*.test.ts", "tests/**/*.test.js"],
    // tests/safari runs only under vitest.safari.config.ts (`npm run test:safari`).
    exclude: ["node_modules", "dist", "tests/safari/**"],
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
      "@/background": resolve(__dirname, "./src/background"),
      "@/content": resolve(__dirname, "./src/content"),
      "@/popup": resolve(__dirname, "./src/popup"),
      "@/shared": resolve(__dirname, "./src/shared"),
    },
  },
});

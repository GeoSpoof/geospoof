/// <reference types="node" />
import { defineConfig, loadEnv, type Plugin } from "vite";
import { resolve } from "path";
import { cpSync, existsSync, readFileSync, writeFileSync } from "fs";
import { build as esbuild } from "esbuild";
import {
  generateManifest,
  resolveBrowserTarget,
  type BrowserTarget,
} from "./src/build/manifest.ts";

// Vite 8's forthcoming native config loader does not inject the CommonJS
// `__dirname`. Derive it from `import.meta.dirname` (Node >= 20.11, which both
// local dev and CI exceed) so the config is forward-compatible with
// `configLoader: 'native'` without rewriting every path call below.
const __dirname = import.meta.dirname;

/**
 * Vite plugin that configures the build for a specific browser target.
 *
 * Responsibilities:
 * - Sets the __CHROMIUM__ build-time define
 * - Generates the correct manifest.json for the target
 * - Copies static assets (HTML, CSS, icons) to dist/
 * - For Chromium: re-bundles content scripts as IIFE (service worker and
 *   popup load as ES modules, but content scripts run as classic scripts)
 */
function browserTargetPlugin(target: BrowserTarget): Plugin {
  /** Entry point file paths that need the polyfill on Chromium builds. */
  const entryPointPatterns = [
    /src[/\\]background[/\\]index\.ts$/,
    /src[/\\]content[/\\]index\.ts$/,
    /src[/\\]popup[/\\]index\.ts$/,
  ];

  return {
    name: "browser-target",

    config() {
      return {
        define: {
          __CHROMIUM__: JSON.stringify(target === "chromium"),
          __SAFARI__: JSON.stringify(target === "safari"),
          __FIREFOX__: JSON.stringify(target === "firefox"),
        },
      };
    },

    /**
     * For Chromium builds, prepend `import "webextension-polyfill"` to each
     * entry point so the promise-based `browser.*` namespace is available at
     * runtime. On Firefox the native namespace exists, so no polyfill is needed.
     *
     * Also patches `window.` references to `globalThis.` in dependencies
     * (e.g. browser-geo-tz) so they work in MV3 service workers where
     * `window` is not defined.
     */
    transform(code: string, id: string) {
      if (target !== "chromium") return null;

      // For entry points: import polyfill and set globalThis.browser
      const isEntry = entryPointPatterns.some((re) => re.test(id));
      if (isEntry) {
        return {
          code: `import browser from "webextension-polyfill";\nglobalThis.browser = browser;\n${code}`,
          map: null,
        };
      }

      // Patch window references in dependencies for service worker compat
      if (id.includes("node_modules") && code.includes("window.")) {
        return {
          code: code.replace(/\bwindow\./g, "globalThis."),
          map: null,
        };
      }

      return null;
    },

    async writeBundle() {
      // Read version from package.json
      const pkg = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf-8"));
      const version: string | undefined = pkg.version;
      if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
        throw new Error(`Invalid or missing version in package.json: "${version}"`);
      }

      // Generate and write manifest
      const manifest = generateManifest(target, version);
      writeFileSync(
        resolve(__dirname, "dist/manifest.json"),
        JSON.stringify(manifest, null, 2) + "\n"
      );

      // Copy static assets
      const assets = [
        { from: "assets/popup.html", to: "dist/popup/popup.html" },
        { from: "assets/popup.css", to: "dist/popup/popup.css" },
      ];
      for (const asset of assets) {
        const src = resolve(__dirname, asset.from);
        if (existsSync(src)) {
          cpSync(src, resolve(__dirname, asset.to));
        }
      }

      // Ship LICENSE and NOTICE in every package. Apache 2.0 Section 4 requires
      // both to travel with redistributed copies, and NOTICE carries the MIT
      // notices for contributed code that ships in the popup.
      for (const file of ["LICENSE", "NOTICE"]) {
        cpSync(resolve(__dirname, file), resolve(__dirname, `dist/${file}`));
      }

      // Copy icons directory
      const iconsSrc = resolve(__dirname, "icons");
      if (existsSync(iconsSrc)) {
        cpSync(iconsSrc, resolve(__dirname, "dist/icons"), { recursive: true });
      }

      // Copy _locales directory. All three MV3 targets (Firefox,
      // Chromium, Safari Web Extension) read localized strings from
      // _locales/<lang>/messages.json and resolve __MSG_*__ references
      // in manifest.json against it. The directory has to sit at the
      // root of the extension bundle for the browser to find it.
      const localesSrc = resolve(__dirname, "_locales");
      if (existsSync(localesSrc)) {
        cpSync(localesSrc, resolve(__dirname, "dist/_locales"), {
          recursive: true,
          // Skip the contributor README — it's for GitHub, not for
          // shipping inside the bundled extension.
          filter: (src) => !src.endsWith("README.md"),
        });
      }

      // Firefox and Safari: re-bundle content scripts as IIFE.
      if (target === "firefox" || target === "safari") {
        const contentScripts = ["content/content.js", "content/injected.js"];
        for (const script of contentScripts) {
          const scriptPath = resolve(__dirname, "dist", script);
          if (existsSync(scriptPath)) {
            await esbuild({
              entryPoints: [scriptPath],
              bundle: true,
              format: "iife",
              outfile: scriptPath,
              allowOverwrite: true,
              target: target === "safari" ? "safari18" : "firefox140",
              ...(script === "content/injected.js" ? { banner: { js: '"use strict";' } } : {}),
              nodePaths: [resolve(__dirname, "node_modules")],
            });
          }
        }
      }

      // Chromium: re-bundle content scripts as IIFE.
      // Content scripts in Chromium MV3 load as classic scripts — they cannot
      // use ES module import/export. The main Vite build produces ES modules,
      // so we post-process content scripts with esbuild to produce
      // self-contained IIFE bundles with all dependencies inlined.
      if (target === "chromium") {
        const contentScripts = ["content/content.js", "content/injected.js"];
        for (const script of contentScripts) {
          const scriptPath = resolve(__dirname, "dist", script);
          if (existsSync(scriptPath)) {
            await esbuild({
              entryPoints: [scriptPath],
              bundle: true,
              format: "iife",
              outfile: scriptPath,
              allowOverwrite: true,
              target: "chrome120",
              // Inject "use strict" for the injected script to ensure
              // .arguments/.caller access throws TypeError (arkenfox tests p, q)
              ...(script === "content/injected.js" ? { banner: { js: '"use strict";' } } : {}),
              // Resolve bare imports from node_modules
              nodePaths: [resolve(__dirname, "node_modules")],
            });
          }
        }
      }

      // Build-time validation: verify "use strict" is present in the
      // compiled injected script. Without it, .arguments/.caller access
      // returns undefined instead of throwing TypeError, breaking
      // arkenfox proxy error tests p and q.
      const injectedOutputPath = resolve(__dirname, "dist/content/injected.js");
      if (existsSync(injectedOutputPath)) {
        const injectedContent = readFileSync(injectedOutputPath, "utf-8");
        const first100 = injectedContent.substring(0, 100);
        if (!first100.includes('"use strict"') && !first100.includes("'use strict'")) {
          throw new Error(
            'Build validation failed: "use strict" not found in the first 100 characters of dist/content/injected.js'
          );
        }
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  const isDev = mode === "development";

  // Load all env variables (including non-VITE_ prefixed) from .env files
  const env = loadEnv(mode, (process as NodeJS.Process).cwd(), "");

  // Resolve browser target from BROWSER env var (default: "firefox")
  const browserTarget = resolveBrowserTarget(process.env.BROWSER || env.BROWSER);

  return {
    build: {
      outDir: "dist",
      emptyOutDir: true,
      minify: isDev ? false : "esbuild",
      sourcemap: isDev ? "inline" : false,
      target: "ES2022",
      rollupOptions: {
        input: {
          "background/background": resolve(__dirname, "src/background/index.ts"),
          "content/content": resolve(__dirname, "src/content/index.ts"),
          "content/injected": resolve(__dirname, "src/content/injected/index.ts"),
          "popup/popup": resolve(__dirname, "src/popup/index.ts"),
        },
        treeshake: true,
        output: {
          entryFileNames: "[name].js",
          chunkFileNames: "shared/[name]-[hash].js",
          assetFileNames: "[name].[ext]",
          format: "es",
        },
      },
    },

    plugins: [browserTargetPlugin(browserTarget)],

    resolve: {
      alias: {
        "@": resolve(__dirname, "./src"),
        "@/background": resolve(__dirname, "./src/background"),
        "@/content": resolve(__dirname, "./src/content"),
        "@/popup": resolve(__dirname, "./src/popup"),
        "@/shared": resolve(__dirname, "./src/shared"),
      },
    },

    define: {
      "process.env.EVENT_NAME": JSON.stringify(env.EVENT_NAME || "__x_evt"),
      "process.env.NODE_ENV": JSON.stringify(mode),
      "process.env.DEBUG": JSON.stringify(env.DEBUG || "false"),
    },

    esbuild: isDev
      ? {}
      : {
          drop: [],
          keepNames: false,
        },
  };
});

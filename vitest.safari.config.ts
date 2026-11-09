import { mergeConfig } from "vitest/config";
import base from "./vitest.config";

// The Safari suite (tests/safari): the default config with the Safari build's
// flags, so `__SAFARI__` code paths and the real `siteGroupsAvailable()` run.
const config = mergeConfig(base, {
  define: { __SAFARI__: "true", __CHROMIUM__: "false", __FIREFOX__: "false" },
});
// mergeConfig concatenates arrays, so the inherited include and exclude are replaced here.
config.test.include = ["tests/safari/**/*.test.ts"];
config.test.exclude = ["node_modules", "dist"];
delete config.test.coverage; // the default thresholds don't apply to one suite
export default config;

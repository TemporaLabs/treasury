import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/tests/**/*.test.ts"],
    // `.cache/` is the skill validator's clone (scripts/lint-skill.sh) and `site/` the built docs — both
    // gitignored, both inside the include glob above without this line. Measured: a `tests/x.test.ts`
    // dropped under `.cache/` ran as part of `npm test`.
    exclude: ["**/node_modules/**", "**/dist/**", "**/.cache/**", "**/site/**"],
    testTimeout: 20_000,
  },
});

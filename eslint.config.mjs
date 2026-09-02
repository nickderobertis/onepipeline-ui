import nx from "@nx/eslint-plugin";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // `test-results/` is Playwright's own scratch: it is created, filled, and cleared
    // out from under whatever else is reading the tree, so a lint run that walked into
    // it raced that cleanup and died with ENOENT on a file that no longer existed.
    // Biome already excludes it (`biome.json`); this is the same exclusion for ESLint.
    ignores: [
      "**/dist/**",
      "**/.nx/**",
      "**/node_modules/**",
      "**/test-results/**",
      "**/playwright-report/**",
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    plugins: { "@nx": nx },
    rules: {
      "@nx/enforce-module-boundaries": [
        "error",
        {
          enforceBuildableLibDependency: true,
          allow: [],
          depConstraints: [
            {
              sourceTag: "scope:shared",
              onlyDependOnLibsWithTags: ["scope:shared"],
            },
            {
              sourceTag: "scope:app",
              onlyDependOnLibsWithTags: ["scope:shared"],
            },
            // The journeys drive an app and must not import one: what they need
            // of its vocabulary is a shared package both sides depend on, so a
            // journey cannot be coupled to how the app spells its own internals.
            {
              sourceTag: "scope:e2e",
              onlyDependOnLibsWithTags: ["scope:shared"],
            },
          ],
        },
      ],
    },
  },
);

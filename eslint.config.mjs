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
          // The app's own public test-support export, and the only import path
          // here that names an application. `dag-ui-e2e` drives the built app and
          // has to hold the vocabulary the app draws from — `EVENT_CATEGORIES` is
          // what "one record of every category is drawn" is counted against, and a
          // journey with its own copy of it passes while the app grows a category
          // nobody draws. Exactly this path, so nothing else about the app becomes
          // importable: the rule that apps are not libraries still holds for every
          // other file in it, and `apps/dag-ui/package.json` publishes no other
          // entry point.
          allow: ["@onepipeline-ui/dag-ui/testing"],
          depConstraints: [
            {
              sourceTag: "scope:shared",
              onlyDependOnLibsWithTags: ["scope:shared"],
            },
            {
              sourceTag: "scope:app",
              onlyDependOnLibsWithTags: ["scope:shared"],
            },
          ],
        },
      ],
    },
  },
);

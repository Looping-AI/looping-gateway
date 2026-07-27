import tseslint from "typescript-eslint";

import local from "./eslint-rules/index.js";

export default tseslint.config(
  {
    extends: [...tseslint.configs.recommended],
    files: ["src/**/*.ts", "test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "no-unused-expressions": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_"
        }
      ]
    }
  },
  {
    // Type-aware pass — enables @deprecated detection without switching the
    // whole config to recommendedTypeChecked and its stricter rule set.
    files: ["src/**/*.ts", "test/**/*.ts"],
    plugins: { "@typescript-eslint": tseslint.plugin, local },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      "@typescript-eslint/no-deprecated": "error",
      // Covers the object-literal blind spot in the rule above (typescript-eslint#10883).
      "local/no-deprecated-object-properties": "error"
    }
  },
  {
    // Generated / build artifacts — never lint these.
    ignores: [
      "worker-configuration.d.ts",
      "node_modules/",
      ".wrangler/",
      "migrations/"
    ]
  }
);

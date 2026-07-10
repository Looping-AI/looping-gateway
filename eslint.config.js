import tseslint from "typescript-eslint";

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
    plugins: { "@typescript-eslint": tseslint.plugin },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      "@typescript-eslint/no-deprecated": "error"
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

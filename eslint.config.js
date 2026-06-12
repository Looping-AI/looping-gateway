import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    extends: [...tseslint.configs.recommended],
    files: ["src/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "no-unused-expressions": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    ignores: ["env.d.ts", "node_modules/"],
  },
);

import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["dist/**"],
  },
  {
    rules: {
      // Companion namespaces are how this project groups types with their class
      "@typescript-eslint/no-namespace": "off",
    },
  },
);

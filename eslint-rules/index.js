import { noDeprecatedObjectProperties } from "./no-deprecated-object-properties.js";

/** Local ESLint plugin — rules that live in this repo, referenced as `local/*`. */
export default {
  meta: { name: "eslint-plugin-local" },
  rules: {
    "no-deprecated-object-properties": noDeprecatedObjectProperties
  }
};

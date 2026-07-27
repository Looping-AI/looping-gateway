import { ESLintUtils } from "@typescript-eslint/utils";

/**
 * Flags `@deprecated` properties used as keys in object literals.
 *
 * `@typescript-eslint/no-deprecated` cannot see these. For an object literal it
 * calls `getTypeAtLocation(objectExpression)`, which yields the literal's own
 * *inferred* type — an anonymous type whose properties carry no JSDoc — rather
 * than the contextual type that actually declares the deprecation. (Its JSX
 * branch uses `getContextualType` and does work.) So member access like
 * `opts.system` is reported, but `generateText({ system })` is silently allowed,
 * even when the object is written to an explicitly annotated variable.
 *
 * That blind spot covers essentially every options-bag API — the AI SDK's
 * `generateText`/`streamText` among them — so this rule closes it by resolving
 * the contextual type itself and checking each key against it.
 *
 * Upstream issue: typescript-eslint#10883.
 */
export const noDeprecatedObjectProperties = ESLintUtils.RuleCreator.withoutDocs(
  {
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow `@deprecated` properties as keys in object literals"
      },
      messages: {
        deprecated: "`{{name}}` is deprecated.{{reason}}"
      },
      schema: []
    },
    defaultOptions: [],
    create(context) {
      const services = ESLintUtils.getParserServices(context);
      const checker = services.program.getTypeChecker();

      /** Property name for a non-computed key, or undefined if not statically known. */
      const staticName = (property) => {
        if (property.computed) return undefined;
        const { key } = property;
        if (key.type === "Identifier") return key.name;
        if (key.type === "Literal" && typeof key.value === "string")
          return key.value;
        return undefined;
      };

      return {
        ObjectExpression(node) {
          const tsNode = services.esTreeNodeToTSNodeMap.get(node);
          // Undefined whenever the literal is not contextually typed (e.g. an
          // unannotated `const`), in which case there is no declared property to
          // consult and nothing to report.
          const contextualType = checker.getContextualType(tsNode);
          if (contextualType === undefined) return;

          for (const property of node.properties) {
            if (property.type !== "Property") continue; // skip SpreadElement
            const name = staticName(property);
            if (name === undefined) continue;

            const symbol = contextualType.getProperty(name);
            if (symbol === undefined) continue;

            const tag = symbol
              .getJsDocTags(checker)
              .find((t) => t.name === "deprecated");
            if (tag === undefined) continue;

            const text = (tag.text ?? []).map((part) => part.text).join("");
            context.report({
              node: property.key,
              messageId: "deprecated",
              data: { name, reason: text ? ` ${text}` : "" }
            });
          }
        }
      };
    }
  }
);

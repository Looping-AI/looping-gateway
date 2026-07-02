# Cloudflare Workers

STOP. Your knowledge of Cloudflare Workers APIs and limits may be outdated. Always retrieve current documentation before any Workers, KV, R2, D1, Durable Objects, Queues, Vectorize, AI, or Agents SDK task.

## Docs

- https://developers.cloudflare.com/workers/
- MCP: `https://docs.mcp.cloudflare.com/mcp`

For all limits and quotas, retrieve from the product's `/platform/limits/` page. eg. `/workers/platform/limits`

## Commands

| Command               | Purpose                                   |
| --------------------- | ----------------------------------------- |
| `npx wrangler dev`    | Local development                         |
| `npx wrangler deploy` | Deploy to Cloudflare                      |
| `npm run types`       | Generate TypeScript types (runtime + Env) |
| `npm run check`       | Format, lint, typecheck + verify types    |

## TypeScript Types

Follow Cloudflare's generated-types flow (https://developers.cloudflare.com/workers/languages/typescript/#generate-types):

- `wrangler types` generates `worker-configuration.d.ts` — **both** runtime globals (`D1Database`, `Ai`, `Workflow`, …) and the `Env` interface — matched to our `compatibility_date`/`compatibility_flags`. This file is committed to git.
- Do **not** add or reference `@cloudflare/workers-types`. Runtime types come from `wrangler types`, not the npm package (which is only for shared libraries). `tsconfig` points at `worker-configuration.d.ts`, not the package.
- After changing bindings or compat settings in `wrangler.jsonc`, run `npm run types` and commit the regenerated `worker-configuration.d.ts`.
- `npm run check` (pre-commit + CI) runs `wrangler types --check` first and fails if the committed types are stale — so never hand-edit the generated file.

## Node.js Compatibility

https://developers.cloudflare.com/workers/runtime-apis/nodejs/

## Errors

- **Error 1102** (CPU/Memory exceeded): Retrieve limits from `/workers/platform/limits/`
- **All errors**: https://developers.cloudflare.com/workers/observability/errors/

## Product Docs

Retrieve API references and limits from:
`/kv/` · `/r2/` · `/d1/` · `/durable-objects/` · `/queues/` · `/vectorize/` · `/workers-ai/` · `/agents/`

## Best Practices (conditional)

If the application uses Durable Objects or Workflows, refer to the relevant best practices:

- Durable Objects: https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
- Workflows: https://developers.cloudflare.com/workflows/build/rules-of-workflows/

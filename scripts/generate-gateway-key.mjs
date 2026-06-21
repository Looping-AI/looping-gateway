/**
 * Generate an Ed25519 keypair for GATEWAY_JWT_PRIVATE_KEY.
 *
 * Usage:
 *   npm run keygen          # kid defaults to "gw-1"
 *   npm run keygen gw-2     # pass a different kid when rotating
 *
 * Output only — no files are written. Copy the printed line into whichever
 * env file / wrangler environment you need.
 */
import { generateKeyPair, exportJWK } from "jose";

const kid = process.argv[2] ?? "gw-1";

const { publicKey, privateKey } = await generateKeyPair("EdDSA", {
  crv: "Ed25519",
  extractable: true
});

const priv = await exportJWK(privateKey);
const pub = await exportJWK(publicKey);

priv.kid = pub.kid = kid;
priv.alg = pub.alg = "EdDSA";
pub.use = "sig";

const privJson = JSON.stringify(priv);
const privLine = `GATEWAY_JWT_PRIVATE_KEY=${privJson}`;
const hr = "─".repeat(76);

console.log(`\nGenerated Ed25519 keypair  (kid: ${kid})\n`);

console.log(`── Local dev ${hr.slice(12)}`);
console.log("Add to .dev.vars:\n");
console.log(`${privLine}\n`);

console.log(`── Wrangler secret (deployed env) ${hr.slice(34)}`);
console.log(
  "Run for your target env, then paste the JSON value below when prompted:\n"
);
console.log(
  `  npx wrangler secret put GATEWAY_JWT_PRIVATE_KEY              # default env`
);
console.log(
  `  npx wrangler secret put GATEWAY_JWT_PRIVATE_KEY --env staging\n`
);
console.log(`${privJson}\n`);

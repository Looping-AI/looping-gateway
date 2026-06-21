// Generate an Ed25519 JWK keypair for the example agent's card-signing key
// (or for the gateway's identity key). Usage:
//   node scripts/generate-keys.mjs [kid]
//
// Prints the PRIVATE JWK (set as the secret) and the PUBLIC JWK (served at the
// /.well-known/jwks.json endpoint). Keep the private JWK secret.
import { generateKeyPair, exportJWK } from "jose";

const kid = process.argv[2] ?? `key-${Date.now()}`;

const { publicKey, privateKey } = await generateKeyPair("EdDSA", {
  crv: "Ed25519",
  extractable: true
});

const priv = await exportJWK(privateKey);
const pub = await exportJWK(publicKey);

priv.kid = pub.kid = kid;
priv.alg = pub.alg = "EdDSA";
pub.use = "sig";

console.log("# PRIVATE JWK — keep secret (wrangler secret put …):");
console.log(JSON.stringify(priv));
console.log("\n# PUBLIC JWK — served via /.well-known/jwks.json:");
console.log(JSON.stringify(pub));

#!/usr/bin/env node
/**
 * Pre-flight for the iOS release upload: can this App Store Connect API key
 * see the app record for BUNDLE_ID?
 *
 * Xcode's export only says "Error Downloading App Information" when the key
 * authenticates but the record is invisible (missing record, wrong bundle id,
 * or a role without app access). This asks the API directly, in seconds,
 * before the ~20 minute archive, and prints what the key CAN see.
 *
 * Env: ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH (the .p8), BUNDLE_ID.
 * Exit 0 = visible, 1 = not visible / API refused.
 */

import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { Buffer } from "node:buffer";

const API = "https://api.appstoreconnect.apple.com/v1";

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

/** ES256 JWT for the App Store Connect API (20 min max lifetime; use 10). */
function makeToken({ keyId, issuerId, keyPem }) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({ iss: issuerId, iat: now, exp: now + 600, aud: "appstoreconnect-v1" }),
  );
  const signingInput = `${header}.${claims}`;
  const signature = sign("sha256", Buffer.from(signingInput), {
    key: createPrivateKey(keyPem),
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${base64url(signature)}`;
}

async function getJson(path, token) {
  const response = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`GET ${path} -> HTTP ${response.status}: ${body.slice(0, 400)}`);
  }
  return JSON.parse(body);
}

async function main() {
  const { ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH, BUNDLE_ID } = process.env;
  if (!ASC_KEY_ID || !ASC_ISSUER_ID || !ASC_KEY_PATH || !BUNDLE_ID) {
    throw new Error("ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH and BUNDLE_ID are required");
  }
  const token = makeToken({
    keyId: ASC_KEY_ID,
    issuerId: ASC_ISSUER_ID,
    keyPem: readFileSync(ASC_KEY_PATH, "utf8"),
  });
  const match = await getJson(
    `/apps?filter[bundleId]=${encodeURIComponent(BUNDLE_ID)}&fields[apps]=bundleId,name`,
    token,
  );
  // The API's bundleId filter is not an exact match (it returned an xtool
  // "XTL-<team>.com.cempmobile" record for "com.cempmobile"), so compare.
  const app = match.data.find((candidate) => candidate.attributes.bundleId === BUNDLE_ID);
  if (app !== undefined) {
    console.log(
      `App record visible: "${app.attributes.name}" (${app.attributes.bundleId}, id ${app.id})`,
    );
    return 0;
  }
  const all = await getJson("/apps?fields[apps]=bundleId,name&limit=50", token);
  console.error(`No app record for ${BUNDLE_ID} is visible to this key.`);
  console.error(
    all.data.length === 0
      ? "The key sees NO apps: check the record exists and the key's role (App Manager or Admin)."
      : `It can see: ${all.data.map((a) => `${a.attributes.name} (${a.attributes.bundleId})`).join(", ")}`,
  );
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });

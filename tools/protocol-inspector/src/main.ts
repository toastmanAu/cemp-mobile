#!/usr/bin/env node
/**
 * protocol-inspector — offline decoder for CEMP objects (ckb_testnet).
 *
 * Commands:
 *   cell <txHash>:<index> [--rpc <url>]   fetch + classify + decode a cell
 *   envelope <hex|@file>                  decode an envelope (structure only)
 *   payload <hex|@file> --own-profile-id <hex> [--show-plaintext]
 *       decrypt an envelope (secret key from CEMP_INSPECTOR_SK env — never argv)
 *   profile <hex|@file>                   decode a profile cell data payload
 *   bundle <json|@file>                   validate + show a contact bundle
 *   vault <path>                          parse + validate a vault file structure
 *
 * Rule 2 stands: plaintext payloads require the explicit --show-plaintext
 * flag; everything else prints structure and lengths only.
 */

import { readFileSync } from "node:fs";
import { CempClient, fetchJsonRpcTransport } from "@cemp/ckb";
import { decodeContactBundle } from "@cemp/core";
import { classifyCell, decodeEnvelope, decodeProfile, hexToBytes } from "./decode.js";
import { decryptPayloadView } from "./payload.js";

const USAGE = `usage:
  tsx src/main.ts cell <txHash>:<index> [--rpc <url>]
  tsx src/main.ts envelope <hex|@file>
  tsx src/main.ts payload <hex|@file> --own-profile-id <hex> [--show-plaintext]
  tsx src/main.ts profile <hex|@file>
  tsx src/main.ts bundle <json|@file>
  tsx src/main.ts vault <path>`;

function readHexOrFile(arg: string): Uint8Array {
  if (arg.startsWith("@")) {
    const text = readFileSync(arg.slice(1), "utf8").trim();
    return hexToBytes(text);
  }
  return hexToBytes(arg);
}

function show(label: string, value: unknown): void {
  if (typeof value === "object" && value !== null) {
    console.log(`${label}:`);
    for (const [key, entry] of Object.entries(value)) {
      console.log(`  ${key}: ${JSON.stringify(entry)}`);
    }
  } else {
    console.log(`${label}: ${JSON.stringify(value)}`);
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "cell": {
      const ref = rest[0];
      const rpcUrl = rest.includes("--rpc")
        ? rest[rest.indexOf("--rpc") + 1]!
        : "https://testnet.ckb.dev/rpc";
      const match = /^(0x[0-9a-f]{64}):(0x[0-9a-f]+|\d+)$/.exec(ref ?? "");
      if (match === null) {
        throw new Error("cell ref must be <txHash>:<index>");
      }
      const index = match[2]!.startsWith("0x") ? match[2]! : `0x${Number(match[2]).toString(16)}`;
      const client = new CempClient({
        transport: fetchJsonRpcTransport(10_000),
        endpoints: { rpc: rpcUrl, indexer: rpcUrl },
      });
      const status = await client.getLiveCell({ txHash: match[1]!, index });
      if (status.status !== "live") {
        console.log(`cell is ${status.status} (${match[1]}:${index})`);
        return;
      }
      const kind = classifyCell(status.cell);
      show(`cell ${match[1]}:${index} [${status.cell.output.capacity} shannon]`, kind);
      if (kind.kind === "message-cell") {
        show("envelope (structure)", decodeEnvelope(hexToBytes(status.cell.data)));
      }
      if (kind.kind === "profile-cell") {
        show("profile", decodeProfile(hexToBytes(status.cell.data)));
      }
      return;
    }
    case "envelope": {
      show("envelope (structure)", decodeEnvelope(readHexOrFile(rest[0] ?? "")));
      return;
    }
    case "payload": {
      const envelopeBytes = readHexOrFile(rest[0] ?? "");
      const ownProfileId = rest.includes("--own-profile-id")
        ? rest[rest.indexOf("--own-profile-id") + 1]!
        : (() => {
            throw new Error("--own-profile-id <hex> is required");
          })();
      const secretKey = process.env.CEMP_INSPECTOR_SK;
      if (secretKey === undefined) {
        throw new Error(
          "CEMP_INSPECTOR_SK env var (kem secret key hex) is required — never pass keys via argv",
        );
      }
      show(
        "payload (decrypted)",
        decryptPayloadView({
          envelopeBytes,
          kemSecretKeyHex: secretKey,
          ownProfileIdHex: ownProfileId,
          showPlaintext: rest.includes("--show-plaintext"),
        }),
      );
      return;
    }
    case "profile": {
      show("profile", decodeProfile(readHexOrFile(rest[0] ?? "")));
      return;
    }
    case "bundle": {
      const text = rest[0]?.startsWith("@")
        ? readFileSync(rest[0].slice(1), "utf8")
        : (rest[0] ?? "");
      show("contact bundle", decodeContactBundle(text));
      return;
    }
    case "vault": {
      const { parseVaultFile } = await import("@cemp/secure-vault");
      const bytes = new Uint8Array(readFileSync(rest[0] ?? ""));
      const file = parseVaultFile(bytes);
      show("vault file (structure — no secrets)", {
        version: file.version,
        kdf:
          file.kdf.alg === "argon2id"
            ? { alg: "argon2id", m: file.kdf.m, t: file.kdf.t, p: file.kdf.p }
            : { alg: "scrypt", logN: file.kdf.logN, r: file.kdf.r, p: file.kdf.p },
        biometricSlot: file.biometricSlot !== null,
        payloadBytes: file.payload.ct.length,
        meta: file.meta,
      });
      return;
    }
    default:
      console.error(USAGE);
      process.exitCode = command === undefined ? 0 : 1;
  }
}

main().catch((error: unknown) => {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

/**
 * LoRa gateway polling transport (docs/lora-transport Phase L2).
 * Platform-neutral: runs in Node, Hermes, and future iOS contexts.
 */

export { crc32 } from "./crc32.js";
export { LoraTransport, LoraTransportError } from "./transport.js";
export type { LoraTransportConfig, LoraObject, LoraPollResult } from "./transport.js";

import type { AgentBackend } from "../subagent-backend.js";
import { HermesBackend } from "./hermes.js";

/** Host assembly only. No probing, process startup, credential import or installation on import. */
export function configuredSubagentBackends(env: NodeJS.ProcessEnv = process.env): AgentBackend[] {
  if (!env.COWORK_HERMES_URL?.trim()) return [];
  return [new HermesBackend({ url: env.COWORK_HERMES_URL.trim(), apiKey: env.COWORK_HERMES_API_KEY ?? "" })];
}

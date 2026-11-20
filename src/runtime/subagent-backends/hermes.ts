import { setTimeout as delay } from "node:timers/promises";
import { observeHermesEvents } from "./hermes-events.js";
import type {
  AgentBackend,
  AgentResult,
  AgentRunContext,
  AgentTask,
  NativeReference
} from "../subagent-backend.js";

export interface HermesBackendOptions {
  /** API root, e.g. http://127.0.0.1:8642 (without /v1). */
  url: string;
  apiKey: string;
  pollMs?: number;
  requestTimeoutMs?: number;
  /** Bounds observation only; expiry does not imply the native run stopped. */
  observationTimeoutMs?: number;
}

type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Hermes response");
  return value as JsonObject;
}

/** Runs the independently installed Hermes agent and its native tools over its Runs API. */
export class HermesBackend implements AgentBackend {
  readonly id = "hermes";
  readonly name = "Hermes Agent";
  readonly description =
    "Independent Hermes runtime with its configured native tools, skills and memory. Returns a native report; no CoworkOS application grants, messaging, cancellation or automatic recovery.";
  readonly tags = ["native-tools", "skills", "general"];
  private readonly root: string;
  private readonly pollMs: number;
  private readonly requestTimeoutMs: number;
  private readonly observationTimeoutMs: number;

  constructor(private readonly options: HermesBackendOptions) {
    const url = new URL(options.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      throw new Error("Hermes URL must be an HTTP(S) API root without credentials, query or fragment");
    if (!options.apiKey.trim()) throw new Error("Hermes API server key is required");
    this.root = url.toString().replace(/\/$/, "");
    this.pollMs = positive(options.pollMs, 1000);
    this.requestTimeoutMs = positive(options.requestTimeoutMs, 15_000);
    this.observationTimeoutMs = positive(options.observationTimeoutMs, 30 * 60_000);
  }

  async check(): Promise<{ ready: boolean; message?: string }> {
    try {
      // An authenticated endpoint also detects a wrong key, unlike public /health.
      const response = await this.request("/v1/models");
      return { ready: response.ok, message: response.ok ? undefined : `Hermes HTTP ${response.status}` };
    } catch {
      return { ready: false, message: "Hermes API server is unreachable" };
    }
  }

  async run(task: AgentTask, context?: AgentRunContext): Promise<AgentResult> {
    if (task.inputs?.length || task.workingDirectory)
      return {
        status: "failed",
        summary:
          "This Hermes adapter accepts task text and optional text context only; configure workspace and input access in Hermes itself."
      };
    if (!task.callId.trim() || !task.task.trim())
      return { status: "failed", summary: "Hermes requires a callId and nonempty task" };
    let nativeRef: NativeReference | undefined;
    const observationController = new AbortController();
    let observation: Promise<void> | undefined;
    const deadline = Date.now() + this.observationTimeoutMs;
    try {
      // Never retry POST: older Hermes releases do not deduplicate Runs creation.
      const created = await this.request("/v1/runs", {
        method: "POST",
        headers: { "Idempotency-Key": task.callId },
        body: JSON.stringify({
          input: task.context ? `${task.task}\n\nContext supplied by Main:\n${task.context}` : task.task
        })
      });
      if (!created.ok)
        return {
          status: [400, 401, 403, 404, 422].includes(created.status) ? "failed" : "unknown",
          summary: `Hermes run creation returned HTTP ${created.status}. No automatic resubmission was made.`
        };
      const receipt = object(await created.json());
      if (typeof receipt.run_id !== "string" || !receipt.run_id.trim())
        throw new Error("Missing Hermes run id");
      const runId = receipt.run_id;
      nativeRef = { runId, apiRoot: this.root };
      await context?.onReference?.(nativeRef);
      if (context?.onObservation) {
        observation = observeHermesEvents({
          url: this.root,
          apiKey: this.options.apiKey,
          runId,
          signal: AbortSignal.any([
            observationController.signal,
            AbortSignal.timeout(this.observationTimeoutMs)
          ]),
          emit: context.onObservation
        }).catch(async () => {
          if (!observationController.signal.aborted)
            await context.onProgress?.("Hermes event stream unavailable; status polling continues.");
        });
      }
      let lastProgress = "";
      while (Date.now() < deadline) {
        const response = await this.request(`/v1/runs/${encodeURIComponent(runId)}`);
        if (!response.ok)
          return {
            status: "unknown",
            summary: `Hermes status query returned HTTP ${response.status}. Native work may still be active.`,
            nativeRef
          };
        const state = object(await response.json());
        if (state.run_id !== runId || typeof state.status !== "string")
          throw new Error("Mismatched Hermes run status");
        if (typeof state.session_id === "string" && state.session_id !== nativeRef.sessionId) {
          nativeRef.sessionId = state.session_id;
          await context?.onReference?.(nativeRef);
        }
        const progress = `${state.status}${typeof state.last_event === "string" ? `: ${state.last_event}` : ""}`;
        if (progress !== lastProgress) {
          await context?.onProgress?.(progress);
          lastProgress = progress;
        }
        const output = typeof state.output === "string" ? state.output.trim() : "";
        if (state.status === "completed")
          return {
            status: output ? "completed" : "failed",
            summary: output || "Hermes completed without a textual report.",
            nativeRef,
            limitations: [
              "Native file locations are reported in the summary; files are not automatically copied or accepted by CoworkOS."
            ]
          };
        if (["failed", "cancelled"].includes(state.status))
          return {
            status: "failed",
            summary: `Hermes run ${state.status}.${output ? `\n${output}` : ""}${typeof state.error === "string" ? `\n${state.error.replaceAll(this.options.apiKey, "[redacted]")}` : ""}`,
            nativeRef
          };
        if (["unknown", "interrupted"].includes(state.status))
          return {
            status: "unknown",
            summary: `Hermes reports ${state.status}; inspect its native runtime before submitting further work.${output ? `\n${output}` : ""}`,
            nativeRef
          };
        if (["waiting_for_approval", "waiting_for_clarification", "waiting_for_input"].includes(state.status))
          return {
            status: "unknown",
            summary: `Hermes requires native interaction (${state.status}). This adapter cannot answer it; Main must arrange a decision through the native runtime.`,
            nativeRef,
            limitations: [
              "The native run may remain waiting. No approval was granted and no response was fabricated."
            ]
          };
        if (!["started", "queued", "running", "stopping"].includes(state.status))
          return {
            status: "unknown",
            summary: "Hermes returned an unrecognized execution state; inspect the native run.",
            nativeRef
          };
        await delay(Math.min(this.pollMs, Math.max(1, deadline - Date.now())));
      }
      return {
        status: "unknown",
        summary:
          "CoworkOS stopped observing Hermes after the observation limit. The native run may still be active; it was not cancelled or resubmitted.",
        nativeRef
      };
    } catch {
      return {
        status: "unknown",
        summary:
          "Hermes communication or response validation failed. The native run may have been accepted; no automatic resubmission was made.",
        nativeRef
      };
    } finally {
      observationController.abort();
      await observation;
    }
  }

  private request(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${this.root}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        "Content-Type": "application/json",
        ...init.headers
      },
      redirect: "error",
      signal: AbortSignal.timeout(this.requestTimeoutMs)
    });
  }
}

function positive(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error("Hermes polling and observation limits must be positive integers");
  return value;
}

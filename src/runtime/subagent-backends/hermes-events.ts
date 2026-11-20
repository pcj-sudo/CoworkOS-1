import type { AgentObservation } from "../subagent-backend.js";

/** One subscription only: Hermes 0.19 queues events for a single consumer.
 * Stream loss degrades observation; it must never restart the business task. */
export async function observeHermesEvents(input: {
  url: string;
  apiKey: string;
  runId: string;
  signal: AbortSignal;
  emit: (entry: AgentObservation) => void | Promise<void>;
}): Promise<void> {
  const response = await fetch(`${input.url}/v1/runs/${encodeURIComponent(input.runId)}/events`, {
    headers: { Authorization: `Bearer ${input.apiKey}` },
    redirect: "error",
    signal: input.signal
  });
  if (
    !response.ok ||
    !response.body ||
    !response.headers.get("content-type")?.includes("text/event-stream")
  ) {
    await response.body?.cancel();
    throw new Error("Hermes event stream unavailable");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const pendingTools = new Map<string, string[]>();
  let pending = "",
    sequence = 0;
  const text = (value: unknown) =>
    typeof value === "string" ? value.replaceAll(input.apiKey, "[redacted]").slice(0, 6000) : "";
  async function consume(frame: string): Promise<void> {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) return;
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    if (!value || value.run_id !== input.runId) return;
    if (!["tool.started", "tool.completed"].includes(String(value.event))) return;
    const tool = text(value.tool);
    if (!tool) return;
    const ids = pendingTools.get(tool) ?? [];
    const started = value.event === "tool.started";
    const id = started ? `hermes-tool-${++sequence}` : (ids.shift() ?? `hermes-tool-${++sequence}`);
    if (started) ids.push(id);
    pendingTools.set(tool, ids);
    const timestamp = typeof value.timestamp === "number" ? value.timestamp * 1000 : NaN;
    const time =
      Number.isFinite(timestamp) && Math.abs(timestamp) < 8.64e15
        ? new Date(timestamp).toISOString()
        : undefined;
    await input.emit({
      id,
      kind: "tool",
      title: tool,
      text: started ? text(value.preview) : "",
      status: started ? "running" : value.error === true ? "failed" : "completed",
      time,
      result: started
        ? undefined
        : `${value.error === true ? "Hermes reports tool failure" : "Hermes reports tool completion"}${typeof value.duration === "number" ? ` (${value.duration}s)` : ""}. Native API does not provide the tool output.`
    });
  }
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(pending))) {
        const frame = pending.slice(0, boundary.index);
        pending = pending.slice(boundary.index + boundary[0].length);
        if (frame.length > 64 * 1024) throw new Error("Hermes event exceeded observation limit");
        await consume(frame);
      }
      if (pending.length > 64 * 1024) throw new Error("Hermes event exceeded observation limit");
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

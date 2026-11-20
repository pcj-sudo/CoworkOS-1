import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  AgentBackend,
  AgentObservation,
  AgentResult,
  AgentTask,
  NativeReference
} from "./subagent-backend.js";

/** Validate adapter output at the native boundary; never infer success from arbitrary text. */
export function validateAgentResult(value: unknown): AgentResult {
  if (!value || typeof value !== "object") throw new Error("Backend returned no result");
  const result = value as AgentResult;
  if (
    !["completed", "failed", "unknown"].includes(result.status) ||
    typeof result.summary !== "string" ||
    !result.summary.trim()
  )
    throw new Error("Backend must return status and a nonempty summary");
  if (
    result.limitations !== undefined &&
    (!Array.isArray(result.limitations) || result.limitations.some((item) => typeof item !== "string"))
  )
    throw new Error("Invalid backend limitations");
  if (result.nativeRef !== undefined) validateReference(result.nativeRef);
  if (
    result.artifacts !== undefined &&
    (!Array.isArray(result.artifacts) ||
      result.artifacts.some(
        (item) =>
          !item ||
          typeof item.name !== "string" ||
          !["local_file", "url", "reference"].includes(item.kind) ||
          typeof item.location !== "string" ||
          !item.location.trim()
      ))
  )
    throw new Error("Invalid backend artifacts");
  return result;
}

function validateReference(value: NativeReference): void {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.values(value).some((item) => typeof item !== "string")
  )
    throw new Error("Invalid native reference");
}

export async function saveBackendRecord(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

/** Native work is never replayed after losing its owner, even when it returned no reference. */
export async function runNativeBackend(input: {
  backend?: AgentBackend;
  task: AgentTask;
  interrupted: boolean;
  referencePath: string;
  resultPath: string;
  onProgress: (message: string) => Promise<void>;
  onObservation?: (entry: AgentObservation) => Promise<void>;
}): Promise<AgentResult> {
  if (input.interrupted) {
    try {
      const stored: unknown = JSON.parse(await readFile(input.resultPath, "utf8"));
      return validateAgentResult(stored);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let nativeRef: NativeReference | undefined;
    try {
      nativeRef = JSON.parse(await readFile(input.referencePath, "utf8")) as NativeReference;
      validateReference(nativeRef);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return {
      status: "unknown",
      summary:
        "CoworkOS lost the external execution owner. Inspect the native agent before deciding whether to submit new work; this task was not replayed.",
      nativeRef
    };
  }
  if (!input.backend) throw new Error("Configured backend is unavailable");
  return validateAgentResult(
    await input.backend.run(input.task, {
      onProgress: input.onProgress,
      onObservation: input.onObservation,
      onReference: async (reference) => {
        validateReference(reference);
        await saveBackendRecord(input.referencePath, reference);
      }
    })
  );
}

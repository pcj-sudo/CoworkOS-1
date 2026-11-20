/** Minimal native-agent boundary. Only id, name and run are required. */
export interface AgentTask {
  // REQUIRED. Coordinator supplies a unique delegation ID.
  callId: string;
  // REQUIRED. The objective and constraints in ordinary text.
  task: string;
  // OPTIONAL. Only the context explicitly provided by Main.
  context?: string;
  // OPTIONAL. Used only for tasks needing additional input material.
  inputs?: AgentInput[];
  // OPTIONAL. A host-authorized local directory, not an OS sandbox guarantee.
  workingDirectory?: string;
}

/** OPTIONAL input capability; a text-only backend need not support this. */
export interface AgentInput {
  name: string;
  kind: "text" | "file" | "reference";
  value: string; // Text, authorized local path, or a native reference.
}

/** OPTIONAL output; its location must be usable and its limitations disclosed. */
export interface AgentArtifact {
  name: string;
  kind: "local_file" | "url" | "reference";
  location: string;
}

/** OPTIONAL non-secret native task/session identifiers; format is adapter-owned. */
export type NativeReference = Record<string, string>;

/** Optional, bounded native observations; no full-trace or tool-result guarantee. */
export interface AgentObservation {
  id: string;
  kind: "tool" | "message" | "state";
  title: string;
  text: string;
  status: "running" | "completed" | "failed";
  time?: string;
  result?: string;
}

export interface AgentResult {
  // REQUIRED. completed = this delegation returned a usable report, not business acceptance.
  // failed = this delegation could not deliver; unknown = unable to establish its outcome.
  status: "completed" | "failed" | "unknown";
  // REQUIRED. Conclusion, failure reason or known facts; ordinary text is enough.
  summary: string;
  // OPTIONAL. A report may be partial; describe missing work here or in summary.
  limitations?: string[];
  artifacts?: AgentArtifact[];
  nativeRef?: NativeReference;
}

/** OPTIONAL callbacks supplied by Coordinator. A backend can ignore all of them.
 * The context argument is optional too: run(task) is a valid implementation.
 */
export interface AgentRunContext {
  onProgress?: (message: string) => void | Promise<void>;
  onObservation?: (entry: AgentObservation) => void | Promise<void>;
  // Persist a non-secret native ID early if available; does not promise recovery.
  onReference?: (reference: NativeReference) => void | Promise<void>;
  // Available only when Main can handle the interaction (RFC R-01/R-02).
  // Absent or rejected: do not bypass Main or grant permission automatically.
  askMain?: (question: string) => Promise<string>;
}

export interface AgentBackend {
  // REQUIRED registration metadata. A configured instance has a unique ID.
  id: string;
  name: string;
  // REQUIRED and the ONLY required method:
  // execute the objective with the full native agent; await this round's result;
  // return attributable status + nonempty summary, not just a task ID/accepted notice.
  // Report failure/uncertainty honestly (or throw for host handling).
  // Never resubmit an ambiguous business task automatically; controls stay optional.
  run(task: AgentTask, context?: AgentRunContext): Promise<AgentResult>;

  // OPTIONAL discovery/routing hints; not a comprehensive capability matrix.
  description?: string;
  // Simple labels such as code.edit or web.research. Missing != proven unsupported.
  tags?: string[];
  // OPTIONAL readiness check; no check() required for a working backend.
  check?(): Promise<{ ready: boolean; message?: string }>;
}

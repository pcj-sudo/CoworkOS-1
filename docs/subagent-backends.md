# Native subagent backends

The adapter contract is in [subagent-backend.ts](../src/runtime/subagent-backend.ts). Only `id`, `name`, and `run(task)` are required. An external backend executes its own full agent and native tools. It does not inherit Main's model credentials, tools, application grants, memory, or checkpoints.

```ts
const backend: AgentBackend = {
  id: "specialist",
  name: "Specialist",
  async run({ callId, task }) {
    // Submit to the native CLI, SDK or service and await its actual report.
    return { status: "completed", summary: "Conclusion and execution evidence" };
  }
};
const coordinator = new CoordinatorRuntime({ backends: [backend] });
```

`run` receives a unique `callId` and task text containing the objective, constraints and expected evidence. It must wait for this delegation's report; returning only an acceptance receipt or native task ID does not fulfill the contract. `completed` means the agent returned a usable report; Main still judges business acceptance. `failed` means it could not deliver; `unknown` means the outcome cannot be established. The summary must be nonempty. Optional references and artifact locations must be usable and contain no secrets.

`context`, `inputs`, and `workingDirectory` are optional contract fields for adapters that need them. The current Main tool passes task text only: Main must include relevant context in that text. CoworkOS does not impose a workspace on a native harness. The legacy dispatch result’s `workingDirectory` identifies CoworkOS’s local bookkeeping directory for this call, not the native agent’s execution directory. Native artifacts are reported as references; they are not copied, downloaded, or promoted to accepted Task artifacts automatically.

Optional `onProgress`, `onObservation` and `onReference` callbacks expose authorized observations. Adapters may ignore them. `onObservation` accepts compact tool/message/state entries with a stable local ID, title, bounded text and observation status; it does not require a full native transcript or tool output. Coordinator persists these in its event log and the member trace for the existing UI/API. Optional `check`, description and tags aid discovery. The interface also reserves an optional `askMain` callback, but the current execution host does not supply it: synchronous Main waiting and structured question fallback need further design. There is no required cancel, resume, messaging, file-transfer, or installation API.

## Scheduling and Main tools

Main calls `list_subagent_backends`, then `call_subagent({ backendId, task, mode })`. Omitting `backendId` preserves the internal Pi path, including delegated application capabilities and its existing recovery behavior. Both CLI and desktop use the same Pi tools and Coordinator. Registration belongs in host assembly; native implementations stay outside Coordinator.

Coordinator still owns call IDs, sync/async scheduling, queue leases and Main Inbox callbacks. Async results retain the existing callback delivery and wait/status behavior. External reports are persisted in the existing `result.json` location with their native schema; `backendResult` in synchronous results and async callback payloads preserves the report. `response` includes the same report for existing textual consumers. Native execution observations are recorded separately from Pi transcripts at the usual diagnostic trace path. Native runtimes retain their own full traces, memory and lifecycle.

External `completed` maps to existing orchestration success. `failed` and `unknown` map to orchestration failure; the native status stays explicit in `backendResult` and `response`. This preserves existing queue/UI status meanings without treating uncertainty as success. External failures have one attempt regardless of Pi retry settings. After a lost owner, recovery returns saved evidence or `unknown`; it never resubmits the business task. A still-running native task may need inspection in its original client. Reference persistence improves visibility and does not promise reconnection.

The minimal external path rejects CoworkOS resource/attachment delegation, follow-up messages, peer messages targeting it and cancellation. It does not pretend those operations were delivered. Native permissions are configured by the native client; CoworkOS's private-directory guidance is not an OS sandbox for external processes. Enabling a backend is an operator decision to use that configured native environment.

## Validation

[Backend regressions](../test/subagent-backend.test.js) cover run-only registration, execution without Main credentials, result/callback attribution, duplicate dispatch, failure/unknown, lost-owner recovery and unsupported controls. Existing actual Pi protocol, message, question and cancellation tests cover default-runtime compatibility. Native adapters require separate real-runtime testing; a protocol fixture alone does not establish a working native installation.

The first native adapter is [Hermes Agent](hermes-subagent.md), enabled explicitly in Pi host assembly with `COWORK_HERMES_URL` and `COWORK_HERMES_API_KEY`. These can come from the launch environment or the optional desktop-managed service. Hermes remains independently installed; host process management is separate from this backend contract.

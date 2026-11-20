import { escapeHtml as esc } from "./workbench/html.js";
import { ui } from "./ui/language.js";

export function agentBackend(agent = {}) {
  const main = agent.__main || agent.agentId === "main";
  const id = main ? "coworkos" : agent.backendId || "pi";
  const name = main ? "CoworkOS" : id === "hermes" ? "Hermes" : id === "pi" ? "Pi" : agent.backendName || id;
  return { id, name };
}

/** Local type marks, not third-party logo assets. Text always identifies the backend. */
export function agentBackendIcon(agent) {
  const { id } = agentBackend(agent);
  if (id === "coworkos") return '<img class="agent-backend-icon" src="/assets/atria-symbol.png" alt="" />';
  return `<span class="agent-backend-icon agent-type-mark" aria-hidden="true">${id === "hermes" ? "H" : id === "pi" ? "π" : "◇"}</span>`;
}

export function agentMemberLabel(agent, name, status) {
  const backend = agentBackend(agent);
  return `${agentBackendIcon(agent)}<span class="member-name">${esc(name)}</span>${backend.id === "coworkos" ? "" : `<span class="agent-backend-type">${esc(backend.name)}</span>`}<small>${esc(status)}</small>`;
}

export function agentObservationSummary(agent = {}) {
  if (!agent.backendId || agent.backendId === "pi") return "";
  const ref = agent.nativeRef || {};
  const status =
    { completed: ui("已完成"), failed: ui("失败"), unknown: ui("未知") }[agent.backendStatus] ||
    agent.backendStatus;
  const activity =
    !agent.backendStatus && agent.lastActivity && !agent.lastActivity.startsWith("activity @")
      ? agent.lastActivity
      : "";
  return `<div class="native-observation">${agent.lastTool ? `<p>${esc(ui("最近工具"))}：${esc(agent.lastTool)}</p>` : ""}${activity ? `<p>${esc(activity)}</p>` : ""}${ref.runId ? `<details data-native-detail="reference"><summary>${esc(ui("原生执行标识"))}</summary><code>${esc(ref.runId)}</code>${ref.sessionId ? `<br><code>${esc(ref.sessionId)}</code>` : ""}</details>` : ""}${status ? `<p>${esc(ui("原生结果"))}：${esc(status)}</p>` : ""}<details data-native-detail="scope"><summary>${esc(ui("观察范围"))}</summary><p>${esc(ui("原生事件观察：工具预览与状态；完整输出以原生客户端为准。"))}</p>${agent.backendLimitations?.length ? `<p>${esc(agent.backendLimitations.join("\n"))}</p>` : ""}</details></div>`;
}

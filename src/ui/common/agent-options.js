const AGENT_OPTIONS = [
  { value: "claude", label: "Claude" },
  { value: "codex", label: "Codex" },
  { value: "goose", label: "Goose" },
  { value: "opencode", label: "OpenCode" },
  { value: "gemini", label: "Gemini" },
  { value: "pi", label: "Pi" },
];

const DEFAULT_AGENT = "claude";

const normalizeAgentValue = (value) => {
  if (typeof value !== "string") return DEFAULT_AGENT;
  const normalized = value.trim().toLowerCase();
  return AGENT_OPTIONS.some((option) => option.value === normalized) ? normalized : DEFAULT_AGENT;
};

export function renderAgentOptions(selectedValue = DEFAULT_AGENT) {
  const normalized = normalizeAgentValue(selectedValue);
  return AGENT_OPTIONS.map((option) => {
    const selected = option.value === normalized ? ' selected' : '';
    return `<option value="${option.value}"${selected}>${option.label}</option>`;
  }).join("");
}

export function populateAgentSelect(select, selectedValue = DEFAULT_AGENT) {
  if (!select) return;
  const normalized = normalizeAgentValue(selectedValue);
  select.innerHTML = renderAgentOptions(normalized);
  select.value = normalized;
}

export function getAgentLabel(value) {
  const normalized = normalizeAgentValue(value);
  return AGENT_OPTIONS.find((option) => option.value === normalized)?.label ?? "Claude";
}

export { AGENT_OPTIONS, DEFAULT_AGENT, normalizeAgentValue };

export const PROVIDER_APPROVAL_FLAG = "session_provider_auto_approve";

export function providerApprovalControlState({ flags, isAdmin, transport, policy } = {}) {
  const flag = Array.isArray(flags) ? flags.find((item) => item.key === PROVIDER_APPROVAL_FLAG) : null;
  const enabled = flag?.effectiveState === "on" || flag?.state === "on" || (flag?.state === "on_admin" && isAdmin === true);
  const supported = ["claude-sdk", "codex-acp"].includes(transport);
  const optedIn = policy === "always";
  return {
    visible: enabled || optedIn,
    disabled: !supported || (!enabled && !optedIn),
    optedIn,
    description: !supported
      ? transport === "codex-sdk"
        ? "Codex SDK already runs without permission prompts. Interactive manual consent is not supported by this transport."
        : "Session-wide approval is not supported by this transport."
      : !enabled
        ? "Saved consent is suspended while the feature flag is off. You can turn it off here."
        : "Approve provider tools in this session. Optional questions return to agent judgment with choices recorded; required information and human authorization still block. Turning this off returns to manual consent.",
  };
}

export function createProviderApprovalControl(options) {
  const state = providerApprovalControlState(options);
  const field = document.createElement("label");
  field.className = "wm-dialog__field";
  field.hidden = !state.visible;
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = state.optedIn;
  input.disabled = state.disabled;
  input.dataset.testid = "session-provider-auto-approve";
  input.setAttribute("aria-label", "Always approve for this session");
  const title = document.createElement("span");
  title.textContent = "Always approve for this session";
  const description = document.createElement("span");
  description.textContent = state.description;
  field.append(input, title, description);
  return { field, input };
}

export function resolveLaunchApprovalTransport(agent, selection, flags = []) {
  const enabled = (key) => flags.some((flag) => flag.key === key && (flag.effectiveState === "on" || flag.state === "on"));
  if (agent === "claude") return enabled("claude-use-native-sdk") ? "claude-sdk" : "agentapi";
  if (agent === "codex") {
    if (selection) return selection;
    if (enabled("codex-use-acp")) return "codex-acp";
    return enabled("codex-use-native-sdk") ? "codex-sdk" : "agentapi";
  }
  return "unsupported";
}

export function createLaunchProviderApprovalController({ panel, getConfig, agentSelect, transportSelect }) {
  let control = null;
  return {
    sync() {
      if (!panel || typeof document === "undefined") return;
      const flags = getConfig?.()?.featureFlags;
      const transport = resolveLaunchApprovalTransport(agentSelect?.value, transportSelect?.value, flags);
      const previous = control;
      control = createProviderApprovalControl({ flags, transport, policy: previous?.input.checked ? "always" : "manual" });
      previous?.field.remove();
      panel.append(control.field);
    },
    reset() { if (control) control.input.checked = false; },
    getPolicy() { return control?.input.checked && !control.input.disabled ? "always" : undefined; },
  };
}

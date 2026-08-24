export function findTerminalControlAction(actions, id) {
  return actions.find((action) => action.id === id) ?? null;
}

export function resolveTerminalControlKeyAction(event, value, actions) {
  if (!event || value !== "") {
    return null;
  }

  if (event.key === "Escape") {
    return findTerminalControlAction(actions, "terminal-esc");
  }

  if (event.key === "Tab" && event.shiftKey) {
    return findTerminalControlAction(actions, "terminal-shift-tab");
  }

  if (event.key === "ArrowUp") {
    return findTerminalControlAction(actions, "terminal-up");
  }

  if (event.key === "ArrowDown") {
    return findTerminalControlAction(actions, "terminal-down");
  }

  if (event.key === "Enter" && !event.shiftKey) {
    return findTerminalControlAction(actions, "terminal-return");
  }

  return null;
}

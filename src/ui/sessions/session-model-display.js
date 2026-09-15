function readText(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function getSelectedSessionModel(session) {
  const selected = readText(session?.model);
  return selected && selected.toLowerCase() !== "default" ? selected : "default";
}

export function getRunningSessionModel(session) {
  return readText(session?.runningModel);
}

export function getSessionModelDisplay(session) {
  const running = getRunningSessionModel(session);
  if (running) {
    return {
      label: "Running model",
      value: running,
      title: `Running model: ${running}`,
      confirmed: true,
    };
  }
  const selected = getSelectedSessionModel(session);
  return {
    label: "Selected model",
    value: selected,
    title: `Selected model: ${selected}`,
    confirmed: false,
  };
}

export function getAgentStatusIndicatorPresentation(status, queueCount = 0) {
  const statusLabel = status === "running"
    ? "Running"
    : status === "stable"
      ? "Ready"
      : "Status unknown";

  return {
    ariaLabel: `Agent status: ${statusLabel.toLowerCase()}`,
    pillLabel: statusLabel,
  };
}

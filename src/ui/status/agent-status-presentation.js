export function getAgentStatusIndicatorPresentation(status, queueCount = 0) {
  const normalizedQueueCount = Number.isFinite(queueCount) && queueCount > 0
    ? Math.floor(queueCount)
    : 0;
  const statusLabel = status === "running"
    ? "Running"
    : status === "stable"
      ? "Ready"
      : "Status unknown";
  const queueLabel = normalizedQueueCount > 0
    ? `, ${normalizedQueueCount} queued`
    : "";

  return {
    ariaLabel: `Agent status: ${statusLabel.toLowerCase()}${queueLabel}`,
    pillLabel: normalizedQueueCount > 0
      ? `${statusLabel} · ${normalizedQueueCount} queued`
      : statusLabel,
  };
}

const DEFAULT_PERMISSION_ACTIONS = Object.freeze([
  { response: "once", label: "Allow once", testId: "permission-allow-once" },
  { response: "always", label: "Always allow", testId: "permission-allow-always" },
  { response: "reject", label: "Reject", testId: "permission-reject" },
]);

export function buildPermissionActions(permission) {
  if (!Array.isArray(permission?.options)) return DEFAULT_PERMISSION_ACTIONS;
  return permission.options
    .filter((option) => ["once", "always", "reject"].includes(option?.response))
    .map((option) => ({
      response: option.response,
      label: String(option.label || defaultPermissionLabel(option.response)),
      optionId: option.optionId,
      testId: option.response === "once"
        ? "permission-allow-once"
        : option.response === "always"
          ? "permission-allow-always"
          : "permission-reject",
    }));
}

function defaultPermissionLabel(response) {
  if (response === "once") return "Allow once";
  if (response === "always") return "Always allow";
  return "Reject";
}

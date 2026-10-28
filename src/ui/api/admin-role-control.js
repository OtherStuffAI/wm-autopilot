export function createAdminRoleControl({ user, label, busy, isAdmin, onChange }) {
  const control = document.createElement("label");
  control.className = "wm-admin-users__toggle";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  const assigned = Boolean(user.assignedAdmin ?? user.admin);
  checkbox.checked = assigned;
  checkbox.disabled = busy || !isAdmin || Boolean(user.bootstrapAdmin)
    || (assigned && user.canDemoteAdmin === false);
  checkbox.setAttribute("aria-label", `Is Admin for ${label}`);
  checkbox.dataset.testid = "admin-user-admin-toggle";
  checkbox.addEventListener("change", () => {
    if (!checkbox.disabled) onChange(user.npub, checkbox.checked);
  });
  const text = document.createElement("span");
  text.textContent = user.bootstrapAdmin ? "Is Admin (bootstrap)" : "Is Admin";
  control.append(checkbox, text);
  return control;
}

export function adminUserStatus(user) {
  const identity = user.bot ? (user.active === false ? "Agent (inactive)" : "Agent") : "Human";
  const access = user.approved || user.onboarded ? "approved" : "not approved";
  const admin = user.admin ? "active" : user.assignedAdmin ? "assigned, inactive" : "not assigned";
  return `${identity} • Normal access: ${access} • Admin: ${admin}`;
}

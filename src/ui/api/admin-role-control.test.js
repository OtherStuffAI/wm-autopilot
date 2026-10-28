import { afterEach, expect, test } from "bun:test";
import { adminUserStatus, createAdminRoleControl } from "./admin-role-control.js";

const originalDocument = globalThis.document;
afterEach(() => { globalThis.document = originalDocument; });
function render(user, isAdmin = true) {
  globalThis.document = { createElement: (tag) => ({ tag, children: [], dataset: {}, attributes: {}, listeners: {},
    append(...children) { this.children.push(...children); },
    setAttribute(key, value) { this.attributes[key] = value; },
    addEventListener(key, listener) { this.listeners[key] = listener; },
  }) };
  const changes = [];
  const control = createAdminRoleControl({ user, label: "Agent Delta", busy: false, isAdmin,
    onChange: (...args) => changes.push(args) });
  return { control, checkbox: control.children[0], changes };
}

test("stable bot Is Admin control is labelled and sends only its own identity", () => {
  const { control, checkbox, changes } = render({ npub: "npub1agent", bot: true, admin: false });
  expect(control.tag).toBe("label");
  expect(control.children[1].textContent).toBe("Is Admin");
  expect(checkbox.attributes["aria-label"]).toBe("Is Admin for Agent Delta");
  expect(checkbox.dataset.testid).toBe("admin-user-admin-toggle");
  expect(checkbox.disabled).toBe(false);
  checkbox.checked = true;
  checkbox.listeners.change();
  expect(changes).toEqual([["npub1agent", true]]);
});

test("bootstrap, last-admin and nonadmin controls cannot submit role changes", () => {
  for (const user of [{ admin: true, bootstrapAdmin: true }, { admin: true, canDemoteAdmin: false }]) {
    const { checkbox, changes } = render({ npub: "npub1admin", ...user });
    expect(checkbox.disabled).toBe(true);
    checkbox.listeners.change();
    expect(changes).toEqual([]);
  }
  const { checkbox, changes } = render({ npub: "npub1agent", admin: false }, false);
  expect(checkbox.disabled).toBe(true);
  checkbox.listeners.change();
  expect(changes).toEqual([]);
});

test("retained inactive admin assignment can be unchecked and status separates normal approval", () => {
  const user = { npub: "npub1agent", bot: true, active: false, admin: false, assignedAdmin: true, canDemoteAdmin: true };
  const { checkbox, changes } = render(user);
  expect(checkbox.checked).toBe(true);
  expect(checkbox.disabled).toBe(false);
  checkbox.checked = false; checkbox.listeners.change();
  expect(changes).toEqual([["npub1agent", false]]);
  expect(adminUserStatus(user)).toBe("Agent (inactive) • Normal access: not approved • Admin: assigned, inactive");
  expect(adminUserStatus({ ...user, active: true, admin: true })).toBe("Agent • Normal access: not approved • Admin: active");
});

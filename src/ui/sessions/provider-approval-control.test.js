import { expect, test } from "bun:test";
import { providerApprovalControlState, PROVIDER_APPROVAL_FLAG } from "./provider-approval-control.js";

test("session consent controls follow managed flag and explain suspended and unsupported state", () => {
  const options = { transport: "claude-sdk", policy: "manual", flags: [{ key: PROVIDER_APPROVAL_FLAG, state: "off" }] };
  expect(providerApprovalControlState(options).visible).toBe(false);
  const suspended = providerApprovalControlState({ ...options, policy: "always" });
  expect(suspended).toMatchObject({ visible: true, disabled: false, optedIn: true });
  expect(suspended.description).toContain("suspended");
  expect(providerApprovalControlState({ ...options, flags: [{ key: PROVIDER_APPROVAL_FLAG, state: "on" }] }))
    .toMatchObject({ visible: true, disabled: false, optedIn: false });
  expect(providerApprovalControlState({ ...options, transport: "codex-sdk", policy: "always" }).description)
    .toContain("Interactive manual consent is not supported");
  expect(providerApprovalControlState({ ...options, flags: [{ key: PROVIDER_APPROVAL_FLAG, state: "on_admin" }], isAdmin: false }).visible).toBe(false);
});

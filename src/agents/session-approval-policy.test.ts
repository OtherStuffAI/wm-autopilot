import { expect, test } from "bun:test";
import { sessionApprovalEnabled, SESSION_APPROVAL_POLICY_FLAG } from "./session-approval-policy";
import { normaliseSessionMetadata } from "../sessions/session-metadata";
import { resolveNativeResumeLaunch } from "../sessions/native-resume-launch";
import { MANAGED_FEATURE_FLAG_DEFAULTS } from "../server/managed-feature-flags";

test("managed policy defaults off and checks current flag, transport and session consent", () => {
  expect(MANAGED_FEATURE_FLAG_DEFAULTS.find((flag) => flag.key === SESSION_APPROVAL_POLICY_FLAG)?.state).toBe("off");
  const opted = normaliseSessionMetadata({ agentTransport: "claude-sdk", providerApprovalPolicy: "always" });
  expect(sessionApprovalEnabled(opted, false, "off")).toBe(false);
  expect(sessionApprovalEnabled(opted, false, "on")).toBe(true);
  expect(sessionApprovalEnabled(opted, false, "on_admin")).toBe(false);
  expect(sessionApprovalEnabled(opted, true, "on_admin")).toBe(true);
  expect(sessionApprovalEnabled({ ...opted, providerApprovalPolicy: "manual" }, true, "on")).toBe(false);
  for (const transport of ["agentapi", "codex-sdk", "goose-acp"] as const) {
    expect(sessionApprovalEnabled({ ...opted, agentTransport: transport }, true, "on")).toBe(false);
  }
  expect(sessionApprovalEnabled(normaliseSessionMetadata({ agentTransport: "claude-sdk" }), true, "on")).toBe(false);
});

test("JSON recovery and native resume retain consent, transport and billing without sharing mutable state", () => {
  for (const agentTransport of ["claude-sdk", "codex-acp"] as const) {
    const agent = agentTransport === "claude-sdk" ? "claude" : "codex";
    const metadata = normaliseSessionMetadata({ agentTransport, providerApprovalPolicy: "always", billingMode: "credits",
      chargeToNpub: "billing-owner", nativeAgentSession: { agent, sessionId: "native-id", workingDirectory: "/tmp",
        capturedAt: new Date().toISOString(), source: "adapter" } });
    const recovered = normaliseSessionMetadata(JSON.parse(JSON.stringify(metadata)));
    const launch = resolveNativeResumeLaunch({ id: "source", agent, name: "Test", npub: undefined,
      workingDirectory: "/tmp", metadata: recovered }, (value): value is "claude" | "codex" => ["claude", "codex"].includes(value));
    expect(launch.metadata).toMatchObject({ providerApprovalPolicy: "always", agentTransport, billingMode: "credits", chargeToNpub: "billing-owner" });
    launch.metadata.providerApprovalPolicy = "manual";
    expect(metadata.providerApprovalPolicy).toBe("always");
  }
});

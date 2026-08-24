/**
 * Identity panel renderers — summary, local, NIP-07, bunker, key teleport,
 * settings panel, and menu identity section.
 *
 * Depends on: state.identity, registerIdentityDom, bindIdentityFlows,
 * navigateToSettings, IDENTITY_EVENT_NAMES (via DI).
 */

import { applyAvatarImage } from "../utils/avatar.js";
import { renderWorkspaceDelegationPanel } from "./workspace-delegation-panel.js";
import { getIdentityDisplayName } from "./profile-display.js";

function copyTextWithFallback(text) {
  if (!text) {
    return Promise.resolve(false);
  }

  const fallbackCopy = () => {
    try {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "absolute";
      textarea.style.left = "-9999px";
      document.body.append(textarea);
      textarea.select();
      const copied = document.execCommand("copy");
      textarea.remove();
      return copied;
    } catch {
      return false;
    }
  };

  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text)
      .then(() => true)
      .catch(() => fallbackCopy());
  }

  return Promise.resolve(fallbackCopy());
}

export function initIdentityPanels(deps) {
  const {
    state,
    registerIdentityDom,
    bindIdentityFlows,
    navigateToSettings,
    IDENTITY_EVENT_NAMES,
  } = deps;

  let detachMenuIdentitySectionListener = null;

  // ── Summary ────────────────────────────────────────────────────

  const renderIdentitySummary = () => {
    const summary = document.createElement("div");
    summary.className = "wm-identity-summary";

    const aliasHeading = document.createElement("h2");
    aliasHeading.className = "wm-identity-alias";
    aliasHeading.dataset.role = "identity-alias";
    aliasHeading.textContent = "Not signed in";
    summary.append(aliasHeading);

    const details = document.createElement("div");
    details.className = "wm-identity-summary-details";
    details.dataset.role = "identity-details";

    const list = document.createElement("dl");
    list.className = "wm-identity-summary-list";

    const npubLabel = document.createElement("dt");
    npubLabel.textContent = "npub";
    const npubValue = document.createElement("dd");
    npubValue.className = "wm-identity-summary-item";
    const npubText = document.createElement("span");
    npubText.dataset.role = "identity-npub";
    npubText.textContent = "Not signed in";
    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.className = "wm-icon-button";
    copyButton.dataset.action = "copy-active-npub";
    copyButton.setAttribute("aria-label", "Copy npub");
    copyButton.disabled = true;
    copyButton.innerHTML = '<span class="wm-icon" aria-hidden="true">\u{1F4CB}</span>';
    const feedback = document.createElement("span");
    feedback.className = "wm-identity-copy-feedback";
    feedback.dataset.role = "identity-copy-feedback";

    npubValue.append(npubText, copyButton, feedback);
    list.append(npubLabel, npubValue);

    const portsLabel = document.createElement("dt");
    portsLabel.textContent = "Ports";
    const portsValue = document.createElement("dd");
    portsValue.className = "wm-identity-summary-item";
    portsValue.dataset.role = "identity-ports";
    portsValue.textContent = "-";
    list.append(portsLabel, portsValue);

    const methodLabel = document.createElement("dt");
    methodLabel.textContent = "Method";
    const methodValue = document.createElement("dd");
    methodValue.className = "wm-identity-summary-item";
    methodValue.dataset.role = "identity-method";
    methodValue.textContent = "-";
    list.append(methodLabel, methodValue);

    const expiryLabel = document.createElement("dt");
    expiryLabel.textContent = "Session";
    const expiryValue = document.createElement("dd");
    expiryValue.className = "wm-identity-summary-item";
    expiryValue.dataset.role = "identity-session-remaining";
    expiryValue.textContent = "-";
    list.append(expiryLabel, expiryValue);

    // ── Bot identity section ──────────────────────────────────────
    const botHeader = document.createElement("dt");
    botHeader.className = "wm-identity-summary-header";
    botHeader.textContent = "Wingman Identity";
    botHeader.dataset.role = "identity-bot-header";
    const botHeaderSpacer = document.createElement("dd");
    botHeaderSpacer.style.display = "none";
    list.append(botHeader, botHeaderSpacer);

    const botNpubLabel = document.createElement("dt");
    botNpubLabel.textContent = "Wingman npub";
    const botNpubValue = document.createElement("dd");
    botNpubValue.className = "wm-identity-summary-item";
    const botNpubText = document.createElement("span");
    botNpubText.dataset.role = "identity-bot-npub";
    botNpubText.textContent = "-";
    const botCopyButton = document.createElement("button");
    botCopyButton.type = "button";
    botCopyButton.className = "wm-icon-button";
    botCopyButton.dataset.action = "copy-bot-npub";
    botCopyButton.setAttribute("aria-label", "Copy bot npub");
    botCopyButton.disabled = true;
    botCopyButton.innerHTML = '<span class="wm-icon" aria-hidden="true">\u{1F4CB}</span>';
    const botCopyFeedback = document.createElement("span");
    botCopyFeedback.className = "wm-identity-copy-feedback";
    botCopyFeedback.dataset.role = "identity-bot-copy-feedback";
    botNpubValue.append(botNpubText, botCopyButton, botCopyFeedback);
    list.append(botNpubLabel, botNpubValue);

    const botNameLabel = document.createElement("dt");
    botNameLabel.textContent = "Wingman name";
    const botNameValue = document.createElement("dd");
    botNameValue.className = "wm-identity-summary-item";
    botNameValue.dataset.role = "identity-bot-name";
    botNameValue.textContent = "-";
    list.append(botNameLabel, botNameValue);

    const botPubkeyLabel = document.createElement("dt");
    botPubkeyLabel.textContent = "Wingman hexpub";
    const botPubkeyValue = document.createElement("dd");
    botPubkeyValue.className = "wm-identity-summary-item wm-identity-mono";
    botPubkeyValue.dataset.role = "identity-bot-pubkey";
    botPubkeyValue.textContent = "-";
    list.append(botPubkeyLabel, botPubkeyValue);

    const botStatusLabel = document.createElement("dt");
    botStatusLabel.textContent = "Key source";
    const botStatusValue = document.createElement("dd");
    botStatusValue.className = "wm-identity-summary-item";
    botStatusValue.dataset.role = "identity-bot-status";
    botStatusValue.textContent = "-";
    list.append(botStatusLabel, botStatusValue);

    // Identity actions row — sits below the status in a full-width cell
    const botExportLabel = document.createElement("dt");
    botExportLabel.textContent = "Actions";
    botExportLabel.dataset.role = "identity-bot-export-label";
    const botExportValue = document.createElement("dd");
    botExportValue.className = "wm-identity-summary-item";
    botExportValue.dataset.role = "identity-bot-export-row";
    const botActions = document.createElement("div");
    botActions.className = "wm-identity-button-row";
    const botPublishDelegateButton = document.createElement("button");
    botPublishDelegateButton.type = "button";
    botPublishDelegateButton.className = "wm-button secondary wm-button--small";
    botPublishDelegateButton.dataset.action = "publish-bot-delegate-kind";
    botPublishDelegateButton.textContent = "Publish delegate kind";
    botPublishDelegateButton.disabled = true;
    const botForceSetupButton = document.createElement("button");
    botForceSetupButton.type = "button";
    botForceSetupButton.className = "wm-button secondary wm-button--small";
    botForceSetupButton.dataset.action = "force-bot-setup";
    botForceSetupButton.textContent = "Force Legacy Setup";
    botForceSetupButton.disabled = true;
    const botPublishDelegateFeedback = document.createElement("span");
    botPublishDelegateFeedback.className = "wm-identity-copy-feedback";
    botPublishDelegateFeedback.dataset.role = "identity-bot-delegate-publish-feedback";
    botActions.append(botPublishDelegateButton, botForceSetupButton);
    botExportValue.append(botActions, botPublishDelegateFeedback);
    list.append(botExportLabel, botExportValue);

    details.append(list);

    const actions = document.createElement("div");
    actions.className = "wm-identity-summary-actions";

    const logoutButton = document.createElement("button");
    logoutButton.type = "button";
    logoutButton.className = "wm-button danger";
    logoutButton.dataset.action = "identity-logout";
    logoutButton.textContent = "Logout";
    actions.append(logoutButton);

    details.append(list, actions);
    summary.append(details);
    return summary;
  };

  const renderAnonPanel = () => {
    const section = document.createElement("section");
    section.className = "wm-identity-option wm-identity-option--primary";
    section.dataset.role = "identity-register";

    const title = document.createElement("h3");
    title.className = "wm-identity-option__title";
    title.textContent = "Anon";
    section.append(title);

    const description = document.createElement("p");
    description.className = "wm-identity-panel-description";
    description.dataset.role = "identity-register-help";
    description.textContent = "Create a fresh Nostr identity and sign in immediately.";
    section.append(description);

    const registerButton = document.createElement("button");
    registerButton.type = "button";
    registerButton.className = "wm-button";
    registerButton.dataset.action = "identity-register";
    registerButton.textContent = "Continue as Anon";
    section.append(registerButton);

    return section;
  };

  // ── Local (BYO Nsec) panel ─────────────────────────────────────

  const renderLocalIdentityPanel = () => {
    const panel = document.createElement("details");
    panel.className = "wm-identity-collapsible";
    panel.dataset.identityPanel = "local";
    panel.open = false;

    const summary = document.createElement("summary");
    summary.textContent = "BYO Nsec";
    panel.append(summary);

    const body = document.createElement("div");
    body.className = "wm-identity-panel";

    const description = document.createElement("p");
    description.className = "wm-identity-panel-description";
    description.textContent = "Bring your own nsec or generate a keypair stored on this device.";
    body.append(description);

    const actions = document.createElement("div");
    actions.className = "wm-identity-button-row";

    const generateBtn = document.createElement("button");
    generateBtn.type = "button";
    generateBtn.className = "wm-button";
    generateBtn.dataset.action = "generate-keys";
    generateBtn.textContent = "Generate Keys";
    actions.append(generateBtn);

    body.append(actions);

    const outputs = document.createElement("div");
    outputs.className = "wm-identity-output";

    const npubLine = document.createElement("div");
    npubLine.className = "wm-identity-output-line";
    const npubKeyLabel = document.createElement("span");
    npubKeyLabel.className = "wm-identity-output-label";
    npubKeyLabel.textContent = "npub";
    const npubValue = document.createElement("span");
    npubValue.className = "wm-identity-output-value";
    npubValue.dataset.role = "npub";
    npubLine.append(npubKeyLabel, npubValue);
    outputs.append(npubLine);

    body.append(outputs);

    const importSection = document.createElement("div");
    importSection.className = "wm-identity-import-section";
    const importHeading = document.createElement("h4");
    importHeading.textContent = "Import nsec";
    importSection.append(importHeading);

    const importForm = document.createElement("form");
    importForm.className = "wm-identity-import";
    importForm.dataset.form = "import-nsec";

    const importInput = document.createElement("input");
    importInput.id = "identity-import-nsec";
    importInput.name = "nsec";
    importInput.type = "password";
    importInput.autocomplete = "off";
    importInput.className = "wm-identity-input-flat wm-identity-import-nsec-input";
    importInput.placeholder = "nsec1...";
    importInput.spellcheck = false;
    importInput.setAttribute("autocapitalize", "off");
    importInput.setAttribute("aria-label", "Import nsec private key");

    const importSubmit = document.createElement("button");
    importSubmit.type = "submit";
    importSubmit.className = "wm-button secondary";
    importSubmit.textContent = "Sign In";

    importForm.append(importInput, importSubmit);
    importSection.append(importForm);
    body.append(importSection);

    panel.append(body);

    return panel;
  };

  // ── NIP-07 (browser extension) panel ───────────────────────────

  const renderNip07Panel = () => {
    const panel = document.createElement("section");
    panel.className = "wm-identity-option wm-identity-option--primary";
    panel.dataset.identityPanel = "nip07";

    const heading = document.createElement("h3");
    heading.className = "wm-identity-option__title";
    heading.textContent = "Browser Extension";
    panel.append(heading);

    const description = document.createElement("p");
    description.className = "wm-identity-panel-description";
    description.textContent = "Connect using a Nostr extension such as Alby, nos2x, or Flamingo.";
    panel.append(description);

    const loginButton = document.createElement("button");
    loginButton.type = "button";
    loginButton.className = "wm-button";
    loginButton.dataset.action = "nip07-login";
    loginButton.textContent = "Connect Extension";
    panel.append(loginButton);

    const status = document.createElement("p");
    status.className = "wm-identity-status-line";
    status.dataset.role = "nip07-status";
    status.setAttribute("aria-live", "polite");
    status.hidden = true;
    panel.append(status);

    return panel;
  };

  // ── Nostr Connect section ──────────────────────────────────────

  function renderNostrConnectSection() {
    const section = document.createElement("div");
    section.className = "wm-identity-subpanel";
    section.dataset.section = "nostrconnect";

    const title = document.createElement("h4");
    title.className = "wm-identity-subpanel__title";
    title.textContent = "Start from Wingman (nostrconnect://)";
    section.append(title);

    const description = document.createElement("p");
    description.className = "wm-identity-panel-description";
    description.textContent =
      "Generate a nostrconnect:// link for your bunker. Copy or scan to complete login from your signer.";
    section.append(description);

    const relays = document.createElement("p");
    relays.className = "wm-identity-helper";
    relays.dataset.role = "nostrconnect-relays";
    section.append(relays);

    const urlRow = document.createElement("div");
    urlRow.className = "wm-identity-row";

    const urlInput = document.createElement("input");
    urlInput.type = "text";
    urlInput.readOnly = true;
    urlInput.className = "wm-identity-input-flat";
    urlInput.placeholder = "nostrconnect://\u2026";
    urlInput.dataset.role = "nostrconnect-url";
    urlRow.append(urlInput);

    const actions = document.createElement("div");
    actions.className = "wm-identity-inline-actions";

    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.className = "wm-button wm-button--ghost";
    copyButton.dataset.action = "copy-nostrconnect-url";
    copyButton.textContent = "Copy link";
    actions.append(copyButton);

    const qrButton = document.createElement("button");
    qrButton.type = "button";
    qrButton.className = "wm-button wm-button--ghost";
    qrButton.dataset.action = "show-nostrconnect-qr";
    qrButton.textContent = "Show QR";
    actions.append(qrButton);

    urlRow.append(actions);
    section.append(urlRow);

    const status = document.createElement("p");
    status.className = "wm-identity-status-line";
    status.dataset.role = "nostrconnect-status";
    status.hidden = true;
    section.append(status);

    const qrContainer = document.createElement("div");
    qrContainer.className = "wm-identity-qr";
    qrContainer.dataset.role = "nostrconnect-qr";
    qrContainer.hidden = true;

    const qrCanvas = document.createElement("canvas");
    qrCanvas.width = 240;
    qrCanvas.height = 240;
    qrCanvas.dataset.role = "nostrconnect-qr-canvas";
    qrContainer.append(qrCanvas);

    const qrLabel = document.createElement("p");
    qrLabel.className = "wm-identity-helper";
    qrLabel.textContent = "Scan with your bunker to approve the request.";
    qrContainer.append(qrLabel);

    section.append(qrContainer);

    return section;
  }

  // ── Bunker (remote signer) panel ───────────────────────────────

  const renderBunkerPanel = () => {
    const panel = document.createElement("details");
    panel.className = "wm-identity-collapsible";
    panel.dataset.identityPanel = "bunker";
    panel.open = false;

    const heading = document.createElement("summary");
    heading.textContent = "Remote Signer";
    panel.append(heading);

    const body = document.createElement("div");
    body.className = "wm-identity-panel";

    const description = document.createElement("p");
    description.className = "wm-identity-panel-description";
    description.textContent = "Connect a remote signer with a bunker:// URI or share a nostrconnect:// request.";
    body.append(description);

    body.append(renderNostrConnectSection());

    const form = document.createElement("form");
    form.className = "wm-identity-bunker-form";
    form.dataset.form = "bunker-auth";

    const textarea = document.createElement("textarea");
    textarea.name = "bunkerUri";
    textarea.rows = 3;
    textarea.className = "wm-identity-input-flat";
    textarea.placeholder = "bunker://...";
    form.append(textarea);

    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "wm-button";
    submit.textContent = "Connect Bunker";
    form.append(submit);

    body.append(form);

    const status = document.createElement("p");
    status.className = "wm-identity-status-line";
    status.dataset.role = "bunker-status";
    status.setAttribute("aria-live", "polite");
    status.hidden = true;
    body.append(status);

    panel.append(body);
    return panel;
  };

  // ── Key Teleport setup modal ───────────────────────────────────

  function showKeyTeleportSetupModal(appNpub) {
    const dialog = document.createElement("dialog");
    dialog.className = "wm-keyteleport-setup-dialog";

    const content = document.createElement("div");
    content.className = "wm-keyteleport-setup-dialog__content";

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "wm-keyteleport-setup-dialog__close";
    closeBtn.innerHTML = "\u00d7";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.addEventListener("click", () => {
      dialog.close();
      dialog.remove();
    });
    content.append(closeBtn);

    const title = document.createElement("h2");
    title.className = "wm-keyteleport-setup-dialog__title";
    title.textContent = "Key Teleport Setup";
    content.append(title);

    const subtitle = document.createElement("p");
    subtitle.className = "wm-keyteleport-setup-dialog__subtitle";
    subtitle.textContent = "Registration blob copied to clipboard!";
    content.append(subtitle);

    const instructions = document.createElement("p");
    instructions.className = "wm-keyteleport-setup-dialog__instructions";
    instructions.textContent = "Paste this into your key manager (e.g., Welcome) to register this app.";
    content.append(instructions);

    const identityBox = document.createElement("div");
    identityBox.className = "wm-keyteleport-setup-dialog__identity";

    const identityLabel = document.createElement("span");
    identityLabel.className = "wm-keyteleport-setup-dialog__identity-label";
    identityLabel.textContent = "This app's identity:";
    identityBox.append(identityLabel);

    const identityValue = document.createElement("span");
    identityValue.className = "wm-keyteleport-setup-dialog__identity-value";
    identityValue.textContent = appNpub;
    identityBox.append(identityValue);

    content.append(identityBox);

    const doneBtn = document.createElement("button");
    doneBtn.type = "button";
    doneBtn.className = "wm-button";
    doneBtn.textContent = "Done";
    doneBtn.addEventListener("click", () => {
      dialog.close();
      dialog.remove();
    });
    content.append(doneBtn);

    dialog.append(content);
    document.body.append(dialog);
    dialog.showModal();

    dialog.addEventListener("click", (e) => {
      if (e.target === dialog) {
        dialog.close();
        dialog.remove();
      }
    });
  }

  // ── Key Teleport panel ─────────────────────────────────────────

  const renderKeyTeleportPanel = () => {
    const section = document.createElement("section");
    section.className = "wm-identity-option wm-identity-option--primary wm-identity-keyteleport";
    section.dataset.section = "keyteleport";

    const title = document.createElement("h3");
    title.className = "wm-identity-option__title";
    title.textContent = "Key Teleport";
    section.append(title);

    const description = document.createElement("p");
    description.className = "wm-identity-panel-description";
    description.textContent = "Use your key manager (e.g., Welcome) to securely transfer your Nostr identity.";
    section.append(description);

    const setupDetails = document.createElement("details");
    setupDetails.className = "wm-identity-keyteleport__setup";

    const setupSummary = document.createElement("summary");
    setupSummary.textContent = "First time? Set up Key Teleport";
    setupDetails.append(setupSummary);

    const setupBody = document.createElement("div");
    setupBody.className = "wm-identity-keyteleport__setup-body";

    const setupInstructions = document.createElement("ol");
    setupInstructions.className = "wm-identity-keyteleport__instructions";
    setupInstructions.innerHTML = `
    <li>Copy the registration code below</li>
    <li>Open your key manager and go to Key Teleport settings</li>
    <li>Paste the code to register Wingman</li>
    <li>Once registered, you can teleport your identity anytime</li>
  `;
    setupBody.append(setupInstructions);

    const copyRow = document.createElement("div");
    copyRow.className = "wm-identity-button-row";

    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.className = "wm-button";
    copyButton.dataset.action = "keyteleport-copy-registration";
    copyButton.textContent = "Copy Registration Code";
    copyRow.append(copyButton);

    setupBody.append(copyRow);
    setupDetails.append(setupBody);
    section.append(setupDetails);

    const helper = document.createElement("p");
    helper.className = "wm-identity-helper";
    helper.dataset.role = "keyteleport-helper";
    helper.innerHTML = 'Don\'t have a key manager? <a href="https://welcome.nostr.com" target="_blank" rel="noopener">Try Welcome</a>';
    section.append(helper);

    fetch("/api/auth/keyteleport/config")
      .then((res) => res.json())
      .then((config) => {
        if (!config.enabled) {
          section.hidden = true;
          return;
        }

        copyButton.addEventListener("click", async () => {
          try {
            copyButton.disabled = true;
            copyButton.textContent = "Generating...";

            const regRes = await fetch("/api/auth/keyteleport/registration");
            const regData = await regRes.json();

            if (!regRes.ok || !regData.blob) {
              throw new Error(regData.error ?? "Failed to generate registration code");
            }

            const copied = await copyTextWithFallback(regData.blob);
            if (!copied) {
              throw new Error("Generated registration code, but browser clipboard access failed");
            }

            showKeyTeleportSetupModal(regData.appNpub);

            copyButton.textContent = "Copy Registration Code";
          } catch (err) {
            alert(err.message ?? "Failed to copy registration code");
            copyButton.textContent = "Copy Registration Code";
          } finally {
            copyButton.disabled = false;
          }
        });
      })
      .catch(() => {
        section.hidden = true;
      });

    return section;
  };

  // ── Main identity panel (settings / dialog) ───────────────────

  const renderIdentityPanel = (options = {}) => {
    const variant = options.variant ?? "settings";
    const card = document.createElement(variant === "settings" ? "div" : "section");
    card.className = variant === "settings" ? "wm-settings-identity" : "wm-card";
    if (variant === "settings") {
      card.id = "identity-panel";
      card.dataset.testid = "settings-profile-composition";
    } else if (variant === "dialog") {
      card.classList.add("wm-identity-dialog-card");
    } else {
      card.classList.add("wm-identity-panel-card");
    }

    const header = document.createElement("div");
    header.className = "wm-home-section-header";
    const titleEl = document.createElement("h2");
    titleEl.textContent = "Identity";
    header.append(titleEl);
    const summary = renderIdentitySummary();
    const delegationPanel = renderWorkspaceDelegationPanel();

    const primaryOptions = document.createElement("div");
    primaryOptions.className = "wm-identity-primary";
    primaryOptions.append(renderAnonPanel(), renderNip07Panel(), renderKeyTeleportPanel());

    const advanced = document.createElement("details");
    advanced.className = "wm-identity-advanced";
    advanced.open = false;
    const advancedSummary = document.createElement("summary");
    advancedSummary.className = "wm-identity-advanced-summary";
    advancedSummary.textContent = "Advanced options";
    advanced.append(advancedSummary);

    const advancedBody = document.createElement("div");
    advancedBody.className = "wm-identity-advanced-body";
    const divider = document.createElement("hr");
    divider.className = "wm-identity-divider";
    divider.setAttribute("aria-hidden", "true");
    advancedBody.append(divider);

    const panels = document.createElement("div");
    panels.className = "wm-identity-panels";
    panels.append(renderLocalIdentityPanel(), renderBunkerPanel());
    advancedBody.append(panels);

    advanced.append(advancedBody);
    if (variant === "settings") {
      const summaryCard = document.createElement("section");
      summaryCard.className = "wm-card wm-settings-identity__summary-card";
      summaryCard.dataset.testid = "settings-profile-identity-summary";
      summaryCard.append(header, summary);

      const upperGrid = document.createElement("div");
      upperGrid.className = "wm-settings-grid wm-settings-grid--profile-upper";
      upperGrid.dataset.testid = "settings-grid-profile-upper";
      upperGrid.append(summaryCard);
      if (options.summaryAside) upperGrid.append(options.summaryAside);

      const delegationCard = document.createElement("section");
      delegationCard.className = "wm-card wm-settings-identity__delegations-card";
      delegationCard.dataset.testid = "settings-profile-workspace-delegations";
      delegationCard.append(delegationPanel);

      const signInCard = document.createElement("section");
      signInCard.className = "wm-card wm-settings-identity__signin-card";
      signInCard.dataset.testid = "settings-profile-sign-in-methods";
      const signInHeading = document.createElement("h2");
      signInHeading.textContent = "Sign-in methods";
      signInCard.append(signInHeading, primaryOptions);

      advanced.classList.add("wm-card", "wm-settings-identity__advanced-card");
      advanced.dataset.testid = "settings-profile-advanced-options";
      advancedSummary.textContent = "Advanced identity options";

      const lowerGrid = document.createElement("div");
      lowerGrid.className = "wm-settings-grid wm-settings-grid--profile-lower";
      lowerGrid.dataset.testid = "settings-grid-profile-lower";
      lowerGrid.append(signInCard, advanced);

      card.append(upperGrid, delegationCard, lowerGrid);
    } else {
      card.append(header, summary, delegationPanel, primaryOptions, advanced);
    }

    registerIdentityDom(card);
    bindIdentityFlows(card);

    return card;
  };

  // ── Menu identity section ──────────────────────────────────────

  const renderMenuIdentitySection = () => {
    const menuIdentityContainer = document.getElementById("menu-identity");
    if (!menuIdentityContainer) return;
    detachMenuIdentitySectionListener?.();
    menuIdentityContainer.innerHTML = "";

    const card = document.createElement("section");
    card.className = "wm-menu-identity-card";

    const info = document.createElement("div");
    info.className = "wm-menu-identity-info";
    const avatar = document.createElement("div");
    avatar.className = "wm-menu-identity-avatar";

    const label = document.createElement("span");
    label.className = "wm-menu-identity-label";
    label.textContent = "Identity";

    const alias = document.createElement("span");
    alias.className = "wm-menu-identity-alias";

    info.append(label, alias);

    const manageButton = document.createElement("button");
    manageButton.type = "button";
    manageButton.className = "wm-link-button wm-menu-identity-manage";
    manageButton.textContent = "Settings";
    manageButton.addEventListener("click", () => {
      navigateToSettings();
    });

    card.append(avatar, info, manageButton);
    menuIdentityContainer.append(card);

    const updateSection = () => {
      const { npub, profileName, picture } = state.identity;
      if (npub) {
        const truncated = npub.length > 20 ? `${npub.slice(0, 10)}\u2026${npub.slice(-4)}` : npub;
        const displayName = getIdentityDisplayName(state.identity);
        alias.textContent = displayName;
        alias.title = profileName ? npub : truncated;
        manageButton.hidden = false;
        applyAvatarImage(avatar, picture, displayName);
      } else {
        alias.textContent = "Not signed in";
        alias.removeAttribute("title");
        manageButton.hidden = true;
        applyAvatarImage(avatar, null, "?");
      }
    };

    const identityEventHandler = () => {
      updateSection();
    };
    const trackedEvents = ["wingman:identity-ui-state", ...IDENTITY_EVENT_NAMES];
    trackedEvents.forEach((eventName) => {
      window.addEventListener(eventName, identityEventHandler);
    });

    detachMenuIdentitySectionListener = () => {
      trackedEvents.forEach((eventName) => {
        window.removeEventListener(eventName, identityEventHandler);
      });
      detachMenuIdentitySectionListener = null;
    };

    updateSection();
  };

  return {
    renderIdentityPanel,
    renderIdentitySummary,
    renderMenuIdentitySection,
  };
}

import {
  connectTerminalClient,
  disconnectTerminalClient,
  fetchTerminalStatus,
} from "../terminal/client.js";

export function initTerminalView(deps) {
  const { state } = deps;

  function setStatus(root, message, stateName = "info") {
    const status = root.querySelector("[data-terminal-status]");
    if (!status) return;
    status.textContent = message;
    status.dataset.state = stateName;
  }

  function renderAccessMessage(title, message) {
    const wrapper = document.createElement("section");
    wrapper.className = "wm-terminal-page";
    wrapper.dataset.testid = "terminal-access-message";
    const card = document.createElement("div");
    card.className = "wm-terminal-access";
    const heading = document.createElement("h2");
    heading.textContent = title;
    const body = document.createElement("p");
    body.textContent = message;
    card.append(heading, body);
    wrapper.append(card);
    return wrapper;
  }

  function renderTerminal() {
    if (!state.identity.authenticated) {
      return renderAccessMessage("Sign In Required", "Sign in as the Autopilot admin to open the web terminal.");
    }
    if (!state.identity.isAdmin) {
      return renderAccessMessage("Admin Access Required", "The web terminal is restricted to the configured Autopilot admin.");
    }
    if (state.config?.terminalConfigured !== true) {
      return renderAccessMessage("Terminal Disabled", "Set a terminal PIN in System settings before opening the web terminal.");
    }

    const wrapper = document.createElement("section");
    wrapper.className = "wm-terminal-page";
    wrapper.setAttribute("aria-labelledby", "terminal-title");
    wrapper.dataset.testid = "terminal-page";

    const header = document.createElement("header");
    header.className = "wm-terminal-header";
    const titleGroup = document.createElement("div");
    const title = document.createElement("h2");
    title.id = "terminal-title";
    title.textContent = "Terminal";
    const subtitle = document.createElement("p");
    subtitle.textContent = "Shell for this Autopilot instance.";
    titleGroup.append(title, subtitle);

    const status = document.createElement("div");
    status.className = "wm-terminal-status";
    status.setAttribute("aria-live", "polite");
    status.dataset.terminalStatus = "true";
    status.dataset.state = "loading";
    status.textContent = "Checking terminal...";
    header.append(titleGroup, status);

    const authForm = document.createElement("form");
    authForm.className = "wm-terminal-auth";
    authForm.dataset.testid = "terminal-pin-form";
    const pinLabel = document.createElement("label");
    pinLabel.htmlFor = "terminal-pin";
    pinLabel.textContent = "PIN";
    const pinInput = document.createElement("input");
    pinInput.id = "terminal-pin";
    pinInput.name = "pin";
    pinInput.type = "password";
    pinInput.inputMode = "numeric";
    pinInput.autocomplete = "one-time-code";
    pinInput.maxLength = 5;
    pinInput.pattern = "\\d{5}";
    pinInput.placeholder = "*****";
    pinInput.setAttribute("aria-label", "Terminal PIN");
    pinInput.dataset.testid = "terminal-pin-input";
    const connectButton = document.createElement("button");
    connectButton.type = "submit";
    connectButton.className = "wm-button";
    connectButton.textContent = "Connect";
    connectButton.dataset.testid = "terminal-connect-button";
    authForm.append(pinLabel, pinInput, connectButton);

    const terminalSurface = document.createElement("div");
    terminalSurface.className = "wm-terminal-surface";
    terminalSurface.dataset.testid = "terminal-surface";
    terminalSurface.setAttribute("role", "application");
    terminalSurface.setAttribute("aria-label", "Interactive terminal session");

    const disconnectButton = document.createElement("button");
    disconnectButton.type = "button";
    disconnectButton.className = "wm-button secondary";
    disconnectButton.textContent = "Disconnect";
    disconnectButton.dataset.testid = "terminal-disconnect-button";
    disconnectButton.addEventListener("click", () => {
      disconnectTerminalClient();
      setStatus(wrapper, "Disconnected");
      connectButton.disabled = false;
      terminalSurface.replaceChildren();
      pinInput.focus();
    });

    authForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const pin = pinInput.value.trim();
      if (!/^\d{5}$/.test(pin)) {
        setStatus(wrapper, "Enter a 5 digit PIN", "error");
        pinInput.focus();
        return;
      }
      connectButton.disabled = true;
      try {
        await connectTerminalClient({
          pin,
          container: terminalSurface,
          onStatus: (message) => setStatus(wrapper, message),
        });
      } catch (error) {
        setStatus(wrapper, error instanceof Error ? error.message : "Terminal connection failed", "error");
        connectButton.disabled = false;
        pinInput.focus();
      }
    });

    fetchTerminalStatus()
      .then((terminalStatus) => {
        if (terminalStatus.available) {
          setStatus(wrapper, `Ready: ${terminalStatus.shell} in ${terminalStatus.cwd}`, "ready");
          return;
        }
        connectButton.disabled = true;
        setStatus(wrapper, terminalStatus.error || "Terminal unavailable", "error");
      })
      .catch((error) => {
        connectButton.disabled = true;
        setStatus(wrapper, error instanceof Error ? error.message : "Terminal unavailable", "error");
      });

    const controls = document.createElement("div");
    controls.className = "wm-terminal-controls";
    controls.append(authForm, disconnectButton);
    wrapper.append(header, controls, terminalSurface);
    return wrapper;
  }

  return {
    renderTerminal,
    disconnectTerminal: disconnectTerminalClient,
  };
}

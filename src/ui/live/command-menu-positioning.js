const VIEWPORT_PADDING_PX = 8;
const SUBMENU_GAP_PX = 6;

function getSubmenuPanels(commandMenu) {
  return Array.from(commandMenu.querySelectorAll(".wm-command-submenu-panel"))
    .filter((panel) => panel instanceof HTMLElement);
}

function resetSubmenuPanelPosition(panel) {
  panel.style.left = "";
  panel.style.right = "";
  panel.style.top = "";
  panel.style.bottom = "";
  panel.style.maxHeight = "";
  panel.style.overflowY = "";
}

function resetAllSubmenuPanels(commandMenu) {
  const panels = getSubmenuPanels(commandMenu);
  panels.forEach((panel) => resetSubmenuPanelPosition(panel));
}

function positionSubmenuPanel(submenu) {
  if (!(submenu instanceof HTMLElement)) return;
  const panel = submenu.querySelector(".wm-command-submenu-panel");
  if (!(panel instanceof HTMLElement)) return;

  panel.style.bottom = "auto";
  panel.style.top = "0px";
  panel.style.right = "auto";
  panel.style.left = `calc(100% + ${SUBMENU_GAP_PX}px)`;

  const maxHeight = Math.max(160, window.innerHeight - (VIEWPORT_PADDING_PX * 2));
  panel.style.maxHeight = `${Math.round(maxHeight)}px`;
  panel.style.overflowY = "auto";

  let rect = panel.getBoundingClientRect();
  const spaceOnRight = window.innerWidth - submenu.getBoundingClientRect().right - VIEWPORT_PADDING_PX;
  const spaceOnLeft = submenu.getBoundingClientRect().left - VIEWPORT_PADDING_PX;
  if (rect.width > spaceOnRight && spaceOnLeft > spaceOnRight) {
    panel.style.left = "auto";
    panel.style.right = `calc(100% + ${SUBMENU_GAP_PX}px)`;
    rect = panel.getBoundingClientRect();
  }

  let topOffset = 0;
  if (rect.bottom > window.innerHeight - VIEWPORT_PADDING_PX) {
    topOffset -= rect.bottom - (window.innerHeight - VIEWPORT_PADDING_PX);
  }
  if (rect.top + topOffset < VIEWPORT_PADDING_PX) {
    topOffset += VIEWPORT_PADDING_PX - (rect.top + topOffset);
  }
  panel.style.top = `${Math.round(topOffset)}px`;
}

function positionVisibleSubmenus(commandMenu) {
  const submenus = Array.from(commandMenu.querySelectorAll(".wm-command-submenu"))
    .filter((node) => node instanceof HTMLElement);
  submenus.forEach((submenu) => {
    const panel = submenu.querySelector(".wm-command-submenu-panel");
    if (!(panel instanceof HTMLElement)) return;
    if (window.getComputedStyle(panel).display === "none") return;
    positionSubmenuPanel(submenu);
  });
}

function attachSubmenuPositioning(commandMenu) {
  const handleSubmenuActivate = (event) => {
    if (!(event.target instanceof Element)) return;
    const submenu = event.target.closest(".wm-command-submenu");
    if (!(submenu instanceof HTMLElement) || !commandMenu.contains(submenu)) return;
    positionSubmenuPanel(submenu);
  };

  const handleViewportChange = () => {
    positionVisibleSubmenus(commandMenu);
  };

  commandMenu.addEventListener("mouseover", handleSubmenuActivate);
  commandMenu.addEventListener("focusin", handleSubmenuActivate);
  window.addEventListener("resize", handleViewportChange, { passive: true });
  document.addEventListener("scroll", handleViewportChange, true);

  return () => {
    commandMenu.removeEventListener("mouseover", handleSubmenuActivate);
    commandMenu.removeEventListener("focusin", handleSubmenuActivate);
    window.removeEventListener("resize", handleViewportChange);
    document.removeEventListener("scroll", handleViewportChange, true);
    resetAllSubmenuPanels(commandMenu);
  };
}

export function createCommandMenuController({ commandButton, commandMenu }) {
  let removeOutsideListeners = null;
  let removeSubmenuPositioning = null;

  function clearOutsideListeners() {
    if (typeof removeOutsideListeners === "function") {
      removeOutsideListeners();
      removeOutsideListeners = null;
    }
  }

  function clearSubmenuPositioning() {
    if (typeof removeSubmenuPositioning === "function") {
      removeSubmenuPositioning();
      removeSubmenuPositioning = null;
    }
  }

  function close() {
    if (!commandMenu.classList.contains("is-open")) return;
    commandMenu.classList.remove("is-open");
    commandButton.setAttribute("aria-expanded", "false");
    clearOutsideListeners();
    clearSubmenuPositioning();
  }

  function open() {
    if (commandMenu.classList.contains("is-open")) return;
    commandMenu.classList.add("is-open");
    commandButton.setAttribute("aria-expanded", "true");
    removeSubmenuPositioning = attachSubmenuPositioning(commandMenu);

    const closeFromOutside = (event) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (commandMenu.contains(target) || commandButton.contains(target)) return;
      close();
    };

    document.addEventListener("mousedown", closeFromOutside);
    document.addEventListener("touchstart", closeFromOutside, { passive: true });
    removeOutsideListeners = () => {
      document.removeEventListener("mousedown", closeFromOutside);
      document.removeEventListener("touchstart", closeFromOutside);
    };
  }

  function toggle() {
    if (commandMenu.classList.contains("is-open")) {
      close();
      return;
    }
    open();
  }

  return {
    open,
    close,
    toggle,
  };
}

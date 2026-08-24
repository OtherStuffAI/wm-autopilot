const sanitiseImageUrl = (value) => {
  if (!value || typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed, window.location.origin);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return url.toString();
    }
  } catch {
    // ignore invalid URLs
  }
  return null;
};

export const applyAvatarImage = (node, url, fallbackLabel) => {
  if (!(node instanceof HTMLElement)) return;
  const safeUrl = sanitiseImageUrl(url);
  if (safeUrl) {
    node.dataset.hasImage = "true";
    node.style.backgroundImage = `url("${safeUrl.replace(/"/g, "")}")`;
    node.textContent = "";
  } else {
    delete node.dataset.hasImage;
    node.style.backgroundImage = "";
    node.textContent = (fallbackLabel || "?").slice(0, 2).toUpperCase();
  }
};

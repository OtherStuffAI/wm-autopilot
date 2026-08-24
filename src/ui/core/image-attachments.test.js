import { afterEach, describe, expect, test } from "bun:test";

import { bindInlineImagePreviewLinks, initImageAttachments } from "./image-attachments.js";

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.dataset = {};
    this.attributes = {};
    this.eventListeners = new Map();
    this.hidden = false;
    this.className = "";
    this.textContent = "";
    this.value = "";
  }

  append(...children) {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
  }

  replaceChildren(...children) {
    this.children.forEach((child) => {
      child.parentElement = null;
    });
    this.children = [];
    this.append(...children);
  }

  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  addEventListener(type, handler) {
    if (!this.eventListeners.has(type)) {
      this.eventListeners.set(type, []);
    }
    this.eventListeners.get(type).push(handler);
  }

  removeEventListener(type, handler) {
    const handlers = this.eventListeners.get(type) ?? [];
    this.eventListeners.set(type, handlers.filter((item) => item !== handler));
  }

  dispatchEvent(event) {
    try {
      if (!event.target) {
        event.target = this;
      }
    } catch {
      // Browser Event.target is readonly; handlers in these tests do not need it.
    }
    for (const handler of this.eventListeners.get(event.type) ?? []) {
      handler(event);
    }
  }

  click() {
    this.dispatchEvent({ type: "click", target: this });
  }

  focus() {}

  closest(selector) {
    let current = this;
    while (current) {
      if (matchesSelector(current, selector)) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }

  querySelector(selector) {
    return findFirst(this, selector);
  }
}

class FakeDialogElement extends FakeElement {
  constructor() {
    super("dialog");
    this.open = false;
  }

  showModal() {
    this.open = true;
  }

  close() {
    this.open = false;
    this.dispatchEvent({ type: "close", target: this });
  }
}

function hasClass(element, className) {
  return String(element.className ?? "").split(/\s+/).includes(className);
}

function matchesSelector(element, selector) {
  if (selector === "textarea") {
    return element.tagName === "TEXTAREA";
  }
  if (selector === "img") {
    return element.tagName === "IMG";
  }
  const dataTestIdMatch = selector.match(/^\[data-testid="([^"]+)"\]$/);
  if (dataTestIdMatch) {
    return element.dataset.testid === dataTestIdMatch[1];
  }
  const classAndSessionMatch = selector.match(/^\.([A-Za-z0-9_-]+)\[data-session-id="([^"]+)"\]$/);
  if (classAndSessionMatch) {
    return hasClass(element, classAndSessionMatch[1]) && element.dataset.sessionId === classAndSessionMatch[2];
  }
  const classMatch = selector.match(/^\.([A-Za-z0-9_-]+)$/);
  if (classMatch) {
    return hasClass(element, classMatch[1]);
  }
  return false;
}

function findFirst(root, selector) {
  for (const child of root.children ?? []) {
    if (matchesSelector(child, selector)) {
      return child;
    }
    const nested = findFirst(child, selector);
    if (nested) {
      return nested;
    }
  }
  return null;
}

function createFakeDocument() {
  const body = new FakeElement("body");
  return {
    body,
    createElement(tagName) {
      return tagName === "dialog" ? new FakeDialogElement() : new FakeElement(tagName);
    },
    querySelector(selector) {
      return matchesSelector(body, selector) ? body : findFirst(body, selector);
    },
  };
}

function mountComposer(document, sessionId) {
  const shell = document.createElement("div");
  shell.className = "wm-composer-shell";
  shell.dataset.sessionId = sessionId;

  const container = document.createElement("div");
  container.className = "wm-image-preview-container";
  container.hidden = true;

  const textarea = document.createElement("textarea");
  shell.append(container, textarea);
  document.body.append(shell);
  return { shell, container, textarea };
}

describe("image attachment previews", () => {
  const originalDocument = globalThis.document;
  const originalDialog = globalThis.HTMLDialogElement;
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;

  afterEach(() => {
    globalThis.document = originalDocument;
    globalThis.HTMLDialogElement = originalDialog;
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
  });

  test("keeps thumbnails in session state until explicit remove or clear", () => {
    const document = createFakeDocument();
    globalThis.document = document;
    globalThis.HTMLDialogElement = FakeDialogElement;

    const state = {
      messageDrafts: new Map(),
      imageAttachmentDrafts: new Map(),
    };
    const attachments = initImageAttachments({
      state,
      getSessionById: () => ({ id: "session-1", agent: "codex" }),
      showToast: () => {},
    });

    const firstMount = mountComposer(document, "session-1");
    const markerId = attachments.addImagePreview("session-1", { name: "screen.png" }, "blob:screen");
    expect(firstMount.container.hidden).toBe(false);
    expect(firstMount.container.children).toHaveLength(1);

    attachments.cleanupOrphanedMarkers("session-1", "typing without the marker");
    expect(state.imageAttachmentDrafts.get("session-1")).toHaveLength(1);

    firstMount.container.replaceChildren();
    firstMount.container.hidden = true;
    attachments.prepareImagePreviewsForComposer("session-1");
    expect(firstMount.container.hidden).toBe(false);
    expect(firstMount.container.children).toHaveLength(1);

    firstMount.container.querySelector('[data-testid="image-attachment-open"]').click();
    const dialog = document.querySelector(".wm-image-preview-dialog");
    expect(dialog.open).toBe(true);
    expect(dialog.querySelector('[data-testid="image-preview-full-image"]').src).toBe("blob:screen");

    const draftAttachment = state.imageAttachmentDrafts.get("session-1")[0];
    draftAttachment.publicPath = "/uploads/images/user/codex/screen.png";
    draftAttachment.placeholder = "![uploaded image](/uploads/images/user/codex/screen.png)";
    firstMount.textarea.value = `hello <!--IMG:${markerId}-->${draftAttachment.placeholder}`;
    attachments.prepareImagePreviewsForComposer("session-1");
    firstMount.container.querySelector('[data-testid="image-attachment-remove"]').click();

    expect(state.imageAttachmentDrafts.has("session-1")).toBe(false);
    expect(firstMount.container.hidden).toBe(true);
    expect(firstMount.textarea.value).toBe("hello ");
  });

  test("opens inline chat images in the preview modal instead of navigating", () => {
    const root = new FakeElement("div");
    const link = new FakeElement("a");
    link.className = "wm-inline-image-link";
    link.href = "/uploads/images/user/codex/screen.png";
    link.setAttribute("href", link.href);
    const image = new FakeElement("img");
    image.src = "http://localhost:3600/uploads/images/user/codex/screen.png";
    image.alt = "uploaded image";
    link.append(image);
    root.append(link);

    let prevented = false;
    let previewAttachment = null;
    const detach = bindInlineImagePreviewLinks({
      root,
      openPreview: (attachment) => {
        previewAttachment = attachment;
      },
    });

    root.dispatchEvent({
      type: "click",
      target: image,
      preventDefault: () => {
        prevented = true;
      },
    });

    expect(prevented).toBe(true);
    expect(previewAttachment).toEqual({
      publicPath: image.src,
      name: "uploaded image",
    });

    detach();
  });

  test("removes the internal upload marker when an image request fails", async () => {
    const document = createFakeDocument();
    globalThis.document = document;
    globalThis.HTMLDialogElement = FakeDialogElement;
    globalThis.fetch = async () => {
      throw new Error("network unavailable");
    };
    console.error = () => {};

    const state = {
      messageDrafts: new Map(),
      imageAttachmentDrafts: new Map(),
    };
    const toastMessages = [];
    const attachments = initImageAttachments({
      state,
      getSessionById: () => ({ id: "session-1", agent: "codex" }),
      showToast: (message) => toastMessages.push(message),
      createThumbnail: async () => null,
    });
    const composer = mountComposer(document, "session-1");
    const uploadStates = [];
    const image = new Blob(["image"], { type: "image/png" });
    image.name = "screen.png";

    await attachments.handleImageUploads(
      "session-1",
      [image],
      composer.textarea,
      () => {},
      (uploading) => uploadStates.push(uploading),
    );

    expect(uploadStates).toEqual([true, false]);
    expect(composer.textarea.value).not.toContain("Uploading");
    expect(composer.textarea.value).not.toContain("<!--IMG:");
    expect(state.messageDrafts.get("session-1")).not.toContain("Uploading");
    expect(toastMessages).toContain("Image upload failed. Check console for details.");
  });

  test("writes a completed image reference into a remounted session composer", async () => {
    const document = createFakeDocument();
    globalThis.document = document;
    globalThis.HTMLDialogElement = FakeDialogElement;

    const state = {
      messageDrafts: new Map(),
      imageAttachmentDrafts: new Map(),
    };
    let remountedComposer = null;
    globalThis.fetch = async () => {
      const draft = state.messageDrafts.get("session-1");
      firstComposer.shell.remove();
      remountedComposer = mountComposer(document, "session-1");
      remountedComposer.textarea.value = draft;
      return {
        ok: true,
        json: async () => ({
          placeholder: "![uploaded image](/uploads/images/screen.png)",
          publicPath: "/uploads/images/screen.png",
        }),
      };
    };

    const attachments = initImageAttachments({
      state,
      getSessionById: () => ({ id: "session-1", agent: "codex" }),
      showToast: () => {},
      createThumbnail: async () => null,
    });
    const firstComposer = mountComposer(document, "session-1");
    const image = new Blob(["image"], { type: "image/png" });
    image.name = "screen.png";

    await attachments.handleImageUploads(
      "session-1",
      [image],
      firstComposer.textarea,
      () => {},
      () => {},
    );

    expect(remountedComposer.textarea.value).toContain("![uploaded image](/uploads/images/screen.png)");
    expect(remountedComposer.textarea.value).not.toContain("Uploading");
    expect(state.messageDrafts.get("session-1")).toBe(remountedComposer.textarea.value);
  });
});

/**
 * Image and file attachment handling — thumbnails, previews, upload flows.
 *
 * Depends on: state.messageDrafts, getSessionById (via DI).
 */

import { createAttachmentUploadFlows } from "./attachment-upload-flows.js";

export function openImagePreviewModal(attachment) {
  const imageSrc = attachment?.publicPath || attachment?.objectUrl;
  if (!imageSrc) return;

  const existing = document.querySelector('.wm-image-preview-dialog');
  if (existing instanceof HTMLDialogElement) {
    existing.close();
    existing.remove();
  }

  const dialog = document.createElement('dialog');
  dialog.className = 'wm-image-preview-dialog';
  dialog.dataset.testid = 'image-preview-modal';
  dialog.setAttribute('aria-labelledby', 'image-preview-title');
  const panel = document.createElement('div');
  panel.className = 'wm-image-preview-dialog__panel';
  const header = document.createElement('header');
  header.className = 'wm-image-preview-dialog__header';
  const title = document.createElement('h2');
  title.id = 'image-preview-title';
  title.textContent = 'Image preview';
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'wm-image-preview-dialog__close';
  closeButton.setAttribute('aria-label', 'Close image preview');
  closeButton.dataset.testid = 'image-preview-close';
  closeButton.textContent = '\u00d7';
  const body = document.createElement('div');
  body.className = 'wm-image-preview-dialog__body';
  const image = document.createElement('img');
  image.src = imageSrc;
  image.alt = attachment.name || 'Uploaded image preview';
  image.dataset.testid = 'image-preview-full-image';
  header.append(title, closeButton);
  body.append(image);
  panel.append(header, body);
  dialog.append(panel);

  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) {
      dialog.close();
    }
  });
  closeButton.addEventListener('click', () => {
    dialog.close();
  });
  dialog.addEventListener('close', () => {
    dialog.remove();
  });

  document.body.append(dialog);
  if (typeof dialog.showModal === 'function') {
    dialog.showModal();
  } else {
    dialog.setAttribute('open', 'open');
  }
}

export function bindInlineImagePreviewLinks({ root = document, openPreview = openImagePreviewModal } = {}) {
  const clickRoot = root?.addEventListener ? root : document;
  const handleClick = (event) => {
    const target = event.target;
    const link = target?.closest?.('.wm-inline-image-link');
    if (!link) {
      return;
    }
    event.preventDefault();

    const image = link.querySelector?.('img');
    const publicPath = image?.currentSrc || image?.src || link.href || link.getAttribute?.('href') || '';
    const name = image?.alt || link.getAttribute?.('aria-label') || 'Inline image preview';
    openPreview({ publicPath, name });
  };

  clickRoot.addEventListener('click', handleClick);
  return () => {
    clickRoot.removeEventListener?.('click', handleClick);
  };
}

export function initImageAttachments(deps) {
  const { state, getSessionById, showToast, createThumbnail: createThumbnailOverride } = deps;

  const ensureImageAttachmentDrafts = () => {
    if (!(state.imageAttachmentDrafts instanceof Map)) {
      state.imageAttachmentDrafts = new Map();
    }
    return state.imageAttachmentDrafts;
  };

  // ── Text cursor helper ──────────────────────────────────────────

  const insertTextAtCursor = (textarea, text, sessionId) => {
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? textarea.value.length;
    const before = textarea.value.slice(0, start);
    const after = textarea.value.slice(end);
    const next = before + text + after;
    const nextCursor = start + text.length;
    textarea.value = next;
    textarea.selectionStart = textarea.selectionEnd = nextCursor;
    state.messageDrafts.set(sessionId, next);
  };

  // ── Thumbnail generation ────────────────────────────────────────

  const createThumbnail = createThumbnailOverride ?? ((file, maxSize = 80) => {
    return new Promise((resolve) => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      const img = new Image();

      img.onload = () => {
        let { width, height } = img;
        if (width > height) {
          if (width > maxSize) {
            height = (height * maxSize) / width;
            width = maxSize;
          }
        } else {
          if (height > maxSize) {
            width = (width * maxSize) / height;
            height = maxSize;
          }
        }

        canvas.width = width;
        canvas.height = height;
        ctx.drawImage(img, 0, 0, width, height);

        canvas.toBlob((blob) => {
          resolve(URL.createObjectURL(blob));
        }, 'image/jpeg', 0.8);
      };

      img.onerror = () => resolve(null);
      img.src = URL.createObjectURL(file);
    });
  });

  const createAttachmentId = () => `img_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;

  const removeUploadMarkerFromText = (text, markerId) => {
    const marker = `<!--IMG:${markerId}-->`;
    return String(text ?? "").replace(marker, '');
  };

  const removeAttachmentReferenceFromText = (text, attachment) => {
    let nextText = removeUploadMarkerFromText(text, attachment.id);
    if (attachment.placeholder) {
      nextText = nextText.replace(attachment.placeholder, '');
    }
    if (attachment.publicPath && attachment.publicPath !== attachment.placeholder) {
      nextText = nextText.replace(attachment.publicPath, '');
    }
    return nextText;
  };

  const getSessionAttachments = (sessionId) => {
    const drafts = ensureImageAttachmentDrafts();
    return drafts.get(sessionId) ?? [];
  };

  const setSessionAttachments = (sessionId, attachments) => {
    const drafts = ensureImageAttachmentDrafts();
    const nextAttachments = Array.isArray(attachments) ? attachments : [];
    if (nextAttachments.length > 0) {
      drafts.set(sessionId, nextAttachments);
    } else {
      drafts.delete(sessionId);
    }
  };

  const upsertSessionAttachment = (sessionId, attachment) => {
    const attachments = getSessionAttachments(sessionId);
    const index = attachments.findIndex((item) => item.id === attachment.id);
    const next = index === -1
      ? [...attachments, attachment]
      : attachments.map((item) => item.id === attachment.id ? { ...item, ...attachment } : item);
    setSessionAttachments(sessionId, next);
  };

  const removeSessionAttachment = (sessionId, markerId) => {
    const attachments = getSessionAttachments(sessionId);
    const removed = attachments.find((item) => item.id === markerId);
    const next = attachments.filter((item) => item.id !== markerId);
    setSessionAttachments(sessionId, next);
    if (removed?.objectUrl) {
      URL.revokeObjectURL(removed.objectUrl);
    }
  };

  const getImagePreviewContainer = (sessionId) => {
    const composerShell = document.querySelector(`.wm-composer-shell[data-session-id="${sessionId}"]`);
    return composerShell?.querySelector('.wm-image-preview-container') ?? null;
  };

  const syncPreviewContainerVisibility = (container) => {
    if (!container) return;
    container.hidden = container.children.length === 0;
  };

  const createPreviewItem = (sessionId, attachment) => {
    const previewItem = document.createElement('div');
    previewItem.className = 'wm-image-preview-item';
    previewItem.dataset.attachmentId = attachment.id;
    previewItem.dataset.testid = 'image-attachment-thumbnail';

    const previewButton = document.createElement('button');
    previewButton.type = 'button';
    previewButton.className = 'wm-image-preview-thumb';
    previewButton.setAttribute('aria-label', `Open ${attachment.name || 'uploaded image'} preview`);
    previewButton.dataset.testid = 'image-attachment-open';

    const img = document.createElement('img');
    img.src = attachment.publicPath || attachment.objectUrl || '';
    img.alt = attachment.name || 'Uploaded image';
    img.loading = 'lazy';
    previewButton.append(img);
    previewButton.addEventListener('click', () => {
      openImagePreviewModal(attachment);
    });

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'wm-image-preview-remove';
    removeBtn.textContent = '\u00d7';
    removeBtn.title = 'Remove image';
    removeBtn.setAttribute('aria-label', `Remove ${attachment.name || 'uploaded image'}`);
    removeBtn.dataset.testid = 'image-attachment-remove';
    removeBtn.addEventListener('click', () => {
      const composerShell = document.querySelector(`.wm-composer-shell[data-session-id="${sessionId}"]`);
      const textarea = composerShell?.querySelector('textarea');
      if (textarea) {
        const nextText = removeAttachmentReferenceFromText(textarea.value, attachment);
        textarea.value = nextText;
        state.messageDrafts.set(sessionId, nextText);
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
      }
      removeSessionAttachment(sessionId, attachment.id);
      renderImagePreviews(sessionId);
    });

    previewItem.append(previewButton, removeBtn);
    return previewItem;
  };

  function renderImagePreviews(sessionId) {
    const previewContainer = getImagePreviewContainer(sessionId);
    if (!previewContainer) return;
    previewContainer.replaceChildren();
    for (const attachment of getSessionAttachments(sessionId)) {
      previewContainer.append(createPreviewItem(sessionId, attachment));
    }
    syncPreviewContainerVisibility(previewContainer);
  }

  // ── Preview DOM helper ──────────────────────────────────────────

  const addImagePreview = (sessionId, file, thumbnailUrl) => {
    const markerId = createAttachmentId();
    upsertSessionAttachment(sessionId, {
      id: markerId,
      name: file?.name || 'uploaded image',
      objectUrl: thumbnailUrl,
      publicPath: null,
      status: 'uploading',
    });
    renderImagePreviews(sessionId);
    return markerId;
  };

  // ── Public helpers ──────────────────────────────────────────────

  const clearImagePreviews = (sessionId) => {
    for (const attachment of getSessionAttachments(sessionId)) {
      if (attachment.objectUrl) {
        URL.revokeObjectURL(attachment.objectUrl);
      }
    }
    setSessionAttachments(sessionId, []);
    const previewContainer = getImagePreviewContainer(sessionId);
    if (previewContainer) {
      previewContainer.replaceChildren();
      syncPreviewContainerVisibility(previewContainer);
    }
  };

  const prepareImagePreviewsForComposer = (sessionId) => {
    renderImagePreviews(sessionId);
  };

  const extractImageFiles = (items) => {
    if (!items) return [];
    const files = [];
    for (const item of Array.from(items)) {
      if (!item) continue;
      if (item.kind === "file") {
        const file = item.getAsFile?.() ?? item;
        if (file instanceof File && file.type?.startsWith?.("image/")) {
          files.push(file);
        }
      } else if (item instanceof File || item instanceof Blob) {
        if (item.type?.startsWith?.("image/")) {
          files.push(item);
        }
      }
    }
    return files;
  };

  const extractAttachmentFiles = (items) => {
    if (!items) return [];
    const files = [];
    for (const item of Array.from(items)) {
      if (!item) continue;
      if (item.kind === "file") {
        const file = item.getAsFile?.() ?? item;
        if (file instanceof File && !file.type?.startsWith?.("image/")) {
          files.push(file);
        }
      } else if (item instanceof File || item instanceof Blob) {
        if (!item.type || !item.type.startsWith("image/")) {
          files.push(item);
        }
      }
    }
    return files;
  };

  // ── Upload flows ────────────────────────────────────────────────

  const { handleImageUploads, handleAttachmentUploads } = createAttachmentUploadFlows({
    state,
    getSessionById,
    showToast,
    createThumbnail,
    addImagePreview,
    getSessionAttachments,
    upsertSessionAttachment,
    removeSessionAttachment,
    renderImagePreviews,
    insertTextAtCursor,
  });

  /**
   * Remove orphaned image markers — called from textarea input handler
   * when user deletes marker text manually.
   */
  const cleanupOrphanedMarkers = (_sessionId, _text) => {
    return;
  };

  return {
    insertTextAtCursor,
    createThumbnail,
    addImagePreview,
    clearImagePreviews,
    prepareImagePreviewsForComposer,
    extractImageFiles,
    extractAttachmentFiles,
    handleImageUploads,
    handleAttachmentUploads,
    cleanupOrphanedMarkers,
    openImagePreviewModal,
    bindInlineImagePreviewLinks,
  };
}

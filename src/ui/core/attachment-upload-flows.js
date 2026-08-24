function findUploadMarkerInText(text, markerId) {
  return String(text ?? "").indexOf(`<!--IMG:${markerId}-->`);
}

function removeUploadPlaceholderFromText(text, markerId, fallbackPlaceholder) {
  if (!markerId) {
    return String(text ?? "").replace(fallbackPlaceholder, "");
  }
  return String(text ?? "").replace(`<!--IMG:${markerId}-->[Uploading...]`, "");
}

export function createAttachmentUploadFlows({
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
}) {
  function getCurrentSessionTextarea(sessionId, fallbackTextarea) {
    const composerShell = document.querySelector(`.wm-composer-shell[data-session-id="${sessionId}"]`);
    return composerShell?.querySelector("textarea") ?? fallbackTextarea;
  }

  function updateSessionDraft(sessionId, fallbackTextarea, nextText) {
    const targetTextarea = getCurrentSessionTextarea(sessionId, fallbackTextarea);
    targetTextarea.value = nextText;
    state.messageDrafts.set(sessionId, nextText);
    targetTextarea.dispatchEvent?.(new Event("input", { bubbles: true }));
    return targetTextarea;
  }

  function discardPendingImageUpload({
    sessionId,
    textarea,
    markerId,
    uploadingPlaceholder,
    thumbnailUrl,
  }) {
    const targetTextarea = getCurrentSessionTextarea(sessionId, textarea);
    const currentValue = targetTextarea.value;
    const markerIndex = markerId
      ? findUploadMarkerInText(currentValue, markerId)
      : currentValue.lastIndexOf(uploadingPlaceholder);
    if (markerIndex !== -1) {
      const newText = removeUploadPlaceholderFromText(currentValue, markerId, uploadingPlaceholder);
      updateSessionDraft(sessionId, textarea, newText);
    }

    if (thumbnailUrl && markerId) {
      removeSessionAttachment(sessionId, markerId);
      renderImagePreviews(sessionId);
    } else if (thumbnailUrl) {
      URL.revokeObjectURL(thumbnailUrl);
    }
  }

  function replacePendingImageUpload({
    sessionId,
    textarea,
    markerId,
    uploadingPlaceholder,
    placeholder,
  }) {
    const targetTextarea = getCurrentSessionTextarea(sessionId, textarea);
    const currentValue = targetTextarea.value;
    const markerIndex = markerId
      ? findUploadMarkerInText(currentValue, markerId)
      : currentValue.lastIndexOf(uploadingPlaceholder);
    if (markerIndex === -1) {
      return targetTextarea;
    }

    const markerText = markerId ? `<!--IMG:${markerId}-->[Uploading...]` : uploadingPlaceholder;
    const nextText = currentValue.substring(0, markerIndex)
      + placeholder
      + currentValue.substring(markerIndex + markerText.length);
    return updateSessionDraft(sessionId, textarea, nextText);
  }

  async function handleImageUploads(sessionId, files, textarea, resizeTextarea, setUploadingState) {
    if (!files || files.length === 0) return;
    const session = getSessionById(sessionId);
    if (!session) {
      showToast?.("Unable to locate session for image upload.", { type: "error" });
      return;
    }

    setUploadingState(true);
    try {
      for (const file of files) {
        if (!file?.type?.startsWith?.("image/")) {
          continue;
        }

        const thumbnailUrl = await createThumbnail(file);
        let markerId = null;
        if (thumbnailUrl) {
          markerId = addImagePreview(sessionId, file, thumbnailUrl);
        }

        const marker = markerId ? `<!--IMG:${markerId}-->` : "";
        const uploadingPlaceholder = markerId ? `${marker}[Uploading...]` : "[Uploading...]";
        const targetTextarea = getCurrentSessionTextarea(sessionId, textarea);
        const uploadText = targetTextarea.value.endsWith("\n") ? `${uploadingPlaceholder}\n` : `\n${uploadingPlaceholder}\n`;
        insertTextAtCursor(targetTextarea, uploadText, sessionId);
        resizeTextarea();

        try {
          const form = new FormData();
          form.append("agent", session.agent);
          form.append("image", file, file.name);

          const response = await fetch("/api/uploads/images", {
            method: "POST",
            body: form,
          });

          if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            const errorText = data?.error || response.statusText || "Unknown error";
            const message = `Image upload failed (${response.status}): ${errorText}`;
            console.error("[image-upload]", message, { status: response.status, data });
            showToast?.(message, { type: "error" });
            discardPendingImageUpload({ sessionId, textarea, markerId, uploadingPlaceholder, thumbnailUrl });
            continue;
          }

          const payload = await response.json().catch(() => ({}));
          const placeholder =
            typeof payload?.placeholder === "string"
              ? payload.placeholder
              : typeof payload?.publicPath === "string"
                ? payload.publicPath
                : null;

          if (!placeholder) {
            showToast?.("Image upload succeeded without a usable reference.", { type: "error" });
            discardPendingImageUpload({ sessionId, textarea, markerId, uploadingPlaceholder, thumbnailUrl });
            continue;
          }

          const completedTextarea = replacePendingImageUpload({
            sessionId,
            textarea,
            markerId,
            uploadingPlaceholder,
            placeholder,
          });

          if (thumbnailUrl && markerId) {
            const attachments = getSessionAttachments(sessionId);
            const existing = attachments.find((item) => item.id === markerId);
            if (existing?.objectUrl) {
              URL.revokeObjectURL(existing.objectUrl);
            }
            upsertSessionAttachment(sessionId, {
              ...(existing ?? { id: markerId, name: file?.name || "uploaded image" }),
              objectUrl: null,
              publicPath: payload.publicPath || placeholder,
              placeholder,
              status: "uploaded",
            });
            renderImagePreviews(sessionId);
          } else if (thumbnailUrl) {
            URL.revokeObjectURL(thumbnailUrl);
          }

          if (completedTextarea === textarea) {
            resizeTextarea();
          }
          if (document.contains?.(completedTextarea) !== false) {
            completedTextarea.focus({ preventScroll: true });
          }
        } catch (error) {
          console.error("Failed to upload image", error);
          discardPendingImageUpload({ sessionId, textarea, markerId, uploadingPlaceholder, thumbnailUrl });
          showToast?.("Image upload failed. Check console for details.", { type: "error" });
        }
      }
    } finally {
      setUploadingState(false);
    }
  }

  async function uploadLiveAttachment(agentId, file) {
    const form = new FormData();
    form.append("agent", agentId);
    form.append("file", file, file.name);

    const response = await fetch("/api/uploads/files", {
      method: "POST",
      body: form,
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      const message = data?.error ?? response.statusText ?? "File upload failed";
      throw new Error(message);
    }

    const data = await response.json().catch(() => ({}));
    const first = Array.isArray(data?.files) ? data.files[0] : null;
    if (!first) {
      throw new Error("Upload succeeded without file details");
    }
    return first;
  }

  async function handleAttachmentUploads(sessionId, files, textarea, resizeTextarea, setUploadingState) {
    if (!files || files.length === 0) return;
    const session = getSessionById(sessionId);
    if (!session) {
      showToast?.("Unable to locate session for file upload.", { type: "error" });
      return;
    }

    setUploadingState(true);
    try {
      for (const file of files) {
        try {
          const payload = await uploadLiveAttachment(session.agent, file);
          const placeholder = typeof payload?.placeholder === "string" ? payload.placeholder : null;
          const fallback =
            typeof payload?.publicPath === "string"
              ? payload.publicPath
              : typeof payload?.absolutePath === "string"
                ? payload.absolutePath
                : "";
          const reference = placeholder || fallback;
          if (!reference) {
            showToast?.("File upload succeeded without a usable reference.", { type: "error" });
            continue;
          }
          const targetTextarea = getCurrentSessionTextarea(sessionId, textarea);
          const needsPrefix = targetTextarea.value.length > 0 && !targetTextarea.value.endsWith("\n");
          const textToInsert = needsPrefix ? `\n${reference}\n` : `${reference}\n`;
          insertTextAtCursor(targetTextarea, textToInsert, sessionId);
          if (targetTextarea === textarea) {
            resizeTextarea();
          }
          if (document.contains?.(targetTextarea) !== false) {
            targetTextarea.focus({ preventScroll: true });
          }
        } catch (error) {
          console.error("Failed to upload file", error);
          const message = error instanceof Error ? error.message : "File upload failed. Check console for details.";
          showToast?.(message, { type: "error" });
        }
      }
    } finally {
      setUploadingState(false);
    }
  }

  return {
    handleAttachmentUploads,
    handleImageUploads,
  };
}

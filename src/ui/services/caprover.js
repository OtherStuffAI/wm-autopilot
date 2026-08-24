/**
 * CapRover UI Service
 *
 * Client-side API for CapRover deployment operations.
 */

/**
 * Check CapRover connection status.
 * @returns {Promise<{configured: boolean, connected?: boolean, rootDomain?: string, error?: string}>}
 */
export async function fetchCaproverStatus() {
  try {
    const response = await fetch("/api/caprover/status");
    return await response.json();
  } catch (error) {
    return { configured: false, error: error.message };
  }
}

/**
 * Deploy an app to CapRover using its captain-definition file.
 * @param {string} appId - The local app ID
 * @param {string} caproverName - The CapRover app name to deploy to
 * @param {string} caproverTarget - The CapRover target name, or "all"
 * @param {boolean} enableHttps - Whether to enable HTTPS after deployment
 * @returns {Promise<{success: boolean, liveUrl?: string, caproverName?: string, error?: string}>}
 */
export async function deployAppToCaprover(appId, caproverName, caproverTarget = "all", enableHttps = false) {
  const response = await fetch(`/api/apps/${encodeURIComponent(appId)}/deploy-to-caprover`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ caproverName, caproverTarget, enableHttps }),
  });

  const data = await response.json();

  if (!response.ok) {
    return {
      success: false,
      error: data.error || response.statusText || "Deployment failed",
    };
  }

  return {
    success: true,
    liveUrl: data.liveUrl,
    caproverName: data.caproverName,
    targets: data.targets,
  };
}

/**
 * Derive a valid CapRover app name from an app label.
 * @param {string} label - The app label
 * @returns {string} A valid CapRover app name
 */
export function deriveCaproverName(label) {
  if (!label || typeof label !== "string") return "";

  return label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-") // Replace non-alphanumeric with hyphens
    .replace(/^-+/, "") // Remove leading hyphens
    .replace(/-+$/, "") // Remove trailing hyphens
    .replace(/^[^a-z]+/, "") // Ensure starts with a letter
    .slice(0, 50); // Max length
}

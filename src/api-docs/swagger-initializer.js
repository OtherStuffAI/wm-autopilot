/* Every interactive request signs its exact final URL and serialized body. */
window.addEventListener("load", () => {
  window.SwaggerUIBundle({
    url: "/api/docs/openapi.json", dom_id: "#swagger-ui", deepLinking: true,
    validatorUrl: null, persistAuthorization: false,
    requestInterceptor: async request => {
      const target = new URL(request.url, window.location.origin);
      if (target.pathname.startsWith("/api/docs/") && request.method === "GET") return request;
      if (target.origin !== window.location.origin) throw new Error("Interactive API calls must use this Autopilot origin");
      request.credentials = "omit";
      if (!window.nostr?.signEvent) throw new Error("Enable a NIP-07 browser signer to sign each API request");
      const tags = [["u", target.href], ["method", request.method.toUpperCase()]];
      const body = request.body ?? "";
      if (typeof body !== "string") throw new Error("Interactive signing requires a serialized text body");
      if (body.length) {
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
        tags.push(["payload", [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("")]);
      }
      const status = document.querySelector('[role="status"]');
      if (status) status.textContent = "Waiting for signer authorization…";
      let event;
      try { event = await window.nostr.signEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), content: "", tags }); }
      catch (error) { if (status) status.textContent = "Signer authorization failed."; throw error; }
      if (status) status.textContent = "Signed request sent.";
      request.headers.Authorization = `Nostr ${btoa(JSON.stringify(event))}`;
      return request;
    },
  });
});

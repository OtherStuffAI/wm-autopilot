# Live phone layout regression

Run `node scripts/ui/check-live-phone-layout.mjs` with Bun on PATH and Playwright installed. If Playwright is installed outside this repository, set `PLAYWRIGHT_MODULE` to its absolute `index.mjs` path. Set `WEBKIT_EXECUTABLE` when using a separate installed WebKit launcher.

The runner starts an isolated, ephemeral Bun server using the production static asset service. It loads the production HTML header, `initLiveView`, Dexie/Alpine message rendering, agent status indicator and mobile runtime. Session data and transport are synthetic; it never logs in, sends messages, or starts agents.

The checks cover:

- 320, 390 and 430px touch phones, tablet, desktop and a narrow desktop pointer.
- Normal and split chat, expanded/collapsed header, resize to 400px height.
- Composer bounds, document versus conversation scrolling, scroll pills and the Last prompt menu action.
- User, queued, assistant/code, expanded and collapsed thinking/tool messages; action containment and overlap.
- Input font size, primary touch targets, visual viewport offset/keyboard API changes and pinch-layout stability.
- A simulated 34px safe area, applied to production CSS, and a short conversation.

Desktop browser emulation cannot establish real iOS keyboard, safe-area, text-inflation or native wmapp behavior. The visual viewport and safe-area cases are simulations, not device tests.

Optional environment variables:

- `UI_EVIDENCE_DIR`: existing Git-ignored directory for screenshots and JSON measurements (for example `tmp/docs/handoffs/phone-layout`).
- `UI_SERVED_URL`: load JavaScript/CSS from the running app while retaining the isolated synthetic session.
- `UI_LAYOUT_CASES`: comma-separated case names, such as `phone,tablet,desktop`.
- `UI_BASELINE_REF`: Git revision to measure before the fix; records failures in layout metrics without asserting the new behavior.

Operational screenshots and reports belong only in ignored `tmp/docs/handoffs`, never in commits.

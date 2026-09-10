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

# Main-screen phone review

Run `node scripts/ui/check-phone-screens.mjs` from the repository root with the same `PLAYWRIGHT_MODULE` and `WEBKIT_EXECUTABLE` settings described above. Evidence defaults to the Git-ignored `tmp/docs/handoffs/phone-all-screens`; use separate directories for before and after runs.

This fixture loads the production HTML and **complete app bootstrap**, navigation, view functions, static asset service, and normal Dexie/Alpine stores. It seeds a synthetic administrator before startup and serves explicitly enumerated synthetic API responses. External requests, WebSockets and SSE are isolated. The server rejects all non-GET API calls, including telemetry and profile enrichment; it never proxies authenticated services. Missing fixture reads return an explicit 404.

The runner covers:

- Chromium and WebKit at 320, 390 and 430px touch widths, 768px tablet and 1440px desktop.
- Populated Home session groups, identity selector and View action; Apps, Archive and Pipelines tabs.
- Live → Home and Live → Settings route transitions through the production router.
- All 16 administrator Settings destinations through the production mobile selector or desktop navigation, with visible disclosures opened. Representative records include bots, workspaces, model order, configuration, users, signing policy, billing usage, feature flags and starter templates. Credential fields contain no secrets.
- Apps, Projects, Files and a populated markdown preview, Scheduler and its unsaved edit form, pipeline runs and definitions, Night Watch reports after Refresh, terminal connection form, private-chat list and Privacy.
- Document overflow, primary button heights, input fonts, page scrolling, 125% root text size on populated Home/Profile, and simulated 34px bottom safe area. Existing Live tests separately cover chat anchoring, keyboard API simulation and pinch-layout stability.

Options:

- `UI_BASELINE=1`: omit only the shared `/phone-layout.css` link and record pre-change measurements without density assertions. Existing Live styles remain loaded.
- `UI_ENGINES=chromium,webkit` and `UI_WIDTHS=320,390,430,768,1440`: select engines and viewports.
- `UI_ONLY=files,scheduler,pipelines`: narrow a follow-up to specified main routes. Include `a11y` to run the larger-text and safe-area cases. Canonical Settings paths such as `settings/credentials` can also be selected.
- `UI_EVIDENCE_DIR`: Git-ignored output folder for JSON and viewport screenshots.

Use viewport screenshots and explicit scrolling. Chromium full-page screenshots can temporarily change coarse-pointer emulation and invalidate subsequent mobile measurements. Screenshots at 320/390 include the top and, for longer pages, the bottom; measurements cover all mounted visible controls. Manually inspect screenshots alongside the JSON—page width alone does not detect cramped controls.

Known review boundaries: Starter Projects currently needs navigation away and back after its initial fetch to show the loaded controls; the runner exercises that real navigation. No session stop/delete, save, billing, signing, deploy, restart or terminal connection is submitted. Projects contain a populated project but no linked app; pipeline definitions have no execution steps; signing policy affected-session and revision lists, workspace delegations and credential accounts are empty. Those empty states do not constitute populated-control coverage. Physical iOS keyboard/safe-area behavior and native wmapp need device validation.

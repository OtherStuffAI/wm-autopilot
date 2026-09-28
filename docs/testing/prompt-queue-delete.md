# Prompt queue Delete browser regression

Run the isolated regression with an installed Playwright module and Chromium:

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
  bun test scripts/prompt-queue-delete.browser.test.ts
```

Install Chromium using that Playwright installation's `playwright install chromium`
command if needed. Without `PLAYWRIGHT_MODULE`, the browser test is skipped by the
ordinary Bun test suite.

The test starts its own server on an ephemeral loopback port, serves the real UI
modules and vendor assets, and uses an in-memory prompt queue. It never connects
to an operator session or reads the deployed queue database. It closes its own
browser and fixture server after the test.

It checks the actual Alpine conversation template and Dexie subscription, visible
confirmation, Cancel and Escape, a controlled DELETE error with retry, selected
prompt removal through the session API route, and isolation of another session's
queue. It also checks confirmation, cancellation and removal in the queue modal.

Queued message projections do not have a `deleting` property initially. Alpine
can disable a button whose boolean binding evaluates to `undefined`; use an
explicit boolean expression for this transient busy flag. The initial enabled
assertion reproduces the original inert Delete failure before any API request.

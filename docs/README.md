# Autopilot documentation

This directory contains documentation for behavior implemented by the current
source tree. It includes operator runbooks, supported integration contracts,
and feature guides.

Drafts, audits, plans, handoffs, and implementation reports are local working
material. Store them under `tmp/docs-local/`, which is excluded from Git.

Before adding a document here, verify that it describes shipped behavior and
does not contain personal names, workstation paths, live identities, private
hosts, credentials, or copied production data.

## Explicit product-contract proposals

The [WApp feed discovery/transport proposal](wapp-feed-transport-proposed.md) is
an explicitly requested exception to the shipped-behavior scope above. It pins the
canonical shared draft and distinguishes agreements from unresolved choices; no
feed adapter or new endpoint is claimed as implemented. Operational drafts and
handoffs still belong in ignored local working storage.

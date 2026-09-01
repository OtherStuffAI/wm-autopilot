# Bundled native FIPS packages

`prepare-fips-macos.sh` materializes the checksum-pinned upstream FIPS v0.5.0
macOS packages here. Autopilot's native installer refuses packages that do not
match the pinned SHA-256 digest.

The upstream v0.5.0 packages are not signed or notarized. This PoC never changes
Gatekeeper settings; installation requires an explicit operator acknowledgement
and normal macOS administrator authorization.

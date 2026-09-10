// All data is synthetic. Production app startup, routing and stores are retained.
import { state } from "/state/index.js";
Object.assign(state.identity, {
  authenticated: true, isAdmin: true, alias: "Mobile reviewer", profileName: "Mobile reviewer",
  npub: "npub1syntheticreview", ports: [4100, 4101, 4102], method: "extension",
});
document.body.dataset.authenticated = "true";
localStorage.setItem("wingman-theme", "light");
await import("/app.js");
window.fixtureReady = true;

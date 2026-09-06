# Settings: purpose and current usage

The settings registry is a catalogue of supported configuration, not a list of
features running on this installation. An unset optional setting is not necessarily
an error. Code references establish supported usage; they do not establish that an
integration is currently enabled.

| Group | What it controls | When to change it |
| --- | --- | --- |
| Your account | Identity, personal credentials, speech | Personal setup |
| Bots & connections | Bot profiles and Flight Deck workspace connections | Normal Agent Direct setup |
| Server | Model choices, hosting, users, billing, appearance, restart and installation defaults | Instance administration |
| Advanced | Remote instruction prompt, signing policies, experiments, project templates | The corresponding feature or workflow |

Server configuration is divided further:

- **Server & app hosting:** public URLs, relay connections, app routing and optional legacy port-proxy configuration.
- **Agent execution:** default tool, folders, process launch mode, executable paths and tool-specific defaults. Bot profiles supply individual bot settings.
- **Optional services:** model providers, Git service and CapRover connections. Configure only services you use.
- **Pipeline automation:** definitions directory, HTTP trigger authentication and classifier provider key. Ordinary Agent Direct chat does not require configuring these.
- **Identity & access:** instance identity and registration configuration.
- **Advanced service configuration:** Key Teleport, webhook controls, signing and WApp configuration.
- **Startup configuration:** deployment-owned port, admin identities, session secret and environment-file location. These remain environment-only.

Environment import and cleanup are maintenance operations. They are separate from
editing configuration and do not need to be performed to create a bot or connect a
workspace. Saved application values override environment values; values labelled
as requiring restart take effect after an operator restarts the service.

## Code checked

- `src/settings/instance-settings-registry.ts`: registered settings, defaults, environment aliases and startup restrictions.
- `src/settings/instance-settings-service.ts`: precedence, masking, import and cleanup.
- `src/config.ts`: server, agent, folder, hosting and compatibility consumers.
- `src/server.ts`: application-managed branding and webhook token consumers.
- `src/pipelines/pipeline-loader.ts`, `pipeline-api-routes.ts`, `pipeline-runner.ts`: pipeline-specific consumers.
- `src/ui/views/settings-view.js`: page composition and access gates.

No runtime settings or environment values were changed by this presentation cleanup.
The existing Agent Direct sender-whitelist inconsistency is a separate runtime issue.

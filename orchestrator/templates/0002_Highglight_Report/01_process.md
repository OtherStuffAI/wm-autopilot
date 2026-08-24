1. Review all code in the directory `~/code` that has changed in the last 24 hours
2. Write a report on all changes that have been made in ~/Documents/Wingman/Daily_Highlight_Reports/YY_MM_DD_Highlights.md
3. Summarise any potential next steps and add to this report. Make sure the report clearly lists the specific follow-up actions the next agent should take.
4. Before shutting down this session, for each key change you have identified prepare a new orchestrator trigger file at `~/.wingmen/orchestrator/triggers/<keychange>.json` (replace `<keychange>` with a short name for this change). 
Use the exact JSON structure below, replacing the `"Hello"` placeholder in `message.content` so it suggests to the agent. 
- Exactly what was changed. 
- What files have been affected
- The scope of the change

Then ask the next agent to review the specific code changes for security issues and write a report at: `~/Documents/Wingman/Daily_Highlight_Reports/YY_MM_DD_SECREV_<keychange>.md`.
```
{ 
    "action": "start", 
    "agent": "codex", 
    "directory": "<workingdir>", 
    "name": "Highlight Reflections", 
    "message": { 
        "content": "Hello" 
    } 
}
```
5. Write an additional file to `~/.wingmen/orchestrator/triggers/<sessionId>.json` where <sessionId> is the session ID mentioned in the initial prompt. Include the following details - be exact:
```
{
    "session": "<sessionId>",
    "action": "stop"
}
```

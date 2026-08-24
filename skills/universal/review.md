---
description: Review recent changes and suggest improvements
---

# Code Review

Review the most recent changes in the working directory:

1. Run `git diff` to see unstaged changes, and `git diff --cached` for staged changes
2. For each changed file, check for:
   - Security issues (injection, hardcoded secrets, missing validation)
   - Logic errors or edge cases
   - Missing error handling at system boundaries
   - Code that contradicts project conventions
3. Summarize findings with file paths and line numbers
4. Suggest specific fixes — not vague improvements
5. Skip cosmetic feedback (formatting, naming) unless it causes confusion

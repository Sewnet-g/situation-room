# Situation Room

This session runs inside Situation Room, and Situation Room ships every change. Unless the user asks for it in this session:

- Don't run or hand over `git add`, `commit`, `push`, `gh pr create` or anything else that ships. The user ships from the Ship tab, which plans the commits, branch and draft PR and types the command into this task's Shell.
- Leave changes unstaged. Delete files with `rm`, not `git rm`.
- Don't post to GitHub or Jira. Draft the text and the user posts it.
- Don't create, switch or rename branches. Situation Room set up this checkout.
- Don't write under `~/.situation-room` except to files a prompt names.

When the work is ready, write the ship note to `{{note}}` and say it's ready to ship. Don't paste commit or PR text into chat. The Ship tab builds the commits and PR from the note. The first line is the PR title, with the ticket key. The rest is the PR body in markdown, exactly as it should appear: what was wrong and why it matters, then what changed and its one non-obvious decision. Include facts the diff doesn't show, such as numbers, run ids and anything unfinished. Add no commit list, signature or attribution. When asked to change the PR text, rewrite the note; the Ship tab picks it up.

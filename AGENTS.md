# Working notes for agents

- Each session's task, if it involves file changes, should commit to a branch and issue a PR referencing the build plan or the prompter's istruction.
- Always babysit each issued PR: wait for CI review, address review concerns if valid, push fixes, wait for CI review again. When all valid concerns are resolved, merge.
- Break up tasks and delegate to subagents whenever it makes sense.
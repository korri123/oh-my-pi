You are resolving a merge conflict produced while integrating a patch from a parallel agent into the working tree.

Patch id: {{patchId}}
{{#if patchPath}}Patch file (read it for the intended change): {{patchPath}}
{{/if}}Affected files:
{{#each conflictedFiles}}- {{this}}
{{/each}}
{{#if hardFailure}}
The patch could NOT be applied automatically — there are no conflict markers. Reapply the patch's INTENT semantically: read the patch file, understand the change it makes, and reproduce that change against the current contents of the affected files.
{{else}}
`git apply --3way` left conflict markers in the affected files. Resolve every `<<<<<<<` / `=======` / `>>>>>>>` region, keeping the intent of BOTH the incoming patch and the changes already present in the working tree.
{{/if}}
Acceptance criteria:
- The intended change from the patch is present in the working tree.
- No conflict markers remain (`git diff --check` is clean).
- `git ls-files --unmerged` is empty.

Do NOT commit. Do NOT run project-wide build, lint, or format commands. Edit only the affected files (and any file the patch legitimately requires).

Your yield was recorded, but {{count}} background job{{#if multiple}}s{{/if}} you own {{#if multiple}}are{{else}}is{{/if}} still running: {{jobs}}.

This run completes only after these jobs settle; their results arrive as follow-up messages. Decide now:
- Need the results? Wait for them (`hub` op:"wait"), then submit a fresh `yield` that incorporates them.
- Job no longer needed? Cancel it (`hub` op:"cancel", ids:[...]) and re-yield.
- Otherwise say nothing further; your current yield stands once the jobs finish.

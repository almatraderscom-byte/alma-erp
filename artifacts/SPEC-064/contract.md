# SPEC-064 Contract — Conversation key
`requestHash(text)`, `conversationCacheKey(identity, prefixKey, requestText)` (cc:tenant:prefix:reqhash), `tenantOfKey(key)`. Same entry only when tenant+prefix+request all match. Rollback: `git revert --no-edit <SPEC-064 commit>`.

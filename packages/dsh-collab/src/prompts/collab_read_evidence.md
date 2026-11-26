Read a bounded page of immutable evidence. Reuse pages already in context. Use nextStart as start for the next page. null means the read has reached the end.
Use contains for matching text and keep that query when following nextStart. Clipped lines and partial matches omit context. Omit contains to read original pages.
Use a supplied evidence handle or artifact reference. An obs: reference reads the original tool output at that step. Use orchestrator_read for trigger/ and ticket/ paths. Native coordinators may select a ticketId and assignmentId.
Reuse a full result still in context by passing its etag as ifNoneMatch; notModified omits unchanged content. Omit ifNoneMatch after context loss or to reread the original. Tags check content equality, not factual correctness.

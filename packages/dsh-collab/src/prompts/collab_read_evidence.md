Read a bounded immutable artifact.
Use contains to look up specific text without loading the complete source. If more=true, pass nextStart as start with the same query. Clipped lines and partial matches are not complete evidence. Omit contains to read original pages (mode=page); do not delegate merely to read a file.
Use an existing input: handle or sha256: artifact reference. Native trigger/ and ticket/ resource paths belong to orchestrator_read, not this tool.
Native coordinators may specify ticketId and assignmentId; other sessions remain confined to their own run.

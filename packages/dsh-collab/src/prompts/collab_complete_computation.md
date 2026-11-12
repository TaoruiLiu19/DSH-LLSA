Compute the already-bound task contract and publish its exact final result directly in the host.
No result values or rule overrides are accepted.
If the task requests a named checkpoint, set checkpointStepId to that exact public step name (for example checkpoint), not an operation as/result key; the host saves the actual computed result as that public step before the final result, not a plan or placeholder.
Returns saved result and receipt references.
Once submitted=true, finish briefly; the parent receives the result automatically.

# Debugger restart contract v1

`gateway.debugger_restart` restarts one configured `x32dbg` or `x64dbg` host by
invoking its exact absolute lifecycle controller without a shell.

The call requires `backendId`, `expectedInstanceId`, and a fresh UUID
`operationId`; `force` defaults to false. The Gateway verifies the current
backend instance before dispatch, permits one lifecycle operation per backend,
and retains bounded operation results so a repeated operation ID is replayed
instead of restarting twice. A reused ID with different arguments is rejected.
An observed `absent` debuggee permits the controller's exact-process fallback;
otherwise destructive fallback requires explicit `force`.

Successful output contains the previous process, new process, and new backend
instance identity. Timeout or lost controller output is never retried. The
Gateway may perform one read-only status reconciliation; a ready instance
different from the expected instance is returned as success with
`outcomeReconciled = true`. Otherwise the outcome remains unknown. Restart
orchestration has a hard ceiling under 60 seconds, including reconciliation.

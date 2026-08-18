# MCP Session

The skill's only network I/O happens through `McpSession`, a
JSON-RPC stdio client that talks to `comfyui-mcp` (the standard
[comfyui-mcp MCP server](https://github.com/artokun/comfyui-mcp)).

## Why a subprocess

`comfyui-mcp` is a Node.js MCP server. It speaks the
[Model Context Protocol](https://modelcontextprotocol.io) over stdio.
Rather than re-implementing the JSON-RPC transport in Python from
scratch, the skill spawns the MCP server as a subprocess and speaks
the protocol over its stdin/stdout.

The alternative — talking to ComfyUI's HTTP API directly — would
require reverse-engineering each endpoint, parsing response shapes
per endpoint, and re-implementing the upload flow. The MCP server
exposes 40+ tools with structured schemas, all reachable through one
JSON-RPC client.

## Session lifecycle

```python
from camera_multiview import McpSession

with McpSession(
    comfyui_url="http://127.0.0.1:8188",
    request_timeout=60.0,
    poll_interval=2.0,
    total_timeout=1800.0,
) as session:
    result = session.enqueue(graph)
    outputs = session.wait_for_outputs(result.prompt_id)
    data = session.get_image(filename)
```

`McpSession.start()`:
1. Resolves `comfyui-mcp` via `shutil.which` (Windows `.cmd` shim compatible).
2. Spawns the subprocess with `CREATE_NO_WINDOW` (Windows) so no
   console window pops up.
3. Sets `COMFYUI_URL` in the subprocess environment.
4. Spawns two daemon threads: stdout reader and stderr forwarder.
5. Sends `initialize` + `notifications/initialized` to complete the
   MCP handshake.
6. Returns. The session is now ready for `tools/call`.

`McpSession.close()` (called automatically by `__exit__`):
1. Sends `SIGTERM` to the subprocess.
2. Waits up to 5s for clean exit; `SIGKILL`s if needed.

## JSON-RPC details

Every `tools/call` is a synchronous request:

```json
{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {
  "name": "upload_image",
  "arguments": {"action": "image", "source_path": "C:/x.png"}
}}
```

The response is either a success with a `result.content[]` array (each
entry is `{"type": "text", "text": "..."}` or `{"type": "image", ...}`)
or an `error: {code, message}`.

The reader thread populates per-id buffers:
- `_responses[id]` on success
- `_errors[id]` on error
- `_eof` set to `True` if the subprocess's stdout closes

The caller (`_call`) blocks on `_response_event` with a deadline,
checks `_eof` first (to surface immediate subprocess crashes), then
looks up the id, and returns.

## `tools/call` routing

The MCP server advertises a "Retired-name redirect" feature that
suggests direct method names like `upload_image` would auto-route to
`tools/call`. **This does not work** in the version we tested
(comfyui-mcp 0.51.56). The skill always uses `tools/call` explicitly:

```python
# This works:
self._call("tools/call", {
    "name": "upload_image",
    "arguments": {"action": "image", "source_path": source_path},
})
# This does NOT work (returns "Method not found"):
self._call("upload_image", {"action": "image", "source_path": source_path})
```

## Required `action` parameter

`enqueue_workflow` is an action-parameterized tool. Calling it without
`action` returns `Input validation error: Invalid arguments for tool
enqueue_workflow: ... "action": expected one of "enqueue"|"rerun"|...`.

The skill always passes `action="enqueue"`.

## Upload response shape

The modern upload response (comfyui-mcp ≥ 0.49.0):

```json
{
  "content": [
    {"type": "text", "text": "Uploaded via HTTP.\n\nFilename: full_body_input.png\n\nUse \"full_body_input.png\" as the `image` input in LoadImage nodes."}
  ]
}
```

`UploadResult.from_value` parses this:

1. If the value is a string, look for `Filename: <name>`.
2. If the value is a dict with a `content` list, find the first text
   block and extract the filename.
3. If the value is a dict with `name`/`subfolder` directly (legacy),
   use those.

The result is `UploadResult(name, subfolder)`. `subfolder` is non-empty
only if the upload was placed in a sub-directory of ComfyUI's
`input/` (which we don't do — the skill always uses the root).

## `enqueue` response shape

```json
{
  "content": [
    {"type": "text", "text": "{\n  \"status\": \"enqueued\",\n  \"prompt_id\": \"a9d507de-...\",\n  \"queue_remaining\": 2\n}"}
  ]
}
```

`EnqueueResult.from_value` parses the JSON text block and extracts
`prompt_id`. Older responses used `prompt_id: <uuid>` lines; the
parser falls back to a regex on those.

## `wait_for_outputs` history polling

`wait_for_outputs(prompt_id, *, poll_interval, total_timeout)` polls
ComfyUI's `/history/<prompt_id>` endpoint directly (bypassing MCP —
the `get_history` MCP tool wraps the response in markdown that
mangles the JSON).

Polling terminates when `status.status_str` is one of:
- `success` → returns `RunOutputs(status="success", outputs=...)`
- `error` or `failed` → returns `RunOutputs(status="error", error_messages=...)`

Timeout raises `McpError(f"timed out after {total_timeout}s waiting for prompt_id={prompt_id}")`.

## EOF detection

If the `comfyui-mcp` subprocess crashes mid-run (e.g. it OOMs, or
the user kills the process), the stdout reader thread reaches EOF on
its `readline()` call. The reader sets `_eof = True` and signals
`_response_event`. The next `_call()` invocation checks `_eof` first
and surfaces the error immediately, without waiting for the
per-call timeout.

Without this, a crashed subprocess would make the skill hang for
`request_timeout` (60s default) on every subsequent call.

## What `McpSession` does not own

- The actual `enqueue` and `wait_for_outputs` operations happen on
  ComfyUI directly. `McpSession` is just the RPC transport.
- The asset bundle (workflow JSON + manifest + poses) is verified
  by `assets.verify_assets()` before any MCP call.
- The graph build is a pure local operation; the patched graph is
  passed to `enqueue` as a single argument.
- The artifact download path is a direct HTTP call to ComfyUI's
  `/view` endpoint, not through MCP.

## Why a new session per run (not a long-lived one)

Each `McpSession` spawns a fresh `comfyui-mcp` subprocess. The
subprocess is stateful (it tracks ComfyUI generations, generation
db, etc.); reusing it across runs is fragile if a prior run left
it in a bad state. A new session per run costs ~1.5s cold start
against an 8-minute workflow run — noise.
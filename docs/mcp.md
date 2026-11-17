# MCP and API access

containr runs a [Model Context Protocol](https://modelcontextprotocol.io) server at `/mcp` on the dashboard address. With it, AI assistants such as Claude Code, Cursor, Claude Desktop and VS Code can list, create, deploy, configure, debug and delete services. The same API tokens also work for scripts that call the REST API.

The **MCP & API** page in the dashboard has the endpoint URL, ready-made client snippets, token management and the full tool list.

## Tokens

Create a token on the MCP & API page. It looks like `ctr_…`. It is shown once, and containr stores only its SHA-256 hash.

- **Full access** tokens can do anything the owning account can. For an admin, that includes server settings, users and updates.
- **Read-only** tokens can only make `GET` requests and only see read-only MCP tools.
- Tokens can expire after a set number of days, or never.
- Revoking a token takes effect on the next request.
- A token can't create other tokens or change the account's password. You have to sign in to the dashboard for that.

Send the token as a bearer token:

```sh
curl -H "Authorization: Bearer ctr_…" https://containr.example.com/api/services
```

The old `containr generate-api-key` command still works. It prints a long-lived JWT that you can't revoke one by one, so prefer tokens.

## Connecting a client

The endpoint uses the Streamable HTTP transport. It answers with plain JSON and doesn't open an SSE stream.

Claude Code:

```sh
claude mcp add --transport http containr https://containr.example.com/mcp \
  --header "Authorization: Bearer ctr_…"
```

Cursor (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "containr": {
      "url": "https://containr.example.com/mcp",
      "headers": { "Authorization": "Bearer ctr_…" }
    }
  }
}
```

VS Code (`.vscode/mcp.json`):

```json
{
  "servers": {
    "containr": {
      "type": "http",
      "url": "https://containr.example.com/mcp",
      "headers": { "Authorization": "Bearer ctr_…" }
    }
  }
}
```

Claude Desktop needs the `mcp-remote` bridge. The dashboard has the snippet.

## Tools

The tools are generated at startup from the OpenAPI document (`/api/docs`). Every documented endpoint becomes a tool named after its operation, so new endpoints show up for assistants without extra work. Path and query parameters are top-level arguments, and a JSON request body goes under `body`. Responses come back as JSON text. Error responses set `isError` and include the HTTP status.

Some endpoints aren't exposed: sign-in and OAuth flows, password changes, token management, multipart uploads, backup downloads and websocket endpoints. The `EXCLUDED` list is in `crates/containr-api/src/mcp/tools.rs`.

`api_request` calls any `/api/` endpoint that has no dedicated tool. It refuses the same sensitive paths.

`exec_command` runs `/bin/sh -c <command>` once in a container you own. It returns the exit code, stdout and stderr, and it times out after 60 seconds by default (300 at most). It's also available as `POST /api/containers/{id}/exec`.

## How it works

`crates/containr-api/src/handlers/api_tokens.rs` has a middleware that runs in front of every route. It swaps a valid `ctr_` token for a short-lived session JWT, so existing handlers accept tokens without changes. The middleware also blocks writes from read-only tokens.

`crates/containr-api/src/mcp/` handles the JSON-RPC methods (`initialize`, `ping`, `tools/list`, `tools/call`). It sends each tool call through the API router as an internal request with the caller's credentials, so the API's own permission checks always apply.

To improve a tool's description, edit the `DESCRIPTIONS` table in `mcp/tools.rs`. It's keyed by operation id.

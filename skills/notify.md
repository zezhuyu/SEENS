---
description: Send a notification to the SEENS widget. Prefer the mcp__seens-notify__notify tool — it auto-detects the port and delivers the notification in one step. Fall back to curl only if the MCP tool is unavailable.
allowed-tools: mcp__seens-notify__notify, Bash
---

Send a notification to the SEENS widget app running on this machine.

## Primary method — MCP tool (preferred)

Call `mcp__seens-notify__notify` directly with:

| Parameter | Required | Description |
|-----------|----------|-------------|
| `title`   | yes | Short headline, under 60 chars |
| `message` | yes | 1–3 sentences on what happened or what needs attention |
| `type`    | no  | `info` · `success` · `warning` · `error` (defaults to `info`) |
| `link`    | no  | URL to open when the user clicks the notification |

The tool auto-detects the SEENS port, POSTs to `/api/notify`, and confirms delivery.

## Fallback — curl (if MCP tool is unavailable)

```bash
PORT=$(lsof -iTCP -sTCP:LISTEN -P 2>/dev/null | awk '/node|electron/{print $9}' | grep -oE '[0-9]+$' | head -1)
curl -s -X POST "http://localhost:${PORT:-7477}/api/notify" \
  -H "Content-Type: application/json" \
  -d '{"title":"…","message":"…","type":"info"}'
```

## When to send notifications

- A long-running task finished (success or failure)
- A build, test run, or sync completed
- A subscription, token, or credential is expiring
- A background process needs the user's attention
- You want to surface a finding without interrupting their focus

## Type guide

- `success` — task completed, build passed, sync done
- `warning` — something needs attention but isn't broken yet
- `error` — something failed and may need action
- `info` — neutral update, reminder, or FYI

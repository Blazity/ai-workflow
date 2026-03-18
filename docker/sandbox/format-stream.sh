#!/bin/bash
# format-stream.sh — Formats Claude Code stream-json output for human-readable docker logs.
# Reads newline-delimited JSON from stdin, outputs timestamped human-readable lines.
# For "result" events, also passes through the raw JSON so parseAgentOutput can find it.
# Handles non-JSON lines gracefully (passes them through as-is).
#
# Actual stream-json event shapes (from Claude Code --print --verbose --output-format stream-json):
#
#   assistant:  { "type": "assistant", "message": { "content": [{ "type": "text", "text": "..." }, { "type": "tool_use", "name": "Edit", "input": {...} }] } }
#   tool_result: { "type": "tool_result", "tool_use_id": "...", "content": "...", "is_error": false }
#   user:       { "type": "user", ... }  (auto-generated tool result turns)
#   system:     { "type": "system", "subtype": "init"|"hook_started"|... }
#   result:     { "type": "result", "subtype": "success", "result": "...", "structured_output": {...} }

while IFS= read -r line; do
  parsed=$(echo "$line" | jq -r '
    if type != "object" then
      empty
    elif .type == "assistant" then
      # Extract text and tool_use blocks from message.content[]
      (.message.content // []) | map(
        if .type == "text" then
          "assistant: " + (.text | .[0:300])
        elif .type == "tool_use" then
          "tool_use: " + .name + "(" + (.input | keys | join(", ")) + ")"
        else
          empty
        end
      ) | join("\n")
    elif .type == "tool_result" then
      "tool_result: " + (if .is_error then "ERROR: " + (.content | tostring | .[0:200]) else "ok" end)
    elif .type == "result" then
      "result: " + (.structured_output.result // .subtype // "unknown")
    elif .type == "system" then
      if .subtype == "init" then
        "system: initialized (model: " + (.model // "unknown") + ")"
      elif .subtype == "hook_started" then
        empty
      elif .subtype == "hook_response" then
        empty
      else
        "system: " + (.subtype // "unknown")
      end
    elif .type == "user" then
      empty
    elif .type == "rate_limit_event" then
      empty
    else
      .type
    end
  ' 2>/dev/null)

  ts=$(date +"%H:%M:%S")

  if [ -n "$parsed" ]; then
    # parsed may contain multiple lines (from assistant events with text + tool_use)
    while IFS= read -r out_line; do
      [ -n "$out_line" ] && echo "[$ts] $out_line"
    done <<< "$parsed"
    # For result events, also emit the raw JSON for parseAgentOutput
    is_result=$(echo "$line" | jq -r 'if .type == "result" then "yes" else "no" end' 2>/dev/null)
    if [ "$is_result" = "yes" ]; then
      echo "$line"
    fi
  fi
  # Non-JSON lines and empty parsed results are silently dropped
done

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
  ts=$(date +"%H:%M:%S")

  # Non-JSON lines: pass through as-is with timestamp
  if [[ "$line" != "{"* ]]; then
    [ -n "$line" ] && echo "[$ts] $line"
    continue
  fi

  # Single jq call: outputs formatted lines prefixed with __RESULT__ for result events
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
      "__RESULT__result: " + (.structured_output.result // .subtype // "unknown")
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

  if [ -z "$parsed" ]; then
    # jq produced no output (filtered event like user/rate_limit) — skip
    continue
  else
    is_result=false
    # parsed may contain multiple lines (from assistant events with text + tool_use)
    while IFS= read -r out_line; do
      # Strip __RESULT__ sentinel and flag for raw passthrough
      if [[ "$out_line" == __RESULT__* ]]; then
        out_line="${out_line#__RESULT__}"
        is_result=true
      fi
      [ -n "$out_line" ] && echo "[$ts] $out_line"
    done <<< "$parsed"
    # For result events, also emit the raw JSON for parseAgentOutput
    if [ "$is_result" = true ]; then
      echo "$line"
    fi
  fi
done

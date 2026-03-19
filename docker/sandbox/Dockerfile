FROM node:20-slim

RUN apt-get update && apt-get install -y git jq && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code

RUN useradd -m -s /bin/bash kasin-it
WORKDIR /workspace
RUN chown kasin-it:kasin-it /workspace

COPY entrypoint.sh /entrypoint.sh
COPY git-guard.sh /usr/local/bin/git
COPY commit-guard.sh /opt/blazebot/commit-guard.sh
COPY format-stream.sh /opt/blazebot/format-stream.sh
RUN chmod +x /entrypoint.sh /usr/local/bin/git /opt/blazebot/commit-guard.sh /opt/blazebot/format-stream.sh

RUN mkdir -p /home/kasin-it/.claude && \
    echo '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"/opt/blazebot/commit-guard.sh"}]}]}}' \
    > /home/kasin-it/.claude/settings.json && \
    chown -R kasin-it:kasin-it /home/kasin-it/.claude

USER kasin-it
ENTRYPOINT ["/entrypoint.sh"]

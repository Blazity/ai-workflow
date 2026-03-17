FROM node:20-slim

RUN apt-get update && apt-get install -y git jq && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code

RUN useradd -m -s /bin/bash blazebot
WORKDIR /workspace
RUN chown blazebot:blazebot /workspace

COPY entrypoint.sh /entrypoint.sh
COPY git-guard.sh /usr/local/bin/git
COPY commit-guard.sh /opt/blazebot/commit-guard.sh
RUN chmod +x /entrypoint.sh /usr/local/bin/git /opt/blazebot/commit-guard.sh

RUN mkdir -p /home/blazebot/.claude && \
    echo '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"/opt/blazebot/commit-guard.sh"}]}]}}' \
    > /home/blazebot/.claude/settings.json && \
    chown -R blazebot:blazebot /home/blazebot/.claude

USER blazebot
ENTRYPOINT ["/entrypoint.sh"]

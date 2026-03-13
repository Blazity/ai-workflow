FROM node:20-slim

RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code

RUN useradd -m -s /bin/bash blazebot
WORKDIR /workspace
RUN chown blazebot:blazebot /workspace

COPY entrypoint.sh /entrypoint.sh
COPY git-guard.sh /usr/local/bin/git
RUN chmod +x /entrypoint.sh /usr/local/bin/git

USER blazebot
ENTRYPOINT ["/entrypoint.sh"]

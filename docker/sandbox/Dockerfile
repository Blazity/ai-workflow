FROM node:20-slim

RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /workspace

COPY entrypoint.sh /entrypoint.sh
COPY git-guard.sh /usr/local/bin/git
RUN chmod +x /entrypoint.sh /usr/local/bin/git

ENTRYPOINT ["/entrypoint.sh"]

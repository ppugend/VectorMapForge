FROM oven/bun:alpine
RUN apk add --no-cache docker-cli curl tar unzip
WORKDIR /app
COPY package.json ./
RUN bun install

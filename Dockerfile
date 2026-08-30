# The persona console runs the CLIs as child processes (npx tsx) and shells out
# to ffmpeg, so this image keeps the source, the dev deps, and ffmpeg.
FROM node:22-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=development

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN cp -r examples seed-examples

# Pre-build the browser bundle so the first call screen does not wait on it.
RUN npm run build:vendor

ENV PORT=8080
EXPOSE 8080
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["npx", "tsx", "src/server/index.ts"]

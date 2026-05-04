FROM node:20-alpine

# Build deps for native modules (sharp / onnxruntime / tree-sitter grammars).
# Installed as root because apk needs it; dropped at runtime via USER below.
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm ci --legacy-peer-deps

COPY . .
RUN npm run build

# Phase 3A (Zero Trust): drop root for runtime. The base node:20-alpine
# image already ships a non-root `node` user (uid 1000). chown the
# workdir so the runtime user can read its own build output and write
# the few transient files `migration:run` touches. Build steps above
# stayed as root because apk + native compilation need it.
RUN chown -R node:node /app
USER node

EXPOSE 3001

CMD ["sh", "-c", "npm run migration:run && npm run start:prod"]

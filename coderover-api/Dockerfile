FROM node:20-alpine

# Build deps for native modules (sharp / onnxruntime / tree-sitter grammars).
# Installed as root because apk needs it. Note: kept in the final image
# today because `npm run migration:run` shells out to ts-node and needs
# devDeps + src/ at runtime — moving to a multi-stage build requires
# pre-compiling migrations to JS first, tracked as a follow-up.
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Phase 3A (Zero Trust): drop root BEFORE any app file lands so we never
# need a separate `chown -R /app` layer (which would duplicate every
# file in the image with new ownership metadata, bloating the image).
# Subsequent COPYs use `--chown=node:node` to land files pre-owned, and
# `npm ci` runs as node so node_modules is owned correctly at creation.
RUN chown node:node /app
USER node

COPY --chown=node:node package*.json ./
RUN npm ci --legacy-peer-deps

COPY --chown=node:node . .
RUN npm run build

EXPOSE 3001

# `exec` ensures the node process replaces the shell as PID 1 and
# receives SIGTERM directly when the container stops, instead of the
# shell swallowing the signal and forcing a kill timeout. We also drop
# the `npm run start:prod` wrapper so node is genuinely PID 1 — `npm`
# would otherwise sit between PID 1 and the actual node process and
# delay signal forwarding.
CMD ["sh", "-c", "npm run migration:run && exec node dist/main"]

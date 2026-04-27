FROM node:25-alpine

WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci --legacy-peer-deps

COPY . .
RUN npm run build

EXPOSE 3001

CMD ["sh", "-c", "npm run migration:run && npm run start:prod"]

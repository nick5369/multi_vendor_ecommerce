FROM node:20.17-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY tsconfig.json nest-cli.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:20.17-alpine
RUN apk add --no-cache curl
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 3001
CMD ["node", "dist/main.js"]

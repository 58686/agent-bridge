FROM node:20-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY projects ./projects
COPY examples ./examples
COPY docs ./docs
COPY README.md LICENSE ./
EXPOSE 3000
CMD ["node", "dist/server-main.js", "--host", "0.0.0.0", "--port", "3000"]

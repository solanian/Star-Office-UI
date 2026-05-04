FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
WORKDIR /app
COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=19000
ENV STAR_OFFICE_DATA_DIR=/data

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/build ./build
COPY --from=build /app/frontend ./frontend
COPY --from=build /app/assets ./assets
COPY --from=build /app/join-keys.sample.json ./join-keys.sample.json
COPY --from=build /app/asset-defaults.json ./asset-defaults.json
COPY --from=build /app/asset-positions.json ./asset-positions.json
COPY --from=build /app/state.sample.json ./state.sample.json

RUN mkdir -p /data && chown -R node:node /app /data
USER node

EXPOSE 19000
VOLUME ["/data"]

CMD ["node", "build/index.js"]

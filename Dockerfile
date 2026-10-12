# Single image serving the REST API and the web app.
FROM node:24-alpine AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=4000 \
    DB_FILE=/data/app.db \
    UPLOAD_DIR=/data/uploads
COPY backend/package.json backend/package-lock.json backend/
RUN cd backend && npm ci --omit=dev
COPY backend/ backend/
COPY --from=web /app/web/dist web/dist
EXPOSE 4000
VOLUME /data
HEALTHCHECK CMD wget -qO- http://127.0.0.1:4000/api/health || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "backend/src/server.js"]

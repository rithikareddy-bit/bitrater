# Build from video-q-lab root (lockfile lives in dashboard/):
#   docker build -f dashboard/Dockerfile -t <ecr>/chai-q-dashboard:latest .
FROM node:20-alpine AS deps
WORKDIR /app
COPY dashboard/package.json dashboard/package-lock.json ./
RUN npm ci

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY dashboard/ .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm install --os=linux --cpu=x64 @next/swc-linux-x64-musl@14 2>/dev/null; npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

EXPOSE 3000
CMD ["sh", "-c", "HOSTNAME=0.0.0.0 node server.js"]

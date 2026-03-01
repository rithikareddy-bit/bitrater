# v4 — fix db name (production→master), use s3_url from showcache episodes,
#       so we force it via sh -c to ensure Next.js binds on 0.0.0.0
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

EXPOSE 3000
# Force HOSTNAME=0.0.0.0 at process level so Next.js binds all interfaces,
# even though the container runtime overrides the HOSTNAME env var.
CMD ["sh", "-c", "HOSTNAME=0.0.0.0 node server.js"]

# Imagen de producción para Dokploy.
#
# Dos etapas: `builder` compila (necesita devDependencies, toolchain de C++ para
# bcrypt y el cliente de Prisma generado), `runner` solo corre.
#
# Base Debian slim y no Alpine a propósito: Prisma y bcrypt traen binarios
# nativos linkeados contra glibc. En Alpine (musl) hay que pelear con
# `openssl-dev`, `libc6-compat` y variantes de engine; no vale la pena para
# ahorrar 40 MB en un VPS.

# ── Base común ───────────────────────────────────────────────────────────────
FROM node:22-slim AS base
WORKDIR /app
# openssl lo necesita el query engine de Prisma en runtime.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# ── Build ────────────────────────────────────────────────────────────────────
FROM base AS builder
# Explícito: si quedara en 'production', `npm ci` omitiría las devDependencies
# y no habría ni tsc ni prisma para compilar.
ENV NODE_ENV=development
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

# El cliente de Prisma se genera contra el schema, antes de compilar: el código
# TypeScript importa tipos que salen de esta generación.
COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM base AS runner
ENV NODE_ENV=production
ENV PORT=3000

# Se copia node_modules entero del builder en vez de reinstalar con
# --omit=dev. Es una imagen más grande, pero garantiza que el binario nativo de
# bcrypt y el engine de Prisma sean exactamente los que se compilaron acá, y
# deja disponible el CLI de Prisma que el entrypoint necesita para migrar.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY package.json ./
COPY docker-entrypoint.sh ./

RUN chmod +x docker-entrypoint.sh && chown -R node:node /app
# La imagen de node ya trae el usuario `node` sin privilegios.
USER node

EXPOSE 3000

# Node 22 trae fetch global: no hace falta meter curl en la imagen.
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["./docker-entrypoint.sh"]

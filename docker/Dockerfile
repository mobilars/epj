# syntax=docker/dockerfile:1

FROM node:22-alpine AS bygg
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine AS kjor
WORKDIR /app
ENV NODE_ENV=production

# Kjører som ikke-privilegert bruker.
RUN addgroup -S epj && adduser -S epj -G epj

# `build/` inneholder både applikasjonen og de frittstående verktøyene
# (build/verktoy/migrer.js, build/verktoy/seed.js).
COPY --from=bygg --chown=epj:epj /app/build ./build
COPY --from=bygg --chown=epj:epj /app/node_modules ./node_modules
COPY --from=bygg --chown=epj:epj /app/package.json ./package.json
# Migrasjonene leses fra disk ved oppstart.
COPY --from=bygg --chown=epj:epj /app/src/lib/server/db/migrations ./src/lib/server/db/migrations

USER epj
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://localhost:3000/api/helse').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "build/index.js"]

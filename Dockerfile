FROM node:20-bookworm-slim

WORKDIR /app

# ── Python til CMEMS-strømdata ───────────────────────────────────────────────
# Alpine er droppet til fordel for Debian (bookworm), fordi
# copernicusmarine-pakkens afhængigheder (xarray, zarr, dask, netCDF4 m.fl.)
# er langt mere pålidelige at installere som færdige wheels på glibc/Debian
# end på musl/Alpine, hvor flere af dem må kompileres fra kildekode.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 \
      python3-pip \
    && rm -rf /var/lib/apt/lists/*

# copernicusmarine installeres separat (layer-cache) — sjældent ændret
COPY requirements.txt ./
RUN pip install --break-system-packages --no-cache-dir -r requirements.txt

# Install Node-afhængigheder (layer cache) — npm ci (ikke install) for et
# reproducerbart build, der nøjagtigt matcher package-lock.json.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# RETTET: denne fil-for-fil COPY-liste var netop den slags der forårsagede
# en produktionsudfald — server.js kræver et dusin+ lokale moduler
# (tenant-admin.js, sso-handoff.js, db.js, risk-model.js, osv.), og enhver
# ny fil, der glemmes her, crasher containeren øjeblikkeligt ved opstart
# (require() af en fil der ikke findes i imaget). "COPY . ." kopierer HELE
# build-konteksten (styret af .dockerignore) i stedet, så en ny fil i
# repoet automatisk følger med i næste build — ingen liste at vedligeholde
# eller glemme.
COPY . .

EXPOSE 8080

ENV PORT=8080
ENV NODE_ENV=production
ENV PYTHON_BIN=python3

CMD ["node", "server.js"]

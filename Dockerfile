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

# Install Node-afhængigheder (layer cache)
COPY package.json ./
RUN npm install --omit=dev

# Copy application files
COPY server.js ./
COPY fetch_currents.py ./
COPY dansk-overloeb-kort.html ./
COPY puls-data.json ./
COPY overloeb-sw.js ./

# VP3 geodata (kystvande, badevandsområder, RBU-punkter)
COPY vp3_kystvande_simplified.geojson ./
COPY vp3_badevand.geojson ./
COPY vp3_rbu_slim.geojson ./
COPY vp3_soeer.geojson ./
COPY vp3_vandlob.geojson ./

EXPOSE 8080

ENV PORT=8080
ENV NODE_ENV=production
ENV PYTHON_BIN=python3

CMD ["node", "server.js"]

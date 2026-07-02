FROM node:20-alpine

WORKDIR /app

# Install dependencies first (layer cache)
COPY package.json ./
RUN npm install --omit=dev

# Copy application files
COPY server.js ./
COPY dansk-overloeb-kort.html ./
COPY puls-data.json ./
COPY overloeb-sw.js ./

# VP3 geodata (kystvande, badevandsområder, RBU-punkter)
COPY vp3_kystvande_simplified.geojson ./
COPY vp3_badevand.geojson ./
COPY vp3_rbu_slim.geojson ./

EXPOSE 8080

ENV PORT=8080
ENV NODE_ENV=production

CMD ["node", "server.js"]

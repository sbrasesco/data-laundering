FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY *.mjs ./

CMD ["node", "worker.mjs"]

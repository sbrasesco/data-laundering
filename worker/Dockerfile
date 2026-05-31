FROM node:20-alpine

# Herramientas para procesamiento ZIP + PDF (igual que el container de n8n)
RUN apk add --no-cache \
    p7zip \
    poppler-utils \
    mupdf-tools \
    wget

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY *.mjs ./

CMD ["node", "worker.mjs"]

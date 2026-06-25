FROM node:20-alpine

# Herramientas para procesamiento ZIP + PDF
RUN apk add --no-cache \
    7zip \
    libarchive-tools \
    poppler-utils \
    mupdf-tools \
    wget \
    python3 \
    py3-pip

# PyMuPDF — extracción de adjuntos PDF más robusta que pdfdetach+mutool (DT-009)
RUN pip3 install pymupdf --break-system-packages

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY *.mjs ./
COPY extract_attachments.py ./

CMD ["node", "worker.mjs"]

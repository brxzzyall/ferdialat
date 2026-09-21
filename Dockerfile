FROM node:18-slim

# Install Chromium dan dependensi sistem Linux
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# Berikan izin akses folder sesi WhatsApp agar tidak error di Hugging Face
RUN chmod -R 777 /app

EXPOSE 7860
CMD [ "node", "index.js" ]

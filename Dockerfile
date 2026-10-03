# Use an official Node.js runtime
FROM node:18-bullseye-slim

# Install necessary system dependencies (ffmpeg for media, python3 for yt-dlp compatibility)
RUN apt-get update && apt-get install -y \
    python3 \
    ffmpeg \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Hugging Face Spaces mandates running as a non-root user (UID 1000)
RUN useradd -m -u 1000 user
USER user
ENV HOME=/home/user \
    PATH=/home/user/.local/bin:$PATH

# Set the working directory
WORKDIR $HOME/app

# Copy package files and install dependencies
COPY --chown=user package*.json ./
RUN npm install

# Copy the rest of the application code
COPY --chown=user . .

# Hugging Face Spaces automatically routes traffic to port 7860
ENV PORT=7860
EXPOSE 7860

# Start the Node.js server
CMD ["node", "server.js"]

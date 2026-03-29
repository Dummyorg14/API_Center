FROM node:20-alpine

WORKDIR /app

# Install and build SDK first
COPY sdk/package*.json ./sdk/
COPY sdk/tsconfig.json ./sdk/
COPY sdk/src ./sdk/src
WORKDIR /app/sdk
RUN npm install && npm run build

# Install demand-service with SDK dependency
WORKDIR /app
COPY demand-service/package*.json ./
# Install dependencies including the local SDK
RUN npm install && npm install --save file:./sdk

COPY demand-service/tsconfig.json ./
COPY demand-service/src ./src

EXPOSE 4100
CMD ["npm", "run", "start"]

FROM node:20-alpine

WORKDIR /app

# Copy root-level package files first (for monorepo structure)
COPY logistics-service/package*.json ./
RUN npm install

# Copy tsconfig and source
COPY logistics-service/tsconfig.json ./
COPY logistics-service/src ./src

EXPOSE 4000
CMD ["npm", "run", "start"]

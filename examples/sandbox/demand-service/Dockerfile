FROM node:20-alpine

WORKDIR /app

COPY demand-service/package*.json ./
COPY sdk ../sdk
RUN npm install

COPY demand-service/tsconfig.json ./
COPY demand-service/src ./src

EXPOSE 4100
CMD ["npm", "run", "start"]

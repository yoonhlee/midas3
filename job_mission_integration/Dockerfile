FROM node:22-alpine

RUN apk add --no-cache python3

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

EXPOSE 8080

CMD ["npm", "start"]

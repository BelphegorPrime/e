FROM node:lts-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

# Install TypeScript globally for compilation
RUN npm install -g typescript

COPY . .

# Build TypeScript files
RUN npm run build:ts

EXPOSE 3000

CMD ["npm", "start"]

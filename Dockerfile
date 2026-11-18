FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
ENV NODE_ENV=production
# شغّال كـ root عن قصد: Volume بتاع Railway بيتركّب بصلاحيات root
EXPOSE 3000
CMD ["node","server.js"]

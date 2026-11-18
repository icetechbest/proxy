FROM node:20-alpine
WORKDIR /app
COPY . .
RUN chown -R node:node /app
ENV NODE_ENV=production PORT=3000 TRUST_PROXY=1
USER node
EXPOSE 3000
HEALTHCHECK CMD wget -qO- http://localhost:3000/health || exit 1
CMD ["node","server.js"]

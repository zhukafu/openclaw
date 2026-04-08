FROM node:18-alpine

# 工作目录
WORKDIR /usr/src/app

# 安装依赖（先复制 package.json / package-lock.json 以利用缓存）
COPY package*.json ./

# 使用 npm ci 保证一致性
RUN npm ci --only=production

# 复制应用代码
COPY . .

# 授权并切换到非 root 用户（可选）
RUN chown -R node:node /usr/src/app
USER node

# 暴露代理与静态页面端口
EXPOSE 801 8080

# 默认运行代理（proxy-server.js）
CMD ["npm", "start"]

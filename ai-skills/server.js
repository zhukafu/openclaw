/**
 * 简单的HTTP服务器，用于提供前端界面
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");

const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = __dirname;

// MIME类型映射
const mimeTypeMap = {
  ".html": "text/html",
  ".htm": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".pdf": "application/pdf",
};

const server = http.createServer((req, res) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);

  // 解析请求的URL
  const parsedUrl = url.parse(req.url);
  let pathname = parsedUrl.pathname;

  // 默认指向 login.html（页面会根据 localStorage 中的登录状态重定向到 simple-upload.html）
  if (pathname === "/") {
    pathname = "/login.html";
  }

  // 兼容常见favicon请求：将 /favicon.ico 指向 /favicon.svg
  if (pathname === "/favicon.ico") {
    const icoPath = path.join(PUBLIC_DIR, "favicon.ico");
    const svgPath = path.join(PUBLIC_DIR, "favicon.svg");
    if (fs.existsSync(icoPath)) {
      pathname = "/favicon.ico";
    } else if (fs.existsSync(svgPath)) {
      pathname = "/favicon.svg";
    }
  }

  // 构建文件路径
  const filePath = path.join(PUBLIC_DIR, pathname);

  // 检查路径是否尝试访问父目录
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("403 Forbidden");
    return;
  }

  // 获取文件扩展名
  const ext = path.parse(filePath).ext.toLowerCase();
  const contentType = mimeTypeMap[ext] || "application/octet-stream";

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === "ENOENT") {
        // 文件未找到
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("404 Not Found");
      } else {
        // 其他错误
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end(`Server Error: ${err.code}`);
      }
    } else {
      // 成功读取文件
      res.writeHead(200, { "Content-Type": contentType });
      res.end(content, "utf-8");
    }
  });
});

server.listen(PORT, () => {
  console.log(`服务器运行在 http://localhost:${PORT}`);
  console.log(`当前目录: ${PUBLIC_DIR}`);
  console.log("可用页面:");
  console.log(`- http://localhost:${PORT}/login.html`);
  console.log(`- http://localhost:${PORT}/simple-upload.html`);
  console.log("\n按 Ctrl+C 停止服务器");
});

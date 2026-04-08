# 阿里云制品仓库工具

这是一个 Node.js 工具，用于上传文件和获取阿里云制品仓库的免密下载链接。

## 功能特性

- 上传文件到阿里云制品仓库
- 从阿里云制品仓库下载文件
- 获取临时免密下载链接

## 安装依赖

```bash
npm install
```

## 使用方法

### 上传文件

```bash
# 使用独立脚本
node upload.js --local-file ./test.txt --remote-path a/b/c --version 1.0.0 --file-name test.txt --description "测试文件"

# 或使用主程序
node index.js upload --local-file ./test.txt --remote-path a/b/c --version 1.0.0 --file-name test.txt --description "测试文件"
```

### 下载文件

```bash
# 使用独立脚本
node download.js --remote-file-path a/b/c/test.txt --version 1.0.0 --output-path ./downloaded_test.txt

# 或使用主程序
node index.js download --remote-file-path a/b/c/test.txt --version 1.0.0 --output-path ./downloaded_test.txt
```

### 获取免密下载链接

```bash
# 使用独立脚本
node getDownloadLink.js --remote-file-path a/b/c/test.txt --version 1.0.0 --expiration-days 7

# 或使用主程序
node index.js get-download-link --remote-file-path a/b/c/test.txt --version 1.0.0 --expiration-days 7
```

## 命令行选项

### 上传文件 (upload)

- `--local-file, -f`: 本地文件路径 (必需)
- `--remote-path, -r`: 远程制品文件路径（不包含文件名）(必需)
- `--version, -v`: 上传版本号 (必需)
- `--file-name, -n`: 制品名称（可选，默认使用本地文件名）
- `--description, -d`: 制品描述（可选）

### 下载文件 (download)

- `--remote-file-path, -r`: 远程文件路径（包含文件名）(必需)
- `--version, -v`: 制品版本号 (必需)
- `--output-path, -o`: 输出文件路径 (必需)

### 获取免密下载链接 (get-download-link)

- `--remote-file-path, -r`: 远程文件路径（包含文件名）(必需)
- `--version, -v`: 制品版本号 (必需)
- `--expiration-days, -e`: 链接过期天数（默认7天）(可选)

## API 接口

你也可以在代码中直接使用 `AliyunPackageAPI` 类：

```javascript
const AliyunPackageAPI = require("./AliyunPackageAPI");

const api = new AliyunPackageAPI();

// 上传文件
const uploadResult = await api.uploadFile(
  "a/b/c", // 远程路径
  "1.0.0", // 版本
  "./local_file.txt", // 本地文件路径
);

// 下载文件
const success = await api.downloadFile(
  "a/b/c/file.txt", // 远程文件路径（包含文件名）
  "1.0.0", // 版本
  "./downloaded.txt", // 本地输出路径
);

// 获取免密下载链接
const linkInfo = await api.getDownloadLink(
  "a/b/c/file.txt", // 远程文件路径（包含文件名）
  "1.0.0", // 版本
  Date.now() + 7 * 24 * 60 * 60 * 1000, // 过期时间戳（7天后）
);
```

## 配置

所有配置都在 `config.js` 文件中，包括：

- API 基础 URL
- 认证信息（用户名和密码）
- API 端点

如需修改认证信息，请编辑 `config.js` 文件。

## 前端界面

项目还包含一个直观的前端界面，允许您通过网页直接上传文件或获取免密下载链接：

- `login.html` - 登录界面（已登录会自动跳转到工具页）
- `simple-upload.html` - 工具界面（上传/获取下载链接）
- `simple-upload.html` - 简化版界面，专注于上传和获取下载链接功能

由于浏览器的跨域限制（CORS），前端无法直接调用阿里云API，因此需要通过后端代理服务来处理请求。

## 后端代理服务

为了绕过浏览器的跨域限制，项目包含一个代理服务器：

- `proxy-server.js` - Express服务器，处理前端请求并转发到阿里云API

启动代理服务器：

```bash
npm run proxy
```

这将在 http://localhost:8081 上启动服务器，提供以下API端点：

- `/api/upload` - 上传文件
- `/api/download` - 下载文件
- `/api/get-download-link` - 获取免密下载链接
- `/api/compress` - 在本机创建压缩后台任务（上传单个 `file` 字段，表单字段 `quality`：`high|medium|low`，`format`：`mp4|webm`，可选 `outputFileName` 指定输出文件名）。
  - 每个上传文件会计算 SHA256 作为任务 ID（用于去重）。如果同一文件（相同哈希）已有任务在执行或已完成，会返回已有任务信息以避免重复压缩。
- `/api/compress/:taskId` - 查询单个任务状态（返回任务详情，包括 `status`：`compressing|done|failed`、`stderr`、`url` 等）。
  - `/api/compress/:taskId/events` - 使用 Server-Sent Events 订阅任务实时事件（发送 `progress`、`log`、`done` 和 `failed` 事件，便于前端显示实时进度与日志）。
- `/api/compressed-list` - 列出 `uploads/tasks.json` 中的任务（按更新时间排序），包含每个任务的状态、原始文件名、输出文件名、大小和下载 URL（仅当 `status=done` 时可用）。

启动后，可以直接在浏览器中访问 http://localhost:8081/simple-upload.html 来使用前端界面。 压缩页地址： `http://localhost:8081/compress.html`（页面支持填写输出文件名、查看并下载历史压缩文件，支持压缩任务查询与去重）。

启动后，可以直接在浏览器中访问 http://localhost:8081/simple-upload.html 来使用前端界面。

⚠️ 使用 `ffmpeg` 压缩功能前，请在项目根目录放置一个可执行的 `ffmpeg` 二进制（或在系统 PATH 中可调用 `ffmpeg`）。压缩页面地址： `http://localhost:8081/compress.html`

## 注意事项

1. 路径中不能出现 `&`、`?`、空格等特殊字符
2. 上传的文件路径不包含文件名，下载的文件路径包含文件名
3. 临时下载链接有过期时间限制

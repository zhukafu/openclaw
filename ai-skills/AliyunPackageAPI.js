const axios = require("axios");
const FormData = require("form-data");
const fs = require("fs");
const path = require("path");

const config = require("./config");

class AliyunPackageAPI {
  constructor() {
    this.baseUrl = config.baseUrl;
    this.auth = config.auth;
  }

  /**
   * 上传文件到阿里云制品仓库
   * @param {string} filePath - 制品文件路径
   * @param {string} version - 上传版本
   * @param {string} fileName - 制品名称（可选）
   * @param {string} versionDescription - 制品描述（可选）
   * @param {string} localFilePath - 本地文件路径
   * @returns {Promise<Object>} 上传结果
   */
  async uploadFile(filePath, version, localFilePath, fileName = null, versionDescription = null) {
    try {
      // 构建请求URL
      const urlPath = `/files/${filePath}`;
      const params = new URLSearchParams({
        version: version,
      });

      if (fileName) {
        params.append("fileName", fileName);
      }

      if (versionDescription) {
        params.append("versionDescription", versionDescription);
      }

      const url = `${this.baseUrl}${urlPath}?${params.toString()}`;

      // 创建FormData实例并添加文件
      const formData = new FormData();
      const fileBuffer = fs.readFileSync(localFilePath);
      const fileNameFromPath = fileName || path.basename(localFilePath);

      formData.append("file", fileBuffer, {
        filename: fileNameFromPath,
        contentType: this.getMimeType(localFilePath),
      });

      // 设置认证头
      const authHeader = `Basic ${Buffer.from(`${this.auth.username}:${this.auth.password}`).toString("base64")}`;

      // 发送请求
      const response = await axios.post(url, formData, {
        headers: {
          ...formData.getHeaders(),
          Authorization: authHeader,
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      });

      return response.data;
    } catch (error) {
      throw new Error(`上传文件失败: ${error.message}`, { cause: error });
    }
  }

  /**
   * 下载文件从阿里云制品仓库
   * @param {string} filePath - 文件路径（包含文件名称）
   * @param {string} version - 制品版本
   * @param {string} outputPath - 输出文件路径
   * @returns {Promise<boolean>} 下载是否成功
   */
  async downloadFile(filePath, version, outputPath) {
    try {
      // 构建请求URL
      const urlPath = `/files/${filePath}`;
      const params = new URLSearchParams({
        version: version,
      });

      const url = `${this.baseUrl}${urlPath}?${params.toString()}`;

      // 设置认证头
      const authHeader = `Basic ${Buffer.from(`${this.auth.username}:${this.auth.password}`).toString("base64")}`;

      // 发送请求
      const response = await axios.get(url, {
        headers: {
          Authorization: authHeader,
        },
        responseType: "stream",
      });

      // 创建输出目录（如果不存在）
      const outputDir = path.dirname(outputPath);
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      // 将响应流写入文件
      const writer = fs.createWriteStream(outputPath);
      response.data.pipe(writer);

      return new Promise((resolve, reject) => {
        writer.on("finish", () => resolve(true));
        writer.on("error", (err) => reject(err));
      });
    } catch (error) {
      throw new Error(`下载文件失败: ${error.message}`, { cause: error });
    }
  }

  /**
   * 获取临时免密下载链接
   * @param {string} filePath - 文件路径（包含文件名称）
   * @param {string} version - 制品版本
   * @param {number} expiration - 过期时间戳（毫秒）
   * @returns {Promise<Object>} 包含下载链接和其他元数据的对象
   */
  async getDownloadLink(filePath, version, expiration) {
    try {
      // 构建请求URL
      const urlPath = `/files/${filePath}`;
      const params = new URLSearchParams({
        version: version,
        signUrl: "true",
        expiration: expiration,
      });

      const url = `${this.baseUrl}${urlPath}?${params.toString()}`;

      // 设置认证头
      const authHeader = `Basic ${Buffer.from(`${this.auth.username}:${this.auth.password}`).toString("base64")}`;

      // 发送HEAD请求
      const response = await axios.head(url, {
        headers: {
          Authorization: authHeader,
        },
      });

      // 从响应头中提取信息
      const headers = response.headers;
      const result = {
        downloadUrl: headers["x-artlab-generic-sign-url"],
        sha1: headers["x-artlab-checksum-sha1"],
        sha256: headers["x-artlab-checksum-sha256"],
        md5: headers["x-artlab-checksum-md5"],
        versionDescription: headers["x-artlab-generic-version-description"],
      };

      return result;
    } catch (error) {
      throw new Error(`获取下载链接失败: ${error.message}`, { cause: error });
    }
  }

  /**
   * 获取文件MIME类型
   * @param {string} filePath - 文件路径
   * @returns {string} MIME类型
   */
  getMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      ".txt": "text/plain",
      ".html": "text/html",
      ".htm": "text/html",
      ".css": "text/css",
      ".js": "application/javascript",
      ".json": "application/json",
      ".xml": "application/xml",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".svg": "image/svg+xml",
      ".pdf": "application/pdf",
      ".zip": "application/zip",
      ".tar": "application/x-tar",
      ".gz": "application/gzip",
      ".tgz": "application/tar+gzip",
      ".rar": "application/vnd.rar",
      ".7z": "application/x-7z-compressed",
      ".mp3": "audio/mpeg",
      ".wav": "audio/wav",
      ".mp4": "video/mp4",
      ".avi": "video/x-msvideo",
      ".mov": "video/quicktime",
      ".doc": "application/msword",
      ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ".xls": "application/vnd.ms-excel",
      ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ".ppt": "application/vnd.ms-powerpoint",
      ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      ".rtf": "application/rtf",
      ".odt": "application/vnd.oasis.opendocument.text",
      ".ods": "application/vnd.oasis.opendocument.spreadsheet",
    };

    return mimeTypes[ext] || "application/octet-stream";
  }
}

module.exports = AliyunPackageAPI;

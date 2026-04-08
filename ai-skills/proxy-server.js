/**
 * 代理服务器，用于处理阿里云制品仓库API请求
 * 解决前端跨域问题
 */
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const axios = require("axios");
const FormData = require("form-data");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const https = require("https");
const { spawn, spawnSync } = require("child_process");
const basicAuth = require("basic-auth");

const app = express();
const PORT = process.env.PORT || 801;

// 配置multer用于处理文件上传
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = path.join(__dirname, "uploads");
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    // 生成唯一文件名
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  },
});

const upload = multer({ storage: storage });

// 阿里云制品仓库配置
const ALIYUN_CONFIG = {
  baseUrl:
    "https://packages.aliyun.com/api/protocol/63b05092aa32314b151f0761/generic/flow_generic_repo",
  auth: {
    username: "63b05082da874cca7225a283",
    password: ")96v6beCs4D)",
  },
};

const WECOM_CONFIG = {
  corpId: process.env.WECOM_CORP_ID || "wwc01ada818c620678",
  corpSecret: process.env.WECOM_CORP_SECRET || "Ag_UEOSdsqIhYnEZPISgBPD0_2Kc3Q7VjZRRHe4U8pI",
  apiBaseUrl: "https://qyapi.weixin.qq.com/cgi-bin",
};

const DINGTALK_CONFIG = {
  clientId: process.env.DINGTALK_CLIENT_ID || "dingasmfaemecleyoebx",
  clientSecret:
    process.env.DINGTALK_CLIENT_SECRET ||
    "MwZAy4PQqCzXAKPYd5XlfWnp7OOzgOBRAni8yOzdE9BUaKUmhYffMvHGpQ806zYL",
  appId: process.env.DINGTALK_APP_ID || "078a4052-cfc7-46f1-b46a-b4127a4a758c",
  agentId: process.env.DINGTALK_AGENT_ID || "3196838144",
  apiBaseUrl: "https://api.dingtalk.com",
};

const FEISHU_CONFIG = {
  appId: process.env.FEISHU_APP_ID || "cli_a77ccef42cfb901c",
  appSecret: process.env.FEISHU_APP_SECRET || "zXiaUSEJQEGyF2C6ftfbEeqQp5piggLJ",
  apiBaseUrl: "https://open.feishu.cn/open-apis",
};

const FEISHU_MAX_FILE_SIZE = 20 * 1024 * 1024;
const FEISHU_MULTIPART_THRESHOLD = FEISHU_MAX_FILE_SIZE;

const wecomTokenCache = {
  value: null,
  expiresAt: 0,
};

const dingtalkTokenCache = {
  value: null,
  expiresAt: 0,
};

const feishuTokenCache = {
  value: null,
  expiresAt: 0,
};

const WECOM_MAX_RANGE_BYTES = 20 * 1024 * 1024;

// 身份验证中间件
function authenticate(req, res, next) {
  // 对于静态文件请求（如HTML、CSS、JS）和登录相关请求，不进行身份验证
  if (
    req.path === "/" ||
    req.path.endsWith(".html") ||
    req.path.endsWith(".css") ||
    req.path.endsWith(".js") ||
    req.path.endsWith(".ico") ||
    req.path === "/login" ||
    req.path.startsWith("/api") ||
    req.path.startsWith("/uploads")
  ) {
    return next();
  }

  // 对于API请求，检查认证
  const user = basicAuth(req);

  if (!user || !(user.name === "admin" && user.pass === "admin123")) {
    res.status(401).json({ error: "访问被拒绝，请先登录" });
    return;
  }

  next();
}

// 应用身份验证中间件
app.use(authenticate);

// 配置CORS，允许所有来源（在生产环境中应该限制来源）
app.use(
  cors({
    origin: "*",
    credentials: true,
  }),
);

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true }));

app.get("/api/wecom/config", (req, res) => {
  const corpId = WECOM_CONFIG.corpId || "";
  res.json({
    configured: Boolean(WECOM_CONFIG.corpId && WECOM_CONFIG.corpSecret),
    corpIdMasked: corpId ? `${corpId.slice(0, 4)}***${corpId.slice(-4)}` : "",
  });
});

app.get("/api/wecom/direct-media-url/:mediaId", async (req, res) => {
  try {
    const mediaId = String(req.params?.mediaId || "").trim();
    if (!mediaId) {
      return res.status(400).json({ error: "缺少 mediaId" });
    }

    const accessToken = await getWecomAccessToken();
    res.json({
      mediaId,
      playbackUrl: buildWecomDirectMediaUrl(accessToken, mediaId),
      tokenExpiresAt: wecomTokenCache.expiresAt || 0,
    });
  } catch (error) {
    console.error("生成企业微信直链失败:", error.response?.data || error.message);
    res.status(500).json({
      error: error.response?.data?.errmsg || error.message || "生成企业微信直链失败",
    });
  }
});

app.post("/api/wecom/upload-by-url", async (req, res) => {
  try {
    const sourceUrl = String(req.body?.url || "").trim();
    const filename = normalizeVideoFilename(sourceUrl, req.body?.filename);
    let md5 = String(req.body?.md5 || "")
      .trim()
      .toLowerCase();

    if (!sourceUrl) {
      return res.status(400).json({ error: "缺少视频源地址 url" });
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(sourceUrl);
    } catch {
      return res.status(400).json({ error: "视频源地址格式不正确" });
    }

    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      return res.status(400).json({ error: "视频源地址必须是 http 或 https" });
    }

    if (!md5) {
      md5 = await computeRemoteFileMd5(sourceUrl);
    }

    const accessToken = await getWecomAccessToken();
    const response = await axios.post(
      `${WECOM_CONFIG.apiBaseUrl}/media/upload_by_url`,
      {
        scene: 1,
        type: "video",
        filename,
        url: sourceUrl,
        md5,
      },
      {
        params: { access_token: accessToken },
      },
    );

    if (response.data?.errcode !== 0 || !response.data?.jobid) {
      throw new Error(response.data?.errmsg || "创建企业微信异步上传任务失败");
    }

    res.json({
      jobid: response.data.jobid,
      filename,
      md5,
      sourceUrl,
    });
  } catch (error) {
    console.error("企业微信异步上传任务创建失败:", error.response?.data || error.message);
    res.status(500).json({
      error: error.response?.data?.errmsg || error.message || "企业微信异步上传任务创建失败",
    });
  }
});

app.post("/api/wecom/upload-direct", upload.single("file"), async (req, res) => {
  try {
    const type = String(req.body?.type || "video").trim() || "video";
    const fileNameInput = String(req.body?.fileName || "").trim();

    if (!req.file) {
      return res.status(400).json({ error: "没有文件被上传" });
    }

    const uploadName = normalizeVideoFilename(
      "",
      fileNameInput || maybeFixMojibakeFilename(req.file.originalname),
    );
    const accessToken = await getWecomAccessToken();
    const form = new FormData();
    form.append("media", fs.createReadStream(req.file.path), {
      filename: uploadName,
      contentType: req.file.mimetype || "application/octet-stream",
    });

    const response = await axios.post(`${WECOM_CONFIG.apiBaseUrl}/media/upload`, form, {
      params: {
        access_token: accessToken,
        type,
      },
      headers: form.getHeaders(),
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      validateStatus: () => true,
    });

    if (response.status >= 400 || response.data?.errcode) {
      return res.status(response.status >= 400 ? response.status : 500).json({
        error: response.data?.errmsg || "企业微信直传失败",
        raw: response.data,
      });
    }

    const mediaId = response.data?.media_id || "";
    const playbackUrl =
      type === "video" && mediaId ? buildWecomDirectMediaUrl(accessToken, mediaId) : "";

    res.json({
      type,
      mediaId,
      createdAt: response.data?.created_at || "",
      fileName: uploadName,
      originalName: maybeFixMojibakeFilename(req.file.originalname),
      playbackPath: "",
      playbackUrl,
      raw: response.data,
    });
  } catch (error) {
    console.error("企业微信直传失败:", error.response?.data || error.message);
    res.status(500).json({
      error: error.response?.data?.errmsg || error.message || "企业微信直传失败",
    });
  } finally {
    if (req.file && fs.existsSync(req.file.path)) {
      try {
        fs.unlinkSync(req.file.path);
      } catch {}
    }
  }
});

app.get("/api/wecom/upload-by-url/:jobid", async (req, res) => {
  try {
    const jobid = String(req.params?.jobid || "").trim();
    if (!jobid) {
      return res.status(400).json({ error: "缺少 jobid" });
    }

    const accessToken = await getWecomAccessToken();
    const response = await axios.post(
      `${WECOM_CONFIG.apiBaseUrl}/media/get_upload_by_url_result`,
      { jobid },
      {
        params: { access_token: accessToken },
      },
    );

    if (response.data?.errcode !== 0) {
      throw new Error(response.data?.errmsg || "查询企业微信异步任务失败");
    }

    const mediaId = response.data?.detail?.media_id || "";
    const playbackUrl = mediaId ? buildWecomDirectMediaUrl(accessToken, mediaId) : "";

    res.json({
      jobid,
      raw: response.data,
      status: translateWecomAsyncStatus(response.data),
      mediaId,
      createdAt: response.data?.detail?.created_at || "",
      detailErrcode: response.data?.detail?.errcode ?? 0,
      detailErrmsg: response.data?.detail?.errmsg || "ok",
      playbackPath: "",
      playbackUrl,
    });
  } catch (error) {
    console.error("企业微信异步任务查询失败:", error.response?.data || error.message);
    res.status(500).json({
      error: error.response?.data?.errmsg || error.message || "企业微信异步任务查询失败",
    });
  }
});

app.get("/api/wecom/media/:mediaId", async (req, res) => {
  try {
    const mediaId = String(req.params?.mediaId || "").trim();
    if (!mediaId) {
      return res.status(400).json({ error: "缺少 mediaId" });
    }

    const accessToken = await getWecomAccessToken();
    const upstreamRange = buildWecomRangeHeader(req.headers.range);
    const upstream = await axios.get(`${WECOM_CONFIG.apiBaseUrl}/media/get`, {
      params: {
        access_token: accessToken,
        media_id: mediaId,
      },
      responseType: "stream",
      timeout: 0,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      headers: { Range: upstreamRange },
      validateStatus: (status) => status < 500,
    });

    const contentType = String(upstream.headers["content-type"] || "").toLowerCase();
    if (contentType.includes("application/json")) {
      const bodyText = await readSmallStreamBody(upstream.data);
      let parsed = null;
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        parsed = null;
      }

      return res.status(502).json({
        error: parsed?.errmsg || upstream.headers["error-msg"] || "企业微信未返回视频流",
        errcode: parsed?.errcode || upstream.headers["error-code"] || "",
        upstreamRange,
      });
    }

    const passthroughHeaders = [
      "content-type",
      "content-length",
      "content-range",
      "accept-ranges",
      "content-disposition",
      "cache-control",
      "last-modified",
      "etag",
    ];

    passthroughHeaders.forEach((name) => {
      if (upstream.headers[name]) {
        res.setHeader(name, upstream.headers[name]);
      }
    });

    if (!upstream.headers["content-type"]) {
      res.setHeader("Content-Type", "video/mp4");
    }

    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("X-Wecom-Proxy-Range", upstreamRange);
    res.status(upstream.status === 200 ? 206 : upstream.status);
    upstream.data.pipe(res);
  } catch (error) {
    console.error("企业微信视频代理失败:", error.response?.data || error.message);
    res.status(500).json({
      error: error.response?.data?.errmsg || error.message || "企业微信视频代理失败",
    });
  }
});

app.get("/api/dingtalk/config", (req, res) => {
  const clientId = DINGTALK_CONFIG.clientId || "";
  res.json({
    configured: Boolean(DINGTALK_CONFIG.clientId && DINGTALK_CONFIG.clientSecret),
    appId: DINGTALK_CONFIG.appId,
    agentId: DINGTALK_CONFIG.agentId,
    clientIdMasked: clientId ? `${clientId.slice(0, 6)}***${clientId.slice(-4)}` : "",
  });
});

app.get("/api/feishu/config", async (req, res) => {
  try {
    const appId = FEISHU_CONFIG.appId || "";
    const rootRes = await feishuRequest("GET", "/drive/explorer/v2/root_folder/meta");
    res.json({
      configured: Boolean(FEISHU_CONFIG.appId && FEISHU_CONFIG.appSecret),
      appIdMasked: appId ? `${appId.slice(0, 6)}***${appId.slice(-4)}` : "",
      rootFolderToken: rootRes.data?.data?.token || "",
      rootFolderId: rootRes.data?.data?.id || "",
    });
  } catch (error) {
    console.error("读取飞书配置失败:", error.response?.data || error.message);
    res.status(500).json({
      error: error.response?.data?.msg || error.message || "读取飞书配置失败",
    });
  }
});

app.get("/api/feishu/direct-file-url/:fileToken", async (req, res) => {
  try {
    const fileToken = String(req.params?.fileToken || "").trim();
    if (!fileToken) {
      return res.status(400).json({ error: "缺少 fileToken" });
    }

    const accessToken = await getFeishuTenantAccessToken();
    res.json({
      fileToken,
      directApiUrl: `${FEISHU_CONFIG.apiBaseUrl}/drive/v1/files/${encodeURIComponent(fileToken)}/download`,
      tokenType: "Bearer",
      accessToken,
      tokenExpiresAt: feishuTokenCache.expiresAt || 0,
    });
  } catch (error) {
    console.error("生成飞书原始下载接口失败:", error.response?.data || error.message);
    res.status(500).json({
      error: error.response?.data?.msg || error.message || "生成飞书原始下载接口失败",
    });
  }
});

app.get("/api/feishu/tmp-download-url/:fileToken", async (req, res) => {
  try {
    const fileToken = String(req.params?.fileToken || "").trim();
    if (!fileToken) {
      return res.status(400).json({ error: "缺少 fileToken" });
    }

    const response = await feishuRequest("GET", "/drive/v1/medias/batch_get_tmp_download_url", {
      params: {
        file_tokens: fileToken,
      },
    });

    if (response.data?.code !== 0) {
      return res.status(500).json({
        error: response.data?.msg || "获取飞书临时下载链接失败",
        raw: response.data,
      });
    }

    const tmpDownload =
      (response.data?.data?.tmp_download_urls || []).find(
        (item) => item?.file_token === fileToken,
      ) || (response.data?.data?.tmp_download_urls || [])[0];

    if (!tmpDownload?.tmp_download_url) {
      return res.status(404).json({ error: "飞书未返回临时下载链接", raw: response.data });
    }

    res.json({
      fileToken,
      tmpDownloadUrl: tmpDownload.tmp_download_url,
      raw: response.data,
    });
  } catch (error) {
    console.error("获取飞书临时下载链接失败:", error.response?.data || error.message);
    res.status(500).json({
      error: error.response?.data?.msg || error.message || "获取飞书临时下载链接失败",
    });
  }
});

app.post("/api/feishu/upload", upload.single("file"), async (req, res) => {
  try {
    const fileNameInput = String(req.body?.fileName || "").trim();

    if (!req.file) {
      return res.status(400).json({ error: "没有文件被上传" });
    }

    const fixedOriginalName = maybeFixMojibakeFilename(req.file.originalname);
    const fileName = normalizeDingtalkFilename(fileNameInput, fixedOriginalName);
    const parentNode = await createFeishuMediaUploadPoint(
      fileName.replace(/\.[^/.]+$/, "") || "Codex Media Upload",
    );
    const parentType = "docx_file";
    let fileToken = "";
    let uploadMode = "simple";
    if (req.file.size > FEISHU_MULTIPART_THRESHOLD) {
      uploadMode = "multipart";
      fileToken = await uploadFeishuMediaMultipartFile({
        filePath: req.file.path,
        fileName,
        parentNode,
        parentType,
      });
    } else {
      const form = new FormData();
      form.append("file_name", fileName);
      form.append("parent_type", parentType);
      form.append("parent_node", parentNode);
      form.append("size", String(req.file.size));
      form.append("extra", "{}");
      form.append("file", fs.createReadStream(req.file.path), {
        filename: fileName,
        contentType: req.file.mimetype || "application/octet-stream",
      });

      const response = await feishuRequest("POST", "/drive/v1/medias/upload_all", {
        data: form,
        headers: form.getHeaders(),
        validateStatus: () => true,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      });

      if (response.status >= 400 || response.data?.code !== 0) {
        return res.status(response.status >= 400 ? response.status : 500).json({
          error: response.data?.msg || "飞书素材上传失败",
        });
      }

      fileToken = response.data?.data?.file_token || "";
    }

    let tmpDownloadLookupUrl = "";
    let tmpDownloadUrl = "";
    if (fileToken) {
      tmpDownloadLookupUrl = buildAbsoluteUrl(
        req,
        `/api/feishu/tmp-download-url/${encodeURIComponent(fileToken)}`,
      );
      try {
        const tmpRes = await feishuRequest("GET", "/drive/v1/medias/batch_get_tmp_download_url", {
          params: { file_tokens: fileToken },
        });
        const tmpDownload =
          (tmpRes.data?.data?.tmp_download_urls || []).find(
            (item) => item?.file_token === fileToken,
          ) || (tmpRes.data?.data?.tmp_download_urls || [])[0];
        tmpDownloadUrl = tmpDownload?.tmp_download_url || "";
      } catch {
        tmpDownloadUrl = "";
      }
    }

    res.json({
      fileToken,
      fileName,
      originalName: fixedOriginalName,
      parentNode,
      parentType,
      uploadMode,
      playbackUrl: fileToken
        ? buildAbsoluteUrl(req, `/api/feishu/files/${encodeURIComponent(fileToken)}/download`)
        : "",
      directApiUrl: fileToken
        ? `${FEISHU_CONFIG.apiBaseUrl}/drive/v1/files/${encodeURIComponent(fileToken)}/download`
        : "",
      tmpDownloadLookupUrl,
      tmpDownloadUrl,
    });
  } catch (error) {
    console.error("飞书素材上传失败:", error.response?.data || error.message);
    res.status(500).json({
      error: error.response?.data?.msg || error.message || "飞书素材上传失败",
    });
  } finally {
    if (req.file && fs.existsSync(req.file.path)) {
      try {
        fs.unlinkSync(req.file.path);
      } catch {}
    }
  }
});

app.get("/api/feishu/files/:fileToken/download", async (req, res) => {
  try {
    const fileToken = String(req.params?.fileToken || "").trim();
    if (!fileToken) {
      return res.status(400).json({ error: "缺少 fileToken" });
    }

    const upstream = await feishuRequest(
      "GET",
      `/drive/v1/files/${encodeURIComponent(fileToken)}/download`,
      {
        headers: req.headers.range ? { Range: req.headers.range } : {},
        responseType: "stream",
        timeout: 0,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        validateStatus: () => true,
      },
    );

    if (upstream.status >= 400) {
      const bodyText = await readSmallStreamBody(upstream.data);
      return res.status(upstream.status).json({
        error: bodyText || "飞书未返回可下载文件",
      });
    }

    [
      "content-type",
      "content-length",
      "content-range",
      "accept-ranges",
      "content-disposition",
      "cache-control",
      "last-modified",
      "etag",
    ].forEach((name) => {
      if (upstream.headers[name]) {
        res.setHeader(name, upstream.headers[name]);
      }
    });

    if (!upstream.headers["content-type"]) {
      res.setHeader("Content-Type", "application/octet-stream");
    }

    res.setHeader("X-Feishu-Proxy", "true");
    res.status(upstream.status);
    upstream.data.pipe(res);
  } catch (error) {
    console.error("飞书文件下载代理失败:", error.response?.data || error.message);
    res.status(500).json({
      error: error.response?.data?.msg || error.message || "飞书文件下载代理失败",
    });
  }
});

app.get("/api/public/aliyun-video-url", (req, res) => {
  const filePath = getQueryStringValue(req.query?.filePath).trim();
  const version = getQueryStringValue(req.query?.version).trim();
  const publicBaseUrl = getQueryStringValue(req.query?.publicBaseUrl).trim();

  if (!filePath || !version) {
    return res.status(400).json({ error: "缺少必需参数：filePath、version" });
  }

  const query = new URLSearchParams({ filePath, version });
  const pathname = `/api/public/aliyun-video?${query.toString()}`;
  const publicUrl = publicBaseUrl
    ? `${publicBaseUrl.replace(/\/$/, "")}${pathname}`
    : buildAbsoluteUrl(req, pathname);

  res.json({
    publicUrl,
    note: publicBaseUrl
      ? "请确认该 publicBaseUrl 对企业微信服务器可公网访问"
      : "当前返回的是本机地址。若要给企业微信使用，请传入公网 publicBaseUrl 或把服务暴露到公网。",
  });
});

app.get("/api/public/aliyun-video", async (req, res) => {
  try {
    const filePath = getQueryStringValue(req.query?.filePath).trim();
    const version = getQueryStringValue(req.query?.version).trim();

    if (!filePath || !version) {
      return res.status(400).json({ error: "缺少必需参数：filePath、version" });
    }

    const urlParams = new URLSearchParams({ version });
    const aliyunUrl = `${ALIYUN_CONFIG.baseUrl}/files/${filePath}?${urlParams.toString()}`;
    const upstream = await axios({
      method: "GET",
      url: aliyunUrl,
      headers: {
        Authorization: `Basic ${Buffer.from(`${ALIYUN_CONFIG.auth.username}:${ALIYUN_CONFIG.auth.password}`).toString("base64")}`,
        ...(req.headers.range ? { Range: req.headers.range } : {}),
      },
      responseType: "stream",
      timeout: 0,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      validateStatus: () => true,
    });

    if (upstream.status >= 400) {
      const bodyText = await readSmallStreamBody(upstream.data);
      return res.status(upstream.status).json({
        error: bodyText || "阿里云未返回视频流",
      });
    }

    [
      "content-type",
      "content-length",
      "content-range",
      "accept-ranges",
      "cache-control",
      "last-modified",
      "etag",
    ].forEach((name) => {
      if (upstream.headers[name]) {
        res.setHeader(name, upstream.headers[name]);
      }
    });

    const basename = path.basename(filePath);
    if (!upstream.headers["content-type"]) {
      res.setHeader("Content-Type", inferContentTypeFromFilename(basename));
    }
    if (!upstream.headers["content-disposition"]) {
      res.setHeader(
        "Content-Disposition",
        `inline; filename*=UTF-8''${encodeURIComponent(basename)}`,
      );
    }

    res.setHeader("Accept-Ranges", upstream.headers["accept-ranges"] || "bytes");
    res.setHeader("X-Aliyun-Video-Proxy", "true");
    res.status(upstream.status);
    upstream.data.pipe(res);
  } catch (error) {
    console.error("阿里云公开视频代理失败:", error.response?.data || error.message);
    res.status(500).json({
      error: error.response?.data || error.message || "阿里云公开视频代理失败",
    });
  }
});

app.post("/api/dingtalk/resolve-user", async (req, res) => {
  try {
    const userId = String(req.body?.userId || "").trim();
    if (!userId) {
      return res.status(400).json({ error: "缺少 userId" });
    }

    const result = await getDingtalkUserByUserId(userId);
    res.json({
      userId: result.userid || userId,
      name: result.name || "",
      unionId: result.unionid || "",
      mobile: result.mobile || "",
      title: result.title || "",
      deptIdList: result.dept_id_list || [],
    });
  } catch (error) {
    console.error("通过 userId 获取 unionId 失败:", error.response?.data || error.message);
    res.status(500).json({
      error: error.response?.data?.errmsg || error.message || "通过 userId 获取 unionId 失败",
    });
  }
});

app.post("/api/dingtalk/create-space", async (req, res) => {
  try {
    const unionId = String(req.body?.unionId || "").trim();
    const name = String(req.body?.name || "").trim() || `视频空间-${Date.now()}`;
    const quota = Number(req.body?.quota || 1024 * 1024 * 1024);
    const scene = String(req.body?.scene || "USER").trim() || "USER";
    const sceneId = String(req.body?.sceneId || "codexuser").trim() || "codexuser";

    if (!unionId) {
      return res.status(400).json({ error: "缺少 unionId" });
    }

    const response = await dingtalkRequest("POST", "/v1.0/storage/spaces", {
      params: { unionId },
      data: {
        option: {
          name,
          quota,
          scene,
          sceneId,
          ownerType: scene === "USER" ? "USER" : "APP",
          ...(scene === "USER" ? { ownerId: unionId } : {}),
        },
      },
      validateStatus: () => true,
    });

    if (response.status >= 400) {
      const detail = response.data || {};
      return res.status(response.status).json({
        error: detail.message || "创建钉钉存储空间失败",
        code: detail.code || "",
        requiredScopes: detail.accessdenieddetail?.requiredScopes || [],
      });
    }

    res.json(response.data);
  } catch (error) {
    console.error("创建钉钉存储空间失败:", error.response?.data || error.message);
    res.status(500).json({
      error: error.response?.data?.message || error.message || "创建钉钉存储空间失败",
      requiredScopes: error.response?.data?.accessdenieddetail?.requiredScopes || [],
    });
  }
});

app.post("/api/dingtalk/spaces", async (req, res) => {
  try {
    const unionId = String(req.body?.unionId || "").trim();
    const nextToken = String(req.body?.nextToken || "").trim();
    const spaceType = String(req.body?.spaceType || "org").trim() || "org";
    const maxResults = Number(req.body?.maxResults || 20);

    if (!unionId) {
      return res.status(400).json({ error: "缺少 unionId" });
    }

    const response = await dingtalkRequest("GET", "/v1.0/drive/spaces", {
      params: nextToken
        ? { nextToken, unionId, spaceType, maxResults }
        : { unionId, spaceType, maxResults },
      data: {},
      headers: { "Content-Type": "application/json" },
      validateStatus: () => true,
    });

    if (response.status >= 400) {
      const detail = response.data || {};
      return res.status(response.status).json({
        error: detail.message || "获取钉钉空间列表失败",
        code: detail.code || "",
      });
    }

    res.json(response.data);
  } catch (error) {
    console.error("获取钉钉空间列表失败:", error.response?.data || error.message);
    res.status(500).json({
      error: error.response?.data?.message || error.message || "获取钉钉空间列表失败",
    });
  }
});

app.post("/api/dingtalk/files", async (req, res) => {
  try {
    const unionId = String(req.body?.unionId || "").trim();
    const spaceId = String(req.body?.spaceId || "").trim();
    const parentId = String(req.body?.parentId || "0").trim() || "0";
    const nextToken = String(req.body?.nextToken || "").trim();
    const maxResults = Number(req.body?.maxResults || 100);

    if (!unionId || !spaceId) {
      return res.status(400).json({ error: "缺少必需参数：unionId、spaceId" });
    }

    const response = await dingtalkRequest(
      "GET",
      `/v1.0/storage/spaces/${encodeURIComponent(spaceId)}/dentries`,
      {
        params: {
          unionId,
          parentId,
          maxResults,
          ...(nextToken ? { nextToken } : {}),
        },
        validateStatus: () => true,
      },
    );

    if (response.status >= 400) {
      const detail = response.data || {};
      return res.status(response.status).json({
        error: detail.message || "获取目录列表失败",
        code: detail.code || "",
        requiredScopes: detail.accessdenieddetail?.requiredScopes || [],
      });
    }

    res.json(response.data);
  } catch (error) {
    console.error("获取钉钉目录列表失败:", error.response?.data || error.message);
    res.status(500).json({
      error: error.response?.data?.message || error.message || "获取钉钉目录列表失败",
    });
  }
});

app.post("/api/dingtalk/create-folder", async (req, res) => {
  try {
    const unionId = String(req.body?.unionId || "").trim();
    const spaceId = String(req.body?.spaceId || "").trim();
    const parentId = String(req.body?.parentId || "0").trim() || "0";
    const name = String(req.body?.name || "").trim() || `上传目录${Date.now()}`;

    if (!unionId || !spaceId) {
      return res.status(400).json({ error: "缺少必需参数：unionId、spaceId" });
    }

    const response = await dingtalkRequest(
      "POST",
      `/v1.0/storage/spaces/${encodeURIComponent(spaceId)}/dentries/${encodeURIComponent(parentId)}/folders`,
      {
        params: { unionId },
        data: { name },
        validateStatus: () => true,
      },
    );

    if (response.status >= 400) {
      const detail = response.data || {};
      return res.status(response.status).json({
        error: detail.message || "创建目录失败",
        code: detail.code || "",
        requiredScopes: detail.accessdenieddetail?.requiredScopes || [],
      });
    }

    res.json(response.data);
  } catch (error) {
    console.error("创建钉钉目录失败:", error.response?.data || error.message);
    res.status(500).json({
      error: error.response?.data?.message || error.message || "创建钉钉目录失败",
      requiredScopes: error.response?.data?.accessdenieddetail?.requiredScopes || [],
    });
  }
});

app.post("/api/dingtalk/upload", upload.single("file"), async (req, res) => {
  try {
    const unionId = String(req.body?.unionId || "").trim();
    const spaceId = String(req.body?.spaceId || "").trim();
    const parentDentryUuid = String(req.body?.parentDentryUuid || "").trim();
    const optionName = String(req.body?.name || "").trim();
    const overwrite = String(req.body?.overwrite || "").trim() === "true";

    if (!req.file) {
      return res.status(400).json({ error: "没有文件被上传" });
    }

    if (!unionId || !parentDentryUuid) {
      return res.status(400).json({ error: "缺少必需参数：unionId、parentDentryUuid" });
    }

    const fileName = normalizeDingtalkFilename(optionName, req.file.originalname);
    const fileSize = req.file.size;

    const uploadInfoResponse = await dingtalkRequest(
      "POST",
      `/v2.0/storage/spaces/files/${encodeURIComponent(parentDentryUuid)}/uploadInfos/query`,
      {
        params: { unionId },
        data: {
          protocol: "HEADER_SIGNATURE",
          option: {
            storageDriver: "DINGTALK",
            preCheckParam: {
              size: fileSize,
              name: fileName,
            },
          },
        },
        validateStatus: () => true,
      },
    );

    if (uploadInfoResponse.status >= 400) {
      const detail = uploadInfoResponse.data || {};
      return res.status(uploadInfoResponse.status).json({
        error: detail.message || "获取钉钉上传信息失败",
        code: detail.code || "",
        requiredScopes: detail.accessdenieddetail?.requiredScopes || [],
      });
    }

    const uploadInfo = uploadInfoResponse.data || {};
    const headerSignatureInfo = uploadInfo.headerSignatureInfo || {};
    const uploadUrl = (headerSignatureInfo.resourceUrls || [])[0];
    const uploadHeaders = parseDingtalkProxyHeaders(headerSignatureInfo.headers);

    if (!uploadUrl) {
      throw new Error("钉钉未返回可用的上传地址");
    }

    const fileBuffer = fs.readFileSync(req.file.path);
    const uploadResult = await uploadBufferWithSignedHeaders(uploadUrl, uploadHeaders, fileBuffer);
    if (uploadResult.status < 200 || uploadResult.status >= 300) {
      return res.status(502).json({
        error: "上传到钉钉对象存储失败",
        upstreamStatus: uploadResult.status,
        upstreamBody: uploadResult.body || "",
      });
    }

    const commitResponse = await dingtalkRequest(
      "POST",
      `/v2.0/storage/spaces/files/${encodeURIComponent(parentDentryUuid)}/commit`,
      {
        params: { unionId },
        data: {
          uploadKey: uploadInfo.uploadKey,
          name: fileName,
          option: {
            size: fileSize,
            conflictStrategy: overwrite ? "OVERWRITE" : "AUTO_RENAME",
          },
        },
        validateStatus: () => true,
      },
    );

    if (commitResponse.status >= 400) {
      const detail = commitResponse.data || {};
      return res.status(commitResponse.status).json({
        error: detail.message || "提交钉钉文件失败",
        code: detail.code || "",
        requiredScopes: detail.accessdenieddetail?.requiredScopes || [],
      });
    }

    const commitData = commitResponse.data || {};
    const dentry = commitData.dentry || {};
    const resolvedSpaceId = dentry.spaceId || spaceId || "";
    const dentryId =
      dentry.uuid ||
      dentry.id ||
      commitData.dentryUuid ||
      commitData.id ||
      commitData.dentryId ||
      "";

    res.json({
      ...commitData,
      spaceId: resolvedSpaceId,
      unionId,
      dentryId,
      playbackProxyUrl:
        resolvedSpaceId && dentryId
          ? buildDingtalkPlaybackProxyUrl(req, resolvedSpaceId, dentryId, unionId)
          : "",
    });
  } catch (error) {
    console.error("钉钉文件上传失败:", error.response?.data || error.message);
    res.status(500).json({
      error: error.response?.data?.message || error.message || "钉钉文件上传失败",
      requiredScopes: error.response?.data?.accessdenieddetail?.requiredScopes || [],
    });
  } finally {
    if (req.file && fs.existsSync(req.file.path)) {
      try {
        fs.unlinkSync(req.file.path);
      } catch {}
    }
  }
});

app.post("/api/dingtalk/playback-info", async (req, res) => {
  try {
    const unionId = String(req.body?.unionId || "").trim();
    const spaceId = String(req.body?.spaceId || "").trim();
    const dentryId = String(req.body?.dentryId || "").trim();

    if (!unionId || !spaceId || !dentryId) {
      return res.status(400).json({ error: "缺少必需参数：unionId、spaceId、dentryId" });
    }

    const [downloadResponse, openResponse] = await Promise.all([
      dingtalkRequest(
        "POST",
        `/v1.0/storage/spaces/${encodeURIComponent(spaceId)}/dentries/${encodeURIComponent(dentryId)}/downloadInfos/query`,
        {
          params: { unionId },
          data: {
            protocol: "HEADER_SIGNATURE",
          },
        },
      ),
      dingtalkRequest(
        "POST",
        `/v1.0/storage/spaces/${encodeURIComponent(spaceId)}/dentries/${encodeURIComponent(dentryId)}/openInfos/query`,
        {
          params: { unionId },
          data: {
            scene: "ONLINE_PREVIEW",
          },
          validateStatus: (status) => status < 500,
        },
      ),
    ]);

    const downloadData = downloadResponse.data || {};
    const headerSignatureInfo = downloadData.headerSignatureInfo || {};
    const previewData = openResponse.status >= 400 ? {} : openResponse.data || {};

    res.json({
      spaceId,
      dentryId,
      unionId,
      resourceUrl: (headerSignatureInfo.resourceUrls || [])[0] || "",
      headers: headerSignatureInfo.headers || {},
      previewUrl: previewData.openUrl || previewData.url || "",
      playbackProxyUrl: buildDingtalkPlaybackProxyUrl(req, spaceId, dentryId, unionId),
      rawDownloadInfo: downloadData,
      rawOpenInfo: previewData,
    });
  } catch (error) {
    console.error("获取钉钉播放信息失败:", error.response?.data || error.message);
    res.status(500).json({
      error: error.response?.data?.message || error.message || "获取钉钉播放信息失败",
    });
  }
});

app.get("/api/dingtalk/media/:spaceId/:dentryId", async (req, res) => {
  try {
    const unionId = getQueryStringValue(req.query?.unionId).trim();
    const spaceId = String(req.params?.spaceId || "").trim();
    const dentryId = String(req.params?.dentryId || "").trim();

    if (!unionId || !spaceId || !dentryId) {
      return res.status(400).json({ error: "缺少必需参数：unionId、spaceId、dentryId" });
    }

    const downloadResponse = await dingtalkRequest(
      "POST",
      `/v1.0/storage/spaces/${encodeURIComponent(spaceId)}/dentries/${encodeURIComponent(dentryId)}/downloadInfos/query`,
      {
        params: { unionId },
        data: {
          protocol: "HEADER_SIGNATURE",
        },
      },
    );

    const headerSignatureInfo = downloadResponse.data?.headerSignatureInfo || {};
    const downloadUrl = (headerSignatureInfo.resourceUrls || [])[0];
    const downloadHeaders = parseDingtalkProxyHeaders(headerSignatureInfo.headers);

    if (!downloadUrl) {
      throw new Error("钉钉未返回临时下载地址");
    }

    const upstream = await axios.get(downloadUrl, {
      responseType: "stream",
      timeout: 0,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      headers: {
        ...downloadHeaders,
        ...(req.headers.range ? { Range: req.headers.range } : {}),
      },
      validateStatus: (status) => status < 500,
    });

    [
      "content-type",
      "content-length",
      "content-range",
      "accept-ranges",
      "content-disposition",
      "cache-control",
      "last-modified",
      "etag",
    ].forEach((name) => {
      if (upstream.headers[name]) {
        res.setHeader(name, upstream.headers[name]);
      }
    });

    if (!upstream.headers["content-type"]) {
      res.setHeader("Content-Type", "video/mp4");
    }

    res.setHeader("X-Dingtalk-Proxy", "true");
    res.status(upstream.status);
    upstream.data.pipe(res);
  } catch (error) {
    console.error("钉钉媒体代理失败:", error.response?.data || error.message);
    res.status(500).json({
      error: error.response?.data?.message || error.message || "钉钉媒体代理失败",
    });
  }
});

function resolveFfmpegPath() {
  try {
    const r = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
    if (r && r.status === 0) {
      return "ffmpeg";
    }
  } catch {
    // ignore
  }

  const local = path.join(__dirname, "ffmpeg");
  if (fs.existsSync(local)) {
    return local;
  }
  return null;
}

function sanitizeOutputFileBaseName(input) {
  const trimmed = String(input || "").trim();
  if (!trimmed) {
    return "";
  }
  // Prevent path traversal by taking basename
  let base = path.basename(trimmed);
  // Remove path separators and NUL
  base = base.replace(/[\\/]/g, "").replaceAll("\0", "");
  // Remove ASCII control chars
  base = Array.from(base)
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f;
    })
    .join("");
  // Remove characters that are problematic across common filesystems
  base = base.replace(/[<>:"|?*]/g, "-");
  // Collapse whitespace a bit
  base = base.replace(/\s+/g, " ").trim();
  // Avoid extremely long names
  if (base.length > 120) {
    base = base.slice(0, 120).trim();
  }
  return base;
}

function maybeFixMojibakeFilename(name) {
  const s = String(name || "");
  if (!s) {
    return s;
  }
  // If it already contains CJK characters, assume it's fine.
  if (/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/.test(s)) {
    return s;
  }

  // Try interpreting the string as latin1 bytes and decoding as utf8.
  // This fixes common cases like "ç¦æ»¡..." that come from UTF-8 bytes mis-decoded as latin1.
  let candidate = "";
  try {
    candidate = Buffer.from(s, "latin1").toString("utf8");
  } catch {
    return s;
  }

  // If candidate has CJK while original doesn't, prefer candidate.
  if (/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/.test(candidate)) {
    return candidate;
  }

  return s;
}

function ensureWecomConfigured() {
  if (!WECOM_CONFIG.corpId || !WECOM_CONFIG.corpSecret) {
    throw new Error("企业微信 corpId 或 corpSecret 未配置");
  }
}

async function getWecomAccessToken(forceRefresh = false) {
  ensureWecomConfigured();

  const now = Date.now();
  if (!forceRefresh && wecomTokenCache.value && wecomTokenCache.expiresAt > now + 60 * 1000) {
    return wecomTokenCache.value;
  }

  const response = await axios.get(`${WECOM_CONFIG.apiBaseUrl}/gettoken`, {
    params: {
      corpid: WECOM_CONFIG.corpId,
      corpsecret: WECOM_CONFIG.corpSecret,
    },
  });

  if (response.data?.errcode !== 0 || !response.data?.access_token) {
    throw new Error(response.data?.errmsg || "获取企业微信 access_token 失败");
  }

  const expiresIn = Number(response.data.expires_in || 7200);
  wecomTokenCache.value = response.data.access_token;
  wecomTokenCache.expiresAt = now + expiresIn * 1000;
  return wecomTokenCache.value;
}

function inferFilenameFromUrl(fileUrl) {
  try {
    const pathname = new URL(fileUrl).pathname || "";
    const candidate = path.basename(decodeURIComponent(pathname));
    if (candidate && candidate !== "/") {
      return candidate;
    }
  } catch {
    // ignore
  }

  return `wecom-video-${Date.now()}.mp4`;
}

function normalizeVideoFilename(fileUrl, inputName) {
  const rawName = inputName || inferFilenameFromUrl(fileUrl) || "video.mp4";
  const safeName = sanitizeOutputFileBaseName(rawName) || "video.mp4";
  return /\.mp4$/i.test(safeName)
    ? safeName
    : `${safeName.replace(/\.[^/.]+$/, "") || "video"}.mp4`;
}

function buildAbsoluteUrl(req, pathname) {
  return `${req.protocol}://${req.get("host")}${pathname}`;
}

function getQueryStringValue(value) {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return typeof value[0] === "string" ? value[0] : "";
  }
  return "";
}

function buildWecomDirectMediaUrl(accessToken, mediaId) {
  const params = new URLSearchParams({
    access_token: accessToken,
    media_id: mediaId,
  });
  return `${WECOM_CONFIG.apiBaseUrl}/media/get?${params.toString()}`;
}

function buildWecomRangeHeader(rangeHeader) {
  const maxEndOffset = WECOM_MAX_RANGE_BYTES - 1;
  if (!rangeHeader || !rangeHeader.startsWith("bytes=")) {
    return `bytes=0-${maxEndOffset}`;
  }

  const value = rangeHeader.slice("bytes=".length).trim();
  const firstPart = value.split(",")[0].trim();
  const match = firstPart.match(/^(\d*)-(\d*)$/);
  if (!match) {
    return `bytes=0-${maxEndOffset}`;
  }

  const startRaw = match[1];
  const endRaw = match[2];

  if (!startRaw && !endRaw) {
    return `bytes=0-${maxEndOffset}`;
  }

  if (!startRaw && endRaw) {
    const suffixLength = Math.max(1, Number(endRaw));
    const chunkLength = Math.min(suffixLength, WECOM_MAX_RANGE_BYTES);
    return `bytes=0-${chunkLength - 1}`;
  }

  const start = Math.max(0, Number(startRaw) || 0);
  let end = start + maxEndOffset;
  if (endRaw) {
    end = Math.min(Number(endRaw), start + maxEndOffset);
  }

  return `bytes=${start}-${end}`;
}

async function readSmallStreamBody(stream, limit = 4096) {
  const chunks = [];
  let total = 0;

  return await new Promise((resolve, reject) => {
    stream.on("data", (chunk) => {
      if (total < limit) {
        chunks.push(chunk.slice(0, limit - total));
      }
      total += chunk.length;
    });
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", reject);
  });
}

async function computeRemoteFileMd5(fileUrl) {
  const hash = crypto.createHash("md5");
  const response = await axios.get(fileUrl, {
    responseType: "stream",
    timeout: 0,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });

  await new Promise((resolve, reject) => {
    response.data.on("data", (chunk) => hash.update(chunk));
    response.data.on("end", resolve);
    response.data.on("error", reject);
  });

  return hash.digest("hex");
}

async function uploadLocalFileToWecom({ filePath, fileName, type = "video" }) {
  const stat = fs.statSync(filePath);
  const accessToken = await getWecomAccessToken();
  const form = new FormData();
  form.append("media", fs.createReadStream(filePath), {
    filename: fileName,
    contentType: inferContentTypeFromFilename(fileName),
  });

  const response = await axios.post(`${WECOM_CONFIG.apiBaseUrl}/media/upload`, form, {
    params: {
      access_token: accessToken,
      type,
    },
    headers: form.getHeaders(),
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    validateStatus: () => true,
  });

  if (response.status >= 400 || response.data?.errcode) {
    const rawText = typeof response.data === "string" ? response.data : "";
    let message = response.data?.errmsg || "企业微信直传失败";

    if (response.status === 413 || /413 Request Entity Too Large/i.test(rawText)) {
      const sizeMb = (stat.size / (1024 * 1024)).toFixed(2);
      message = `企业微信拒绝该片段上传，文件过大（${sizeMb} MB）`;
    }

    const error = new Error(message);
    error.raw = response.data;
    error.status = response.status;
    error.fileSize = stat.size;
    throw error;
  }

  return response.data;
}

function translateWecomAsyncStatus(result) {
  if (result?.detail?.errcode && result.detail.errcode !== 0) {
    return "failed";
  }

  if (result?.detail?.media_id || result?.status === 2) {
    return "done";
  }

  return "processing";
}

function ensureDingtalkConfigured() {
  if (!DINGTALK_CONFIG.clientId || !DINGTALK_CONFIG.clientSecret) {
    throw new Error("钉钉 Client ID 或 Client Secret 未配置");
  }
}

async function getDingtalkAccessToken(forceRefresh = false) {
  ensureDingtalkConfigured();

  const now = Date.now();
  if (!forceRefresh && dingtalkTokenCache.value && dingtalkTokenCache.expiresAt > now + 60 * 1000) {
    return dingtalkTokenCache.value;
  }

  const response = await axios.post(`${DINGTALK_CONFIG.apiBaseUrl}/v1.0/oauth2/accessToken`, {
    appKey: DINGTALK_CONFIG.clientId,
    appSecret: DINGTALK_CONFIG.clientSecret,
  });

  if (!response.data?.accessToken) {
    throw new Error(response.data?.message || "获取钉钉 accessToken 失败");
  }

  const expiresIn = Number(response.data.expireIn || 7200);
  dingtalkTokenCache.value = response.data.accessToken;
  dingtalkTokenCache.expiresAt = now + expiresIn * 1000;
  return dingtalkTokenCache.value;
}

function ensureFeishuConfigured() {
  if (!FEISHU_CONFIG.appId || !FEISHU_CONFIG.appSecret) {
    throw new Error("飞书 App ID 或 App Secret 未配置");
  }
}

async function getFeishuTenantAccessToken(forceRefresh = false) {
  ensureFeishuConfigured();

  const now = Date.now();
  if (!forceRefresh && feishuTokenCache.value && feishuTokenCache.expiresAt > now + 60 * 1000) {
    return feishuTokenCache.value;
  }

  const response = await axios.post(
    `${FEISHU_CONFIG.apiBaseUrl}/auth/v3/tenant_access_token/internal`,
    {
      app_id: FEISHU_CONFIG.appId,
      app_secret: FEISHU_CONFIG.appSecret,
    },
  );

  if (response.data?.code !== 0 || !response.data?.tenant_access_token) {
    throw new Error(response.data?.msg || "获取飞书 tenant_access_token 失败");
  }

  const expiresIn = Number(response.data.expire || 7200);
  feishuTokenCache.value = response.data.tenant_access_token;
  feishuTokenCache.expiresAt = now + expiresIn * 1000;
  return feishuTokenCache.value;
}

async function feishuRequest(
  method,
  apiPath,
  {
    accessToken,
    params,
    data,
    headers,
    responseType,
    validateStatus,
    maxBodyLength,
    maxContentLength,
    timeout,
  } = {},
) {
  const token = accessToken || (await getFeishuTenantAccessToken());
  return axios({
    method,
    url: `${FEISHU_CONFIG.apiBaseUrl}${apiPath}`,
    params,
    data,
    headers: {
      Authorization: `Bearer ${token}`,
      ...headers,
    },
    responseType,
    validateStatus,
    maxBodyLength,
    maxContentLength,
    timeout,
  });
}

async function dingtalkRequest(
  method,
  apiPath,
  { accessToken, params, data, headers, responseType, validateStatus } = {},
) {
  const token = accessToken || (await getDingtalkAccessToken());
  return axios({
    method,
    url: `${DINGTALK_CONFIG.apiBaseUrl}${apiPath}`,
    params,
    data,
    headers: {
      "x-acs-dingtalk-access-token": token,
      ...headers,
    },
    responseType,
    validateStatus,
  });
}

async function getDingtalkUserByUserId(userId, accessToken) {
  const token = accessToken || (await getDingtalkAccessToken());
  const response = await axios.post(
    "https://oapi.dingtalk.com/topapi/v2/user/get",
    { userid: userId },
    {
      params: { access_token: token },
    },
  );

  if (response.data?.errcode !== 0 || !response.data?.result) {
    throw new Error(response.data?.errmsg || "通过 userId 获取钉钉用户信息失败");
  }

  return response.data.result;
}

function normalizeDingtalkFilename(input, fallback) {
  const rawName = input || fallback || `dingtalk-file-${Date.now()}`;
  return sanitizeOutputFileBaseName(rawName) || `dingtalk-file-${Date.now()}`;
}

function parseDingtalkProxyHeaders(rawHeaders) {
  if (!rawHeaders) {
    return {};
  }
  if (typeof rawHeaders === "object" && !Array.isArray(rawHeaders)) {
    return rawHeaders;
  }

  try {
    const parsed = JSON.parse(rawHeaders);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function buildDingtalkPlaybackProxyUrl(req, spaceId, dentryId, unionId) {
  const params = new URLSearchParams();
  if (unionId) {
    params.set("unionId", unionId);
  }
  return buildAbsoluteUrl(
    req,
    `/api/dingtalk/media/${encodeURIComponent(spaceId)}/${encodeURIComponent(dentryId)}?${params.toString()}`,
  );
}

function inferContentTypeFromFilename(filename) {
  const ext = path.extname(String(filename || "")).toLowerCase();
  if (ext === ".mp4") {
    return "video/mp4";
  }
  if (ext === ".webm") {
    return "video/webm";
  }
  if (ext === ".mov") {
    return "video/quicktime";
  }
  if (ext === ".mkv") {
    return "video/x-matroska";
  }
  return "application/octet-stream";
}

async function uploadBufferWithSignedHeaders(uploadUrl, headers, buffer) {
  const target = new URL(uploadUrl);
  const requestHeaders = {
    ...headers,
    "Content-Length": String(buffer.length),
  };

  return await new Promise((resolve, reject) => {
    const req = https.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        path: target.pathname + target.search,
        method: "PUT",
        headers: requestHeaders,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk.toString()));
        res.on("end", () =>
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            body,
          }),
        );
      },
    );

    req.on("error", reject);
    req.write(buffer);
    req.end();
  });
}

async function createFeishuMediaUploadPoint(title) {
  const response = await feishuRequest("POST", "/docx/v1/documents", {
    data: {
      title: String(title || "").trim() || "Codex Media Upload",
    },
    headers: { "Content-Type": "application/json" },
  });

  const documentId =
    response.data?.data?.document?.document_id || response.data?.data?.document_id || "";
  if (response.data?.code !== 0 || !documentId) {
    throw new Error(response.data?.msg || "创建飞书文档上传点失败");
  }

  return documentId;
}

async function uploadFeishuMediaMultipartFile({
  filePath,
  fileName,
  parentNode,
  parentType = "docx_file",
}) {
  const stat = fs.statSync(filePath);
  const prepareRes = await feishuRequest("POST", "/drive/v1/medias/upload_prepare", {
    data: {
      file_name: fileName,
      parent_type: parentType,
      parent_node: parentNode,
      size: stat.size,
      extra: "{}",
    },
    headers: { "Content-Type": "application/json" },
  });

  if (prepareRes.data?.code !== 0 || !prepareRes.data?.data?.upload_id) {
    throw new Error(prepareRes.data?.msg || "飞书素材分片上传准备失败");
  }

  const prepareData = prepareRes.data.data;
  const uploadId = prepareData.upload_id;
  const blockSize = Number(prepareData.block_size || 4 * 1024 * 1024);
  const blockNum = Number(prepareData.block_num || Math.ceil(stat.size / blockSize));
  const fd = fs.openSync(filePath, "r");

  try {
    for (let seq = 0; seq < blockNum; seq += 1) {
      const offset = seq * blockSize;
      const currentSize = Math.min(blockSize, stat.size - offset);
      const buffer = Buffer.alloc(currentSize);
      fs.readSync(fd, buffer, 0, currentSize, offset);

      const form = new FormData();
      form.append("upload_id", uploadId);
      form.append("seq", String(seq));
      form.append("size", String(currentSize));
      form.append("file", buffer, {
        filename: `${fileName}.part${seq}`,
        contentType: "application/octet-stream",
      });

      const partRes = await feishuRequest("POST", "/drive/v1/medias/upload_part", {
        data: form,
        headers: form.getHeaders(),
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      });

      if (partRes.data?.code !== 0) {
        throw new Error(partRes.data?.msg || `飞书素材分片上传失败，seq=${seq}`);
      }
    }
  } finally {
    fs.closeSync(fd);
  }

  const finishRes = await feishuRequest("POST", "/drive/v1/medias/upload_finish", {
    data: {
      upload_id: uploadId,
      block_num: blockNum,
    },
    headers: { "Content-Type": "application/json" },
  });

  if (finishRes.data?.code !== 0 || !finishRes.data?.data?.file_token) {
    throw new Error(finishRes.data?.msg || "飞书素材分片上传完成失败");
  }

  return finishRes.data.data.file_token;
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function getUploadsDir() {
  const uploadsDir = path.join(__dirname, "uploads");
  ensureDir(uploadsDir);
  return uploadsDir;
}

function getLocalPlaylistRootDir() {
  const rootDir = path.join(getUploadsDir(), "local-playlists");
  ensureDir(rootDir);
  return rootDir;
}

function getLocalPlaylistStorePath() {
  return path.join(getLocalPlaylistRootDir(), "playlists.json");
}

function getWecomPlaylistStorePath() {
  return path.join(getLocalPlaylistRootDir(), "wecom-playlists.json");
}

function getWecomHlsCacheRootDir() {
  const cacheDir = path.join(getLocalPlaylistRootDir(), "wecom-hls-cache");
  ensureDir(cacheDir);
  return cacheDir;
}

function readJsonFileSafe(filePath, fallbackValue) {
  try {
    if (!fs.existsSync(filePath)) {
      return fallbackValue;
    }
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallbackValue;
  }
}

function loadLocalPlaylists() {
  return readJsonFileSafe(getLocalPlaylistStorePath(), {});
}

function saveLocalPlaylists(playlists) {
  fs.writeFileSync(getLocalPlaylistStorePath(), JSON.stringify(playlists, null, 2));
}

function loadWecomPlaylists() {
  return readJsonFileSafe(getWecomPlaylistStorePath(), {});
}

function saveWecomPlaylists(playlists) {
  fs.writeFileSync(getWecomPlaylistStorePath(), JSON.stringify(playlists, null, 2));
}

function makeLocalPlaylistId(prefix = "playlist") {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createPlaylistItemUrl(playlistId, fileName) {
  return `/uploads/local-playlists/${playlistId}/${encodeURIComponent(fileName)}`;
}

function listPlaylistFiles(playlistDir) {
  if (!fs.existsSync(playlistDir)) {
    return [];
  }
  return fs
    .readdirSync(playlistDir)
    .filter((name) => /\.(mp4|mov|webm|m4v|ogg|ogv)$/i.test(name))
    .toSorted((a, b) => a.localeCompare(b, "zh-CN", { numeric: true, sensitivity: "base" }));
}

function buildLocalPlaylistRecord({ id, name, kind, sourceFile, items }) {
  return {
    id,
    name,
    kind,
    sourceFile: sourceFile || null,
    createdAt: Date.now(),
    itemCount: items.length,
    items,
  };
}

function inferSegmentDurationFromPlaylistName(name, fallbackSeconds = 30) {
  const match = String(name || "").match(/(\d+)\s*秒/);
  if (!match) {
    return fallbackSeconds;
  }
  return Math.max(1, Number(match[1]) || fallbackSeconds);
}

async function ensureWecomTsSegmentCached({ req, playlistId, item, index }) {
  const ffmpegPath = resolveFfmpegPath();
  if (!ffmpegPath) {
    throw new Error("未找到可用的 ffmpeg，无法生成 HLS 分片");
  }

  const playlistCacheDir = path.join(getWecomHlsCacheRootDir(), playlistId);
  ensureDir(playlistCacheDir);
  const outputPath = path.join(playlistCacheDir, `segment-${String(index).padStart(3, "0")}.ts`);
  if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
    return outputPath;
  }

  const playbackPath =
    item.playbackPath || `/api/wecom/media/${encodeURIComponent(item.mediaId || "")}`;
  const inputUrl = buildAbsoluteUrl(req, playbackPath);

  await new Promise((resolve, reject) => {
    const args = [
      "-y",
      "-i",
      inputUrl,
      "-c",
      "copy",
      "-bsf:v",
      "h264_mp4toannexb",
      "-f",
      "mpegts",
      outputPath,
    ];

    const child = spawn(ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
        resolve();
        return;
      }
      try {
        if (fs.existsSync(outputPath)) {
          fs.unlinkSync(outputPath);
        }
      } catch {
        // ignore cleanup failure
      }
      reject(new Error(stderr || `ffmpeg 转 TS 失败，退出码 ${code}`));
    });
  });

  return outputPath;
}

async function splitVideoToPlaylist({ inputPath, playlistId, playlistName, segmentSeconds = 30 }) {
  const ffmpegPath = resolveFfmpegPath();
  if (!ffmpegPath) {
    throw new Error("未找到可用的 ffmpeg，请先安装 ffmpeg");
  }

  if (!fs.existsSync(inputPath)) {
    throw new Error(`待切分文件不存在: ${inputPath}`);
  }

  const normalizedSegmentSeconds = Math.max(5, Number(segmentSeconds) || 30);
  const playlistDir = path.join(getLocalPlaylistRootDir(), playlistId);
  ensureDir(playlistDir);
  const outputPattern = path.join(playlistDir, "segment-%03d.mp4");

  await new Promise((resolve, reject) => {
    const args = [
      "-y",
      "-i",
      inputPath,
      "-map",
      "0:v:0",
      "-map",
      "0:a?",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-force_key_frames",
      `expr:gte(t,n_forced*${normalizedSegmentSeconds})`,
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-movflags",
      "+faststart",
      "-f",
      "segment",
      "-segment_time",
      String(normalizedSegmentSeconds),
      "-reset_timestamps",
      "1",
      outputPattern,
    ];

    const child = spawn(ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr || `ffmpeg 切分失败，退出码 ${code}`));
    });
  });

  const segmentFiles = listPlaylistFiles(playlistDir);
  if (!segmentFiles.length) {
    throw new Error("ffmpeg 切分完成，但没有生成任何分段文件");
  }

  const items = segmentFiles.map((fileName, index) => {
    const filePath = path.join(playlistDir, fileName);
    const stat = fs.statSync(filePath);
    return {
      id: `${playlistId}-${index + 1}`,
      title: `${playlistName} - 第 ${index + 1} 段`,
      fileName,
      order: index,
      size: stat.size,
      url: createPlaylistItemUrl(playlistId, fileName),
    };
  });

  return buildLocalPlaylistRecord({
    id: playlistId,
    name: playlistName,
    kind: "split",
    sourceFile: path.basename(inputPath),
    items,
  });
}

// Server-Sent Events (SSE) clients store: map taskId => array of response objects
const sseClients = new Map();

function sendSSE(taskId, event, data) {
  const clients = sseClients.get(taskId);
  if (!clients || !clients.length) {
    return;
  }
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients.slice()) {
    try {
      res.write(payload);
    } catch {
      // 如果写失败，移除该客户端
      const idx = clients.indexOf(res);
      if (idx !== -1) {
        clients.splice(idx, 1);
      }
    }
  }
}

app.get("/api/local-playlists", (req, res) => {
  try {
    const playlists = Object.values(loadLocalPlaylists()).toSorted(
      (a, b) => (b.createdAt || 0) - (a.createdAt || 0),
    );
    res.json(playlists);
  } catch (error) {
    console.error("获取本地播放列表失败:", error);
    res.status(500).json({ error: error.message || "获取本地播放列表失败" });
  }
});

app.get("/api/local-playlists/:playlistId", (req, res) => {
  try {
    const playlists = loadLocalPlaylists();
    const playlist = playlists[req.params.playlistId];
    if (!playlist) {
      return res.status(404).json({ error: "播放列表不存在" });
    }
    res.json(playlist);
  } catch (error) {
    console.error("获取本地播放列表详情失败:", error);
    res.status(500).json({ error: error.message || "获取本地播放列表详情失败" });
  }
});

app.post("/api/local-playlists/upload", upload.array("files", 50), async (req, res) => {
  const tempFiles = Array.isArray(req.files) ? req.files : [];
  try {
    if (!tempFiles.length) {
      return res.status(400).json({ error: "请至少上传一个视频文件" });
    }

    const playlistName =
      sanitizeOutputFileBaseName(req.body?.playlistName) ||
      `本地播放列表 ${new Date().toLocaleString("zh-CN")}`;
    const playlistId = makeLocalPlaylistId("upload");
    const playlistDir = path.join(getLocalPlaylistRootDir(), playlistId);
    ensureDir(playlistDir);

    const items = tempFiles.map((file, index) => {
      const originalName = maybeFixMojibakeFilename(file.originalname);
      const ext = path.extname(originalName || file.filename || ".mp4") || ".mp4";
      const baseName =
        sanitizeOutputFileBaseName(path.basename(originalName || file.filename, ext)) ||
        `video-${index + 1}`;
      const finalName = `${String(index + 1).padStart(2, "0")}-${baseName}${ext}`;
      const finalPath = path.join(playlistDir, finalName);
      fs.renameSync(file.path, finalPath);
      const stat = fs.statSync(finalPath);

      return {
        id: `${playlistId}-${index + 1}`,
        title: baseName,
        fileName: finalName,
        order: index,
        size: stat.size,
        url: createPlaylistItemUrl(playlistId, finalName),
      };
    });

    const playlist = buildLocalPlaylistRecord({
      id: playlistId,
      name: playlistName,
      kind: "uploaded",
      items,
    });

    const playlists = loadLocalPlaylists();
    playlists[playlistId] = playlist;
    saveLocalPlaylists(playlists);

    res.json(playlist);
  } catch (error) {
    console.error("批量上传本地播放列表失败:", error);
    tempFiles.forEach((file) => {
      try {
        if (file?.path && fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
        }
      } catch {
        // ignore cleanup errors
      }
    });
    res.status(500).json({ error: error.message || "批量上传本地播放列表失败" });
  }
});

app.post("/api/local-playlists/split-demo", async (req, res) => {
  try {
    const demoPath = path.join(__dirname, "demo.mp4");
    const segmentSeconds = Number(req.body?.segmentSeconds || 30);
    const playlistId = makeLocalPlaylistId("demo");
    const playlistName = `demo.mp4 切分 ${Math.max(5, segmentSeconds)} 秒段`;
    const playlist = await splitVideoToPlaylist({
      inputPath: demoPath,
      playlistId,
      playlistName,
      segmentSeconds,
    });

    const playlists = loadLocalPlaylists();
    playlists[playlistId] = playlist;
    saveLocalPlaylists(playlists);

    res.json(playlist);
  } catch (error) {
    console.error("切分 demo.mp4 失败:", error);
    res.status(500).json({ error: error.message || "切分 demo.mp4 失败" });
  }
});

app.get("/api/wecom-playlists", (req, res) => {
  try {
    const playlists = Object.values(loadWecomPlaylists()).toSorted(
      (a, b) => (b.createdAt || 0) - (a.createdAt || 0),
    );
    res.json(playlists);
  } catch (error) {
    console.error("获取企业微信播放列表失败:", error);
    res.status(500).json({ error: error.message || "获取企业微信播放列表失败" });
  }
});

app.get("/api/wecom-playlists/:playlistId", async (req, res) => {
  try {
    const playlists = loadWecomPlaylists();
    const playlist = playlists[req.params.playlistId];
    if (!playlist) {
      return res.status(404).json({ error: "企业微信播放列表不存在" });
    }

    const accessToken = await getWecomAccessToken();
    const tokenExpiresAt = wecomTokenCache.expiresAt || 0;
    const enriched = {
      ...playlist,
      tokenExpiresAt,
      items: (playlist.items || []).map((item) => ({
        ...item,
        directUrl: item.mediaId ? buildWecomDirectMediaUrl(accessToken, item.mediaId) : "",
        playbackUrl: item.mediaId
          ? buildWecomDirectMediaUrl(accessToken, item.mediaId)
          : item.playbackUrl || "",
      })),
    };

    res.json(enriched);
  } catch (error) {
    console.error("获取企业微信播放列表详情失败:", error);
    res.status(500).json({ error: error.message || "获取企业微信播放列表详情失败" });
  }
});

app.get("/api/wecom-playlists/:playlistId/index.m3u8", async (req, res) => {
  try {
    const playlists = loadWecomPlaylists();
    const playlist = playlists[req.params.playlistId];
    if (!playlist) {
      return res.status(404).json({ error: "企业微信播放列表不存在" });
    }

    const segmentDuration = inferSegmentDurationFromPlaylistName(playlist.name, 30);
    const accessToken = await getWecomAccessToken();
    const lines = [
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      "#EXT-X-PLAYLIST-TYPE:VOD",
      "#EXT-X-INDEPENDENT-SEGMENTS",
      `#EXT-X-TARGETDURATION:${Math.max(1, Math.ceil(segmentDuration))}`,
      "#EXT-X-MEDIA-SEQUENCE:0",
    ];

    (playlist.items || []).forEach((item, index) => {
      const absoluteUrl = item.mediaId ? buildWecomDirectMediaUrl(accessToken, item.mediaId) : "";
      lines.push(
        `#EXTINF:${Number(item.duration || segmentDuration).toFixed(3)},${item.title || `segment-${index + 1}`}`,
      );
      lines.push(absoluteUrl);
    });

    lines.push("#EXT-X-ENDLIST");

    res.setHeader("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
    res.send(lines.join("\n"));
  } catch (error) {
    console.error("生成企业微信 m3u8 失败:", error);
    res.status(500).json({ error: error.message || "生成企业微信 m3u8 失败" });
  }
});

app.get("/api/wecom-playlists/:playlistId/segments/:segmentIndex.ts", async (req, res) => {
  try {
    const playlists = loadWecomPlaylists();
    const playlist = playlists[req.params.playlistId];
    if (!playlist) {
      return res.status(404).json({ error: "企业微信播放列表不存在" });
    }

    const index = Math.max(0, Number(req.params.segmentIndex || 0));
    const item = (playlist.items || [])[index];
    if (!item) {
      return res.status(404).json({ error: "企业微信播放分片不存在" });
    }

    const tsPath = await ensureWecomTsSegmentCached({
      req,
      playlistId: req.params.playlistId,
      item,
      index,
    });

    res.setHeader("Content-Type", "video/mp2t");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    fs.createReadStream(tsPath).pipe(res);
  } catch (error) {
    console.error("生成企业微信 TS 分片失败:", error);
    res.status(500).json({ error: error.message || "生成企业微信 TS 分片失败" });
  }
});

app.post("/api/wecom-playlists/from-local/:playlistId", async (req, res) => {
  try {
    const sourcePlaylistId = String(req.params?.playlistId || "").trim();
    const sourcePlaylists = loadLocalPlaylists();
    const sourcePlaylist = sourcePlaylists[sourcePlaylistId];

    if (!sourcePlaylist) {
      return res.status(404).json({ error: "本地播放列表不存在" });
    }

    if (!Array.isArray(sourcePlaylist.items) || !sourcePlaylist.items.length) {
      return res.status(400).json({ error: "本地播放列表没有可上传的视频片段" });
    }

    const limit = Math.max(1, Number(req.body?.limit || sourcePlaylist.items.length));
    const selectedItems = sourcePlaylist.items.slice(0, limit);
    const playlistId = makeLocalPlaylistId("wecom");
    const playlistName =
      sanitizeOutputFileBaseName(req.body?.playlistName) || `${sourcePlaylist.name} - 企微播放列表`;
    const segmentDuration = inferSegmentDurationFromPlaylistName(sourcePlaylist.name, 30);
    const playlistItems = [];
    const failures = [];

    for (let index = 0; index < selectedItems.length; index += 1) {
      const item = selectedItems[index];
      const relativePath = String(item.url || "").replace(/^\/uploads\//, "");
      const filePath = path.join(getUploadsDir(), relativePath);

      if (!fs.existsSync(filePath)) {
        failures.push({
          order: index,
          title: item.title,
          error: `文件不存在: ${filePath}`,
        });
        continue;
      }

      try {
        const wecomResult = await uploadLocalFileToWecom({
          filePath,
          fileName: item.fileName || `${item.title || `segment-${index + 1}`}.mp4`,
          type: "video",
        });
        const mediaId = wecomResult.media_id || "";
        const playbackPath = mediaId ? `/api/wecom/media/${encodeURIComponent(mediaId)}` : "";
        playlistItems.push({
          id: `${playlistId}-${index + 1}`,
          sourceTitle: item.title,
          title: item.title,
          order: index,
          duration: segmentDuration,
          fileName: item.fileName || "",
          size: item.size || 0,
          mediaId,
          createdAt: wecomResult.created_at || "",
          playbackPath,
          playbackUrl: playbackPath ? buildAbsoluteUrl(req, playbackPath) : "",
        });
      } catch (error) {
        failures.push({
          order: index,
          title: item.title,
          size: item.size || error.fileSize || 0,
          error: error.message || "上传失败",
          raw: error.raw || null,
        });
      }
    }

    const playlist = {
      id: playlistId,
      name: playlistName,
      kind: "wecom",
      sourcePlaylistId,
      createdAt: Date.now(),
      segmentDuration,
      itemCount: playlistItems.length,
      requestedCount: selectedItems.length,
      failedCount: failures.length,
      items: playlistItems,
      failures,
    };

    const playlists = loadWecomPlaylists();
    playlists[playlistId] = playlist;
    saveWecomPlaylists(playlists);

    res.json(playlist);
  } catch (error) {
    console.error("从本地列表生成企业微信播放列表失败:", error.response?.data || error.message);
    res.status(500).json({ error: error.message || "从本地列表生成企业微信播放列表失败" });
  }
});

// 上传文件API
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "没有文件被上传" });
    }

    const { filePath, version, fileName, description } = req.body;

    if (!filePath || !version) {
      return res.status(400).json({ error: "缺少必需参数：filePath 和 version" });
    }

    // 构建请求URL
    let url = `${ALIYUN_CONFIG.baseUrl}/files/${filePath}?version=${encodeURIComponent(version)}`;
    if (fileName) {
      url += `&fileName=${encodeURIComponent(fileName)}`;
    }
    if (description) {
      url += `&versionDescription=${encodeURIComponent(description)}`;
    }

    console.log("上传文件 - 请求阿里云URL:", url); // 调试日志

    // 准备表单数据（使用流，避免在内存中持有整个文件）
    const formData = new FormData();
    const readStream = fs.createReadStream(req.file.path);
    formData.append("file", readStream, {
      filename: fileName || req.file.originalname,
      contentType: req.file.mimetype || "application/octet-stream",
    });

    // 发送请求到阿里云（将表单头合并）
    const response = await axios.post(url, formData, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${ALIYUN_CONFIG.auth.username}:${ALIYUN_CONFIG.auth.password}`).toString("base64")}`,
        ...formData.getHeaders(),
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });

    // 删除临时上传的文件
    fs.unlinkSync(req.file.path);

    res.json(response.data);
  } catch (error) {
    console.error("上传错误:", error);

    // 删除临时上传的文件（如果存在）
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }

    res.status(500).json({
      error: error.response?.data || error.message || "上传失败",
    });
  }
});

// 视频压缩API - 创建后台任务（基于上传文件的 SHA256 作为任务ID，防止重复压缩）
app.post("/api/compress", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "没有文件被上传" });
    }

    const { quality = "medium", format = "mp4", outputFileName } = req.body;

    // 计算上传文件的 SHA256 作为任务ID
    const crypto = require("crypto");
    const hash = crypto.createHash("sha256");
    await new Promise((resolve, reject) => {
      const rs = fs.createReadStream(req.file.path);
      rs.on("data", (chunk) => hash.update(chunk));
      rs.on("end", resolve);
      rs.on("error", reject);
    });
    const taskId = hash.digest("hex");

    // load or init tasks store
    const uploadsDir = path.join(__dirname, "uploads");
    const tasksFile = path.join(uploadsDir, "tasks.json");
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    let tasks = {};
    try {
      tasks = fs.existsSync(tasksFile) ? JSON.parse(fs.readFileSync(tasksFile, "utf8")) : {};
    } catch {
      tasks = {};
    }

    // 如果已有任务
    if (tasks[taskId]) {
      const t = tasks[taskId];
      // 如果已完成并且输出文件仍存在，直接返回
      if (t.status === "done" && fs.existsSync(path.join(uploadsDir, t.filename || ""))) {
        // 删除上传临时文件
        try {
          if (fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
          }
        } catch {}
        return res.json({
          taskId,
          status: "done",
          filename: t.filename,
          url: `/uploads/${t.filename}`,
        });
      }

      // 如果正在压缩，清理上传临时文件并返回任务正在进行
      if (t.status === "compressing") {
        try {
          if (fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
          }
        } catch {}
        return res.json({ taskId, status: "compressing" });
      }

      // 如果之前失败或文件丢失，允许重新开始（覆盖之前记录）
    }

    // 创建任务记录
    let crf = "28";
    if (quality === "high") {
      crf = "23";
    } else if (quality === "low") {
      crf = "32";
    }

    // 处理用户指定的输出文件名（防止路径穿越与非法字符；保留中文等 Unicode）
    let outName;
    if (outputFileName && String(outputFileName).trim()) {
      const base = sanitizeOutputFileBaseName(outputFileName);
      const safe = base || "compressed";
      const ext = format === "webm" ? ".webm" : ".mp4";
      // If user provided some extension, ignore it and enforce the selected output ext
      const nameNoExt = safe.replace(/\.[^/.]+$/, "");
      outName = nameNoExt.endsWith(ext) ? nameNoExt : nameNoExt + ext;
    } else {
      // use original filename base as default
      const origBase = path.basename(req.file.originalname).replace(/\.[^/.]+$/, "");
      const ext = format === "webm" ? ".webm" : ".mp4";
      outName = `${origBase}-compressed${ext}`;
    }

    // 若文件已存在，追加时间戳，确保不覆盖
    let finalName = outName;
    if (fs.existsSync(path.join(uploadsDir, finalName))) {
      const p = path.parse(outName);
      finalName = `${p.name}-${Date.now()}${p.ext}`;
    }

    // 初始化并保存任务
    tasks[taskId] = {
      id: taskId,
      status: "compressing",
      filename: finalName,
      originalName: maybeFixMojibakeFilename(req.file.originalname),
      size: req.file.size,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      quality,
      format,
      stderr: "",
    };
    fs.writeFileSync(tasksFile, JSON.stringify(tasks, null, 2));

    // 后台执行压缩（并不会阻塞响应）
    void (async () => {
      const inputPath = req.file.path;
      const outPath = path.join(uploadsDir, finalName);
      const ffmpegPath = resolveFfmpegPath();

      if (!ffmpegPath) {
        tasks[taskId].status = "failed";
        tasks[taskId].updatedAt = Date.now();
        tasks[taskId].stderr = "未找到可用的 ffmpeg：请先安装到系统环境或将 ffmpeg 放在项目根目录";
        fs.writeFileSync(tasksFile, JSON.stringify(tasks, null, 2));
        sendSSE(taskId, "failed", { error: tasks[taskId].stderr });
        try {
          if (fs.existsSync(inputPath)) {
            fs.unlinkSync(inputPath);
          }
        } catch {}
        return;
      }

      // 尝试获取输入视频时长（秒），以便估算进度
      let durationSeconds = null;
      try {
        durationSeconds = await new Promise((resolve) => {
          const p = spawn(ffmpegPath, ["-i", inputPath]);
          let stderr = "";
          p.stderr.on("data", (d) => (stderr += d.toString()));
          p.on("close", () => {
            const m = stderr.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2}\.\d+)/);
            if (m) {
              const h = parseInt(m[1], 10),
                mm = parseInt(m[2], 10),
                ss = parseFloat(m[3]);
              resolve(h * 3600 + mm * 60 + ss);
            } else {
              resolve(null);
            }
          });
          p.on("error", () => resolve(null));
        });
      } catch {
        durationSeconds = null;
      }
      tasks[taskId].duration = durationSeconds;
      fs.writeFileSync(tasksFile, JSON.stringify(tasks, null, 2));

      let args = ["-y", "-i", inputPath];
      if (format === "webm") {
        args = args.concat(["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", crf, "-c:a", "libopus"]);
      } else {
        args = args.concat([
          "-c:v",
          "libx264",
          "-crf",
          crf,
          "-preset",
          "medium",
          "-c:a",
          "aac",
          "-b:a",
          "128k",
        ]);
      }
      args.push(outPath);

      console.log("后台执行 ffmpeg:", ffmpegPath, args.join(" "));
      const ff = spawn(ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] });

      ff.stderr.on("data", (data) => {
        const chunk = data.toString();
        // 保存日志
        tasks[taskId].stderr += chunk;
        tasks[taskId].updatedAt = Date.now();

        // 尝试解析时间点以估算进度（例如: time=00:00:05.00）
        const m = chunk.match(/time=(\d{2}):(\d{2}):(\d{2}\.\d+)/);
        if (m && durationSeconds) {
          const h = parseInt(m[1], 10),
            mm = parseInt(m[2], 10),
            ss = parseFloat(m[3]);
          const t = h * 3600 + mm * 60 + ss;
          const percent = Math.min(100, Math.round((t / durationSeconds) * 100));
          tasks[taskId].progress = percent;
          try {
            fs.writeFileSync(tasksFile, JSON.stringify(tasks, null, 2));
          } catch {}
          sendSSE(taskId, "progress", { percent });
        }

        // 发送日志事件（截断大小）
        const snippet = chunk.length > 1000 ? chunk.slice(-1000) : chunk;
        sendSSE(taskId, "log", { text: snippet });
        try {
          fs.writeFileSync(tasksFile, JSON.stringify(tasks, null, 2));
        } catch {}
      });

      ff.on("close", (code) => {
        // 删除临时上传文件
        try {
          if (fs.existsSync(inputPath)) {
            fs.unlinkSync(inputPath);
          }
        } catch {}
        if (code === 0) {
          tasks[taskId].status = "done";
          tasks[taskId].url = `/uploads/${tasks[taskId].filename}`;
          tasks[taskId].updatedAt = Date.now();
          try {
            fs.writeFileSync(tasksFile, JSON.stringify(tasks, null, 2));
          } catch {}
          sendSSE(taskId, "done", { url: tasks[taskId].url, filename: tasks[taskId].filename });
        } else {
          tasks[taskId].status = "failed";
          tasks[taskId].updatedAt = Date.now();
          try {
            fs.writeFileSync(tasksFile, JSON.stringify(tasks, null, 2));
          } catch {}
          // 删除输出文件若存在
          try {
            if (fs.existsSync(outPath)) {
              fs.unlinkSync(outPath);
            }
          } catch {}
          sendSSE(taskId, "failed", { error: "ffmpeg 退出错误", stderr: tasks[taskId].stderr });
        }
      });

      ff.on("error", (err) => {
        tasks[taskId].status = "failed";
        tasks[taskId].stderr += `\nffmpeg 启动错误: ${err.message}`;
        tasks[taskId].updatedAt = Date.now();
        try {
          fs.writeFileSync(tasksFile, JSON.stringify(tasks, null, 2));
        } catch {}
        sendSSE(taskId, "failed", { error: err.message });
      });
    })();

    // 返回任务信息（不等待压缩完成）
    res.json({ taskId, status: "compressing" });
  } catch (error) {
    console.error("压缩任务创建错误:", error);
    if (req.file && fs.existsSync(req.file.path)) {
      try {
        fs.unlinkSync(req.file.path);
      } catch {}
    }
    res.status(500).json({ error: error.message || "创建压缩任务失败" });
  }
});

// 列出 uploads 目录中任务（包含进行中/已完成/失败的任务）
app.get("/api/compressed-list", async (req, res) => {
  try {
    const uploadsDir = path.join(__dirname, "uploads");
    const tasksFile = path.join(uploadsDir, "tasks.json");
    let tasks = {};
    try {
      tasks = fs.existsSync(tasksFile) ? JSON.parse(fs.readFileSync(tasksFile, "utf8")) : {};
    } catch {
      tasks = {};
    }

    // Normalize task entries and ensure done url exists
    const taskList = Object.values(tasks).map((t) => {
      const filename = t.filename || t.name;
      const filePath = filename ? path.join(uploadsDir, filename) : null;
      const fileExists = filePath ? fs.existsSync(filePath) : false;
      const status = t.status === "done" && !fileExists ? "failed" : t.status;
      const url = status === "done" && filename ? `/uploads/${filename}` : null;
      return {
        id: t.id,
        name: filename,
        originalName: maybeFixMojibakeFilename(t.originalName),
        status,
        url,
        size: t.size,
        mtime: t.updatedAt || t.createdAt,
      };
    });

    // Also include any compressed output files in uploads folder that are not in tasks.json
    let extraFiles = [];
    try {
      if (fs.existsSync(uploadsDir)) {
        const known = new Set(taskList.map((x) => x.name).filter(Boolean));
        const files = fs.readdirSync(uploadsDir);
        extraFiles = files
          .filter((name) => name && name !== "tasks.json")
          .filter((name) => /\.(mp4|webm|mov|mkv)$/i.test(name))
          .filter((name) => !known.has(name))
          .map((name) => {
            const stat = fs.statSync(path.join(uploadsDir, name));
            return {
              id: `file:${name}`,
              name,
              originalName: null,
              status: "done",
              url: `/uploads/${name}`,
              size: stat.size,
              mtime: stat.mtimeMs,
            };
          });
      }
    } catch {
      extraFiles = [];
    }

    const list = taskList.concat(extraFiles).toSorted((a, b) => (b.mtime || 0) - (a.mtime || 0));
    res.json(list);
  } catch (error) {
    console.error("获取压缩文件列表错误:", error);
    res.status(500).json({ error: error.message || "获取列表失败" });
  }
});

// 获取单个任务状态
app.get("/api/compress/:taskId", async (req, res) => {
  try {
    const { taskId } = req.params;
    const uploadsDir = path.join(__dirname, "uploads");
    const tasksFile = path.join(uploadsDir, "tasks.json");
    let tasks = {};
    try {
      tasks = fs.existsSync(tasksFile) ? JSON.parse(fs.readFileSync(tasksFile, "utf8")) : {};
    } catch {
      tasks = {};
    }

    const t = tasks[taskId];
    if (!t) {
      return res.status(404).json({ error: "任务未找到" });
    }
    // Fix name encoding on the fly for client display
    return res.json({
      ...t,
      originalName: maybeFixMojibakeFilename(t.originalName),
    });
  } catch (error) {
    console.error("获取任务状态错误:", error);
    res.status(500).json({ error: error.message || "获取任务失败" });
  }
});

// SSE: 订阅指定任务的实时事件
app.get("/api/compress/:taskId/events", (req, res) => {
  const { taskId } = req.params;
  // 设置 SSE 响应头
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }

  // 将客户端加入到订阅列表
  if (!sseClients.has(taskId)) {
    sseClients.set(taskId, []);
  }
  const clients = sseClients.get(taskId);
  clients.push(res);

  // 当连接关闭时移除客户端
  req.on("close", () => {
    const idx = clients.indexOf(res);
    if (idx !== -1) {
      clients.splice(idx, 1);
    }
  });
});

// 下载文件API
app.get("/api/download", async (req, res) => {
  try {
    const filePath = getQueryStringValue(req.query?.filePath).trim();
    const version = getQueryStringValue(req.query?.version).trim();

    if (!filePath || !version) {
      return res.status(400).json({ error: "缺少必需参数：filePath 和 version" });
    }

    // 构建请求URL
    const urlParams = new URLSearchParams({ version });
    const url = `${ALIYUN_CONFIG.baseUrl}/files/${filePath}?${urlParams.toString()}`;

    // 发送请求到阿里云
    const response = await axios({
      method: "GET",
      url: url,
      headers: {
        Authorization: `Basic ${Buffer.from(`${ALIYUN_CONFIG.auth.username}:${ALIYUN_CONFIG.auth.password}`).toString("base64")}`,
      },
      responseType: "stream",
    });

    // 将响应转发给客户端
    response.data.pipe(res);
  } catch (error) {
    console.error("下载错误:", error);
    res.status(500).json({
      error: error.response?.data || error.message || "下载失败",
    });
  }
});

// 获取下载链接API
app.get("/api/get-download-link", async (req, res) => {
  try {
    const filePath = getQueryStringValue(req.query?.filePath).trim();
    const version = getQueryStringValue(req.query?.version).trim();
    const expirationDays = getQueryStringValue(req.query?.expirationDays).trim() || "7";

    if (!filePath || !version) {
      return res.status(400).json({ error: "缺少必需参数：filePath 和 version" });
    }

    // 计算过期时间戳
    const expiration = Date.now() + parseInt(expirationDays) * 24 * 60 * 60 * 1000;

    // 构建请求URL - 对路径部分进行适当的编码
    const encodedFilePath = encodeURIComponent(filePath).replace(/%2F/g, "/"); // 保留路径分隔符
    const url = `${ALIYUN_CONFIG.baseUrl}/files/${encodedFilePath}?version=${encodeURIComponent(version)}&signUrl=true&expiration=${expiration}`;

    console.log("获取下载链接 - 请求阿里云URL:", url); // 调试日志

    // 发送HEAD请求到阿里云
    const response = await axios({
      method: "HEAD",
      url: url,
      headers: {
        Authorization: `Basic ${Buffer.from(`${ALIYUN_CONFIG.auth.username}:${ALIYUN_CONFIG.auth.password}`).toString("base64")}`,
      },
      validateStatus: function (status) {
        // 接受2xx和4xx状态码，让错误处理在下面进行
        return status < 500;
      },
    });

    // 检查响应状态码
    if (response.status >= 400) {
      // 对于HEAD请求，即使返回404也要尝试读取响应头，因为有些服务器会在404响应中也包含有用的信息
      if (response.status === 404) {
        console.log(`文件不存在: filePath=${filePath}, version=${version}`);
        throw new Error(
          `文件不存在或路径错误: 请确认文件路径 "${filePath}" 和版本 "${version}" 是否正确，以及该文件是否已上传到阿里云制品仓库`,
        );
      } else {
        throw new Error(`阿里云API返回错误: ${response.status} ${response.statusText}`);
      }
    }

    // 从响应头中提取信息
    const headers = response.headers;
    const result = {
      downloadUrl: headers["x-artlab-generic-sign-url"],
      sha1: headers["x-artlab-checksum-sha1"],
      sha256: headers["x-artlab-checksum-sha256"],
      md5: headers["x-artlab-checksum-md5"],
      versionDescription: headers["x-artlab-generic-version-description"],
    };

    // 检查是否成功获取了下载链接
    if (!result.downloadUrl) {
      console.log("警告: 未从响应头中获取到下载链接");
      throw new Error("未能生成有效的下载链接，请确认文件路径和版本是否正确");
    }

    res.json(result);
  } catch (error) {
    console.error("获取下载链接错误:", error);
    res.status(500).json({
      error: error.response?.data || error.message || "获取下载链接失败",
    });
  }
});

// 提供静态文件服务
app.use(express.static(path.join(__dirname)));

// 根路径重定向到工具使用页
app.get("/", (req, res) => {
  // 登录状态存储在浏览器 localStorage，服务端无法读取；统一返回登录页，
  // login.html 会在已登录时自动跳转到 simple-upload.html。
  res.sendFile(path.join(__dirname, "login.html"));
});

// 启动服务器
app.listen(PORT, () => {
  console.log(`代理服务器运行在 http://localhost:${PORT}`);
  console.log(`上传API: POST http://localhost:${PORT}/api/upload`);
  console.log(`下载API: GET http://localhost:${PORT}/api/download?filePath=X&version=Y`);
  console.log(
    `获取链接API: GET http://localhost:${PORT}/api/get-download-link?filePath=X&version=Y&expirationDays=Z`,
  );
  console.log(`压缩API: POST http://localhost:${PORT}/api/compress (返回 taskId)`);
  console.log(`任务状态: GET http://localhost:${PORT}/api/compress/:taskId`);
  console.log(`压缩列表: GET http://localhost:${PORT}/api/compressed-list`);
  console.log("\n按 Ctrl+C 停止服务器");
});

module.exports = app;

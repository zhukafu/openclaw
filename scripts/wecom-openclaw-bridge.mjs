#!/usr/bin/env node

import crypto from "node:crypto";
import { spawn } from "node:child_process";
import process from "node:process";
import dotenv from "dotenv";
import express from "express";

dotenv.config();

const jsonParser = express.json({ limit: "1mb" });
const textParser = express.text({ type: "*/*", limit: "1mb" });

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name, fallback = "") {
  return process.env[name]?.trim() || fallback;
}

function parseBoolean(value, fallback = false) {
  if (!value) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parseCsv(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

const config = {
  host: optionalEnv("BRIDGE_HOST", "127.0.0.1"),
  port: Number(optionalEnv("BRIDGE_PORT", "8787")),
  callbackPath: optionalEnv("WECOM_CALLBACK_PATH", "/wecom/callback"),
  corpId: requiredEnv("WECOM_CORP_ID"),
  agentId: requiredEnv("WECOM_AGENT_ID"),
  secret: requiredEnv("WECOM_SECRET"),
  token: requiredEnv("WECOM_TOKEN"),
  aesKey: requiredEnv("WECOM_AES_KEY"),
  receiveId: optionalEnv("WECOM_RECEIVE_ID") || requiredEnv("WECOM_CORP_ID"),
  bridgeAdminToken: optionalEnv("BRIDGE_ADMIN_TOKEN"),
  openclawExecMode: optionalEnv("OPENCLAW_EXEC_MODE", "cli"),
  openclawBin: optionalEnv("OPENCLAW_BIN", "openclaw"),
  openclawAgentId: optionalEnv("OPENCLAW_AGENT_ID", "sales"),
  openclawThinking: optionalEnv("OPENCLAW_THINKING", "low"),
  openclawHooksUrl: optionalEnv("OPENCLAW_HOOKS_URL", "http://127.0.0.1:18789/hooks/agent"),
  openclawHooksToken: optionalEnv("OPENCLAW_HOOKS_TOKEN"),
  notifyInternal: parseBoolean(optionalEnv("WECOM_NOTIFY_INTERNAL", "true"), true),
  defaultNotifyUserId: optionalEnv("WECOM_DEFAULT_NOTIFY_USERID"),
  defaultGroupSender: optionalEnv("DEFAULT_GROUP_MSG_SENDER"),
  defaultGroupChatIds: parseCsv(optionalEnv("DEFAULT_GROUP_CHAT_IDS")),
  encryptResponse: parseBoolean(optionalEnv("WECOM_ENCRYPT_RESPONSE", "false"), false),
};

const aesKey = Buffer.from(`${config.aesKey}=`, "base64");
if (aesKey.length !== 32) {
  throw new Error("WECOM_AES_KEY is invalid: expected 43-char EncodingAESKey");
}

const recentEvents = new Map();
const RECENT_EVENT_TTL_MS = 10 * 60 * 1000;

function pruneRecentEvents(now = Date.now()) {
  for (const [key, value] of recentEvents.entries()) {
    if (value.expiresAt <= now) {
      recentEvents.delete(key);
    }
  }
}

function rememberEvent(key) {
  pruneRecentEvents();
  if (!key) {
    return false;
  }
  if (recentEvents.has(key)) {
    return true;
  }
  recentEvents.set(key, { expiresAt: Date.now() + RECENT_EVENT_TTL_MS });
  return false;
}

function sha1Signature(parts) {
  const joined = [...parts].sort().join("");
  return crypto.createHash("sha1").update(joined).digest("hex");
}

function pkcs7Pad(buffer) {
  const blockSize = 32;
  const padding = blockSize - (buffer.length % blockSize || blockSize);
  return Buffer.concat([buffer, Buffer.alloc(padding || blockSize, padding || blockSize)]);
}

function pkcs7Unpad(buffer) {
  const padding = buffer[buffer.length - 1];
  if (padding < 1 || padding > 32) {
    throw new Error("Invalid PKCS7 padding");
  }
  return buffer.subarray(0, buffer.length - padding);
}

function decryptEncryptedMessage(encrypted) {
  const decipher = crypto.createDecipheriv("aes-256-cbc", aesKey, aesKey.subarray(0, 16));
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encrypted, "base64")),
    decipher.final(),
  ]);
  const unpadded = pkcs7Unpad(decrypted);
  const content = unpadded.subarray(16);
  const msgLength = content.readUInt32BE(0);
  const xmlBuffer = content.subarray(4, 4 + msgLength);
  const receiveId = content.subarray(4 + msgLength).toString("utf8");
  if (receiveId !== config.receiveId) {
    throw new Error(`ReceiveId mismatch: expected ${config.receiveId}, got ${receiveId}`);
  }
  return xmlBuffer.toString("utf8");
}

function encryptReplyXml(xml, timestamp, nonce) {
  const random = crypto.randomBytes(16);
  const msgBuffer = Buffer.from(xml, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(msgBuffer.length, 0);
  const payload = pkcs7Pad(
    Buffer.concat([random, length, msgBuffer, Buffer.from(config.receiveId, "utf8")]),
  );
  const cipher = crypto.createCipheriv("aes-256-cbc", aesKey, aesKey.subarray(0, 16));
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]).toString("base64");
  const signature = sha1Signature([config.token, String(timestamp), nonce, encrypted]);
  return buildXml({
    Encrypt: encrypted,
    MsgSignature: signature,
    TimeStamp: String(timestamp),
    Nonce: nonce,
  });
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function buildXml(values) {
  const parts = Object.entries(values).map(([key, value]) => {
    if (key === "TimeStamp" || key === "CreateTime") {
      return `<${key}>${xmlEscape(value)}</${key}>`;
    }
    return `<${key}><![CDATA[${String(value)}]]></${key}>`;
  });
  return `<xml>${parts.join("")}</xml>`;
}

function parseXmlValues(xml) {
  const values = {};
  const regex = /<([A-Za-z0-9_]+)>(?:<!\[CDATA\[(.*?)\]\]>|([^<]*))<\/\1>/gs;
  for (const match of xml.matchAll(regex)) {
    const [, key, cdataValue, plainValue] = match;
    values[key] = (cdataValue ?? plainValue ?? "").trim();
  }
  return values;
}

function buildEventFingerprint(event) {
  const fields = [
    event.MsgId,
    event.Event,
    event.ChangeType,
    event.FromUserName,
    event.ExternalUserID,
    event.ChatId,
    event.UpdateTime,
    event.CreateTime,
  ].filter(Boolean);
  return fields.join(":");
}

function chooseSessionKey(event) {
  const externalUserId = event.ExternalUserID || event.UserID || event.FromUserName;
  const chatId = event.ChatId || event.ChatID;
  if (chatId) {
    return `wecom:group:${chatId}`;
  }
  if (externalUserId) {
    return `wecom:contact:${externalUserId}`;
  }
  return `wecom:event:${Date.now()}`;
}

function buildPrompt(event, plainXml) {
  const lines = [
    "你是企业微信客户关系数字员工，目标是帮助销售维护客户关系、提升转化。",
    "请基于下面的企业微信事件，输出：",
    "1. 客户状态判断",
    "2. 建议跟进行动",
    "3. 推荐发送文案",
    "4. 是否需要拉群/群发/人工介入",
    "要求：简洁、可执行、避免空话。",
    "",
    "事件摘要：",
  ];

  const summaryPairs = [
    ["MsgType", event.MsgType],
    ["Event", event.Event],
    ["ChangeType", event.ChangeType],
    ["FromUserName", event.FromUserName],
    ["ExternalUserID", event.ExternalUserID],
    ["ChatId", event.ChatId || event.ChatID],
    ["Content", event.Content],
    ["WelcomeCode", event.WelcomeCode],
  ].filter(([, value]) => value);

  for (const [key, value] of summaryPairs) {
    lines.push(`- ${key}: ${value}`);
  }

  lines.push("", "原始 XML：", plainXml);
  return lines.join("\n");
}

async function getAccessToken() {
  const url = new URL("https://qyapi.weixin.qq.com/cgi-bin/gettoken");
  url.searchParams.set("corpid", config.corpId);
  url.searchParams.set("corpsecret", config.secret);
  const response = await fetch(url);
  const payload = await response.json();
  if (!response.ok || payload.errcode) {
    throw new Error(`Failed to get WeCom access token: ${payload.errmsg || response.statusText}`);
  }
  return payload.access_token;
}

async function callWeComApi(path, { method = "POST", query = {}, body } = {}) {
  const accessToken = await getAccessToken();
  const url = new URL(`https://qyapi.weixin.qq.com${path}`);
  url.searchParams.set("access_token", accessToken);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok || payload.errcode) {
    throw new Error(`WeCom API ${path} failed: ${payload.errmsg || response.statusText}`);
  }
  return payload;
}

function ensureAdminToken(req, res, next) {
  if (!config.bridgeAdminToken) {
    next();
    return;
  }
  const auth = req.headers.authorization || "";
  if (auth === `Bearer ${config.bridgeAdminToken}`) {
    next();
    return;
  }
  res.status(401).json({ ok: false, error: "unauthorized" });
}

function spawnOpenClawAgent({ prompt, sessionKey }) {
  return new Promise((resolve, reject) => {
    const args = [
      "--no-color",
      "agent",
      "--agent",
      config.openclawAgentId,
      "--session-id",
      sessionKey,
      "--message",
      prompt,
      "--thinking",
      config.openclawThinking,
      "--json",
    ];
    const child = spawn(config.openclawBin, args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `openclaw exited with code ${code}`));
        return;
      }
      resolve(extractAgentText(stdout));
    });
  });
}

function extractAgentText(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return "";
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed.text === "string") {
      return parsed.text.trim();
    }
    if (typeof parsed.response === "string") {
      return parsed.response.trim();
    }
    if (typeof parsed.result === "string") {
      return parsed.result.trim();
    }
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(trimmed.slice(start, end + 1));
        if (typeof parsed.text === "string") {
          return parsed.text.trim();
        }
      } catch {
        // ignore
      }
    }
  }
  return trimmed;
}

async function postOpenClawHook({ prompt, sessionKey }) {
  if (!config.openclawHooksToken) {
    throw new Error("OPENCLAW_HOOKS_TOKEN is required when OPENCLAW_EXEC_MODE=hook");
  }
  const response = await fetch(config.openclawHooksUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.openclawHooksToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      agentId: config.openclawAgentId,
      sessionKey,
      message: prompt,
      name: "WeCom",
      wakeMode: "now",
      deliver: false,
      timeoutSeconds: 120,
      thinking: config.openclawThinking,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`OpenClaw hook failed: ${payload.error || response.statusText}`);
  }
  return "已提交到 OpenClaw hook，结果会写入 sales 会话。";
}

async function runOpenClaw({ prompt, sessionKey }) {
  if (config.openclawExecMode === "hook") {
    return postOpenClawHook({ prompt, sessionKey });
  }
  return spawnOpenClawAgent({ prompt, sessionKey });
}

async function sendInternalAppMessage({ toUser, content }) {
  if (!toUser) {
    return { skipped: true };
  }
  return callWeComApi("/cgi-bin/message/send", {
    body: {
      touser: toUser,
      msgtype: "text",
      agentid: Number(config.agentId),
      text: { content },
      safe: 0,
      enable_id_trans: 0,
      enable_duplicate_check: 0,
    },
  });
}

async function createGroupMessageTask({ sender, chatIdList, text, attachments = [] }) {
  return callWeComApi("/cgi-bin/externalcontact/add_msg_template", {
    body: {
      chat_type: "group",
      sender,
      chat_id_list: chatIdList,
      text: text ? { content: text } : undefined,
      attachments,
    },
  });
}

function selectNotifyUser(event) {
  return config.defaultNotifyUserId || event.FromUserName || event.UserID || "";
}

async function handleInboundEvent(event, plainXml) {
  const prompt = buildPrompt(event, plainXml);
  const sessionKey = chooseSessionKey(event);
  const result = await runOpenClaw({ prompt, sessionKey });
  if (!config.notifyInternal) {
    return;
  }
  const notifyUser = selectNotifyUser(event);
  const lines = [
    "【OpenClaw 客户助理】",
    `会话: ${sessionKey}`,
    "",
    result || "OpenClaw 已接收事件，但没有返回可展示文本。",
  ];
  await sendInternalAppMessage({ toUser: notifyUser, content: lines.join("\n") });
}

function extractCronText(payload) {
  const candidates = [
    payload.summary,
    payload.result,
    payload.text,
    payload.content,
    payload.message,
    payload.output,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return "";
}

const app = express();

app.get("/healthz", (_req, res) => {
  res.json({
    ok: true,
    callbackPath: config.callbackPath,
    openclawExecMode: config.openclawExecMode,
    openclawAgentId: config.openclawAgentId,
  });
});

app.get(config.callbackPath, (req, res) => {
  try {
    const msgSignature = String(req.query.msg_signature || "");
    const timestamp = String(req.query.timestamp || "");
    const nonce = String(req.query.nonce || "");
    const echoStr = decodeURIComponent(String(req.query.echostr || ""));
    const expectedSignature = sha1Signature([config.token, timestamp, nonce, echoStr]);
    if (!msgSignature || msgSignature !== expectedSignature) {
      res.status(401).send("invalid signature");
      return;
    }
    const plain = decryptEncryptedMessage(echoStr);
    res.type("text/plain").send(plain);
  } catch (error) {
    res.status(400).send(String(error.message || error));
  }
});

app.post(config.callbackPath, textParser, (req, res) => {
  const timestamp = String(req.query.timestamp || Math.floor(Date.now() / 1000));
  const nonce = String(req.query.nonce || crypto.randomBytes(8).toString("hex"));
  try {
    const msgSignature = String(req.query.msg_signature || "");
    const envelope = parseXmlValues(req.body || "");
    const encrypted = envelope.Encrypt;
    const expectedSignature = sha1Signature([config.token, timestamp, nonce, encrypted]);
    if (!encrypted || !msgSignature || msgSignature !== expectedSignature) {
      res.status(401).send("invalid signature");
      return;
    }
    const plainXml = decryptEncryptedMessage(encrypted);
    const event = parseXmlValues(plainXml);
    const fingerprint = buildEventFingerprint(event);
    if (rememberEvent(fingerprint)) {
      res.type("text/plain").send("success");
      return;
    }
    const ack = config.encryptResponse
      ? encryptReplyXml(
          buildXml({
            ToUserName: event.FromUserName || config.corpId,
            FromUserName: event.ToUserName || "openclaw-bridge",
            CreateTime: Math.floor(Date.now() / 1000),
            MsgType: "text",
            Content: "success",
          }),
          timestamp,
          nonce,
        )
      : "success";
    res.type(config.encryptResponse ? "application/xml" : "text/plain").send(ack);
    void handleInboundEvent(event, plainXml).catch((error) => {
      console.error("[wecom-bridge] inbound event handling failed:", error);
    });
  } catch (error) {
    console.error("[wecom-bridge] callback error:", error);
    res.status(400).send(String(error.message || error));
  }
});

app.post("/api/wecom/app-message", ensureAdminToken, jsonParser, async (req, res) => {
  try {
    const payload = await callWeComApi("/cgi-bin/message/send", {
      body: {
        touser: req.body.touser,
        toparty: req.body.toparty,
        totag: req.body.totag,
        msgtype: req.body.msgtype || "text",
        agentid: Number(config.agentId),
        text: req.body.text,
        markdown: req.body.markdown,
        news: req.body.news,
        mpnews: req.body.mpnews,
        template_card: req.body.template_card,
        safe: req.body.safe ?? 0,
        enable_duplicate_check: req.body.enable_duplicate_check ?? 0,
      },
    });
    res.json({ ok: true, payload });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error.message || error) });
  }
});

app.post("/api/wecom/group-message", ensureAdminToken, jsonParser, async (req, res) => {
  try {
    const sender = req.body.sender || config.defaultGroupSender;
    const chatIdList = req.body.chat_id_list || config.defaultGroupChatIds;
    if (!sender || !Array.isArray(chatIdList) || chatIdList.length === 0) {
      res.status(400).json({ ok: false, error: "sender and chat_id_list are required" });
      return;
    }
    const payload = await createGroupMessageTask({
      sender,
      chatIdList,
      text: req.body.text?.content || req.body.text || "",
      attachments: req.body.attachments || [],
    });
    res.json({ ok: true, payload });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error.message || error) });
  }
});

app.post("/api/wecom/customers/list", ensureAdminToken, jsonParser, async (req, res) => {
  try {
    const userid = req.body.userid || req.query.userid;
    if (!userid) {
      res.status(400).json({ ok: false, error: "userid is required" });
      return;
    }
    const payload = await callWeComApi("/cgi-bin/externalcontact/list", {
      method: "GET",
      query: { userid },
    });
    res.json({ ok: true, payload });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error.message || error) });
  }
});

app.post("/api/wecom/call", ensureAdminToken, jsonParser, async (req, res) => {
  try {
    const path = req.body.path;
    if (typeof path !== "string" || !path.startsWith("/cgi-bin/")) {
      res.status(400).json({ ok: false, error: "path must start with /cgi-bin/" });
      return;
    }
    const payload = await callWeComApi(path, {
      method: req.body.method || "POST",
      query: req.body.query || {},
      body: req.body.body,
    });
    res.json({ ok: true, payload });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error.message || error) });
  }
});

app.post("/api/openclaw/cron-dispatch", ensureAdminToken, jsonParser, async (req, res) => {
  try {
    const text = extractCronText(req.body);
    const sender = String(req.query.sender || req.body.sender || config.defaultGroupSender || "");
    const chatIdList = [
      ...new Set([
        ...(typeof req.query.chatIds === "string" ? parseCsv(req.query.chatIds) : []),
        ...(Array.isArray(req.body.chat_id_list) ? req.body.chat_id_list : []),
        ...config.defaultGroupChatIds,
      ]),
    ];
    if (!text) {
      res.status(400).json({ ok: false, error: "No text-like field found in payload" });
      return;
    }
    if (!sender || chatIdList.length === 0) {
      res.status(400).json({ ok: false, error: "sender and chat ids are required" });
      return;
    }
    const payload = await createGroupMessageTask({
      sender,
      chatIdList,
      text,
    });
    res.json({ ok: true, payload });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error.message || error) });
  }
});

app.listen(config.port, config.host, () => {
  console.log(`[wecom-bridge] listening on http://${config.host}:${config.port}`);
  console.log(`[wecom-bridge] callback: http://${config.host}:${config.port}${config.callbackPath}`);
  console.log(`[wecom-bridge] OpenClaw mode: ${config.openclawExecMode}`);
  console.log(`[wecom-bridge] OpenClaw agent: ${config.openclawAgentId}`);
});

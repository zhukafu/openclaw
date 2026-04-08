#!/usr/bin/env node

const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");
const AliyunPackageAPI = require("./AliyunPackageAPI");

// 解析命令行参数
const argv = yargs(hideBin(process.argv))
  .usage("用法: $0 [选项]")
  .option("remote-file-path", {
    alias: "r",
    describe: "远程文件路径（包含文件名）",
    demandOption: true,
    type: "string",
  })
  .option("version", {
    alias: "v",
    describe: "制品版本号",
    demandOption: true,
    type: "string",
  })
  .option("expiration-days", {
    alias: "e",
    describe: "链接过期天数（默认7天）",
    type: "number",
    default: 7,
  })
  .help().argv;

async function main() {
  try {
    console.log("正在获取免密下载链接...");
    console.log(`远程文件路径: ${argv.remoteFilePath}`);
    console.log(`版本: ${argv.version}`);
    console.log(`过期天数: ${argv.expirationDays}`);

    // 计算过期时间戳（当前时间 + 天数 * 24小时 * 60分钟 * 60秒 * 1000毫秒）
    const expiration = Date.now() + argv.expirationDays * 24 * 60 * 60 * 1000;

    const api = new AliyunPackageAPI();

    const result = await api.getDownloadLink(argv.remoteFilePath, argv.version, expiration);

    console.log("\n获取成功!");
    console.log("免密下载链接信息:");
    console.log(JSON.stringify(result, null, 2));

    console.log("\n免密下载链接:");
    console.log(result.downloadUrl);
  } catch (error) {
    console.error("获取下载链接失败:", error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  void main();
}

module.exports = main;

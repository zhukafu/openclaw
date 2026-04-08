#!/usr/bin/env node

const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");
const AliyunPackageAPI = require("./AliyunPackageAPI");

// 解析命令行参数
const argv = yargs(hideBin(process.argv))
  .usage("用法: $0 [选项]")
  .option("local-file", {
    alias: "f",
    describe: "本地文件路径",
    demandOption: true,
    type: "string",
  })
  .option("remote-path", {
    alias: "r",
    describe: "远程制品文件路径（不包含文件名）",
    demandOption: true,
    type: "string",
  })
  .option("version", {
    alias: "v",
    describe: "上传版本号",
    demandOption: true,
    type: "string",
  })
  .option("file-name", {
    alias: "n",
    describe: "制品名称（可选，默认使用本地文件名）",
    type: "string",
  })
  .option("description", {
    alias: "d",
    describe: "制品描述（可选）",
    type: "string",
  })
  .help().argv;

async function main() {
  try {
    console.log("开始上传文件...");
    console.log(`本地文件: ${argv.localFile}`);
    console.log(`远程路径: ${argv.remotePath}`);
    console.log(`版本: ${argv.version}`);

    const api = new AliyunPackageAPI();

    const result = await api.uploadFile(
      argv.remotePath,
      argv.version,
      argv.localFile,
      argv.fileName || null,
      argv.description || null,
    );

    console.log("\n上传成功!");
    console.log("响应结果:");
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error("上传失败:", error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  void main();
}

module.exports = main;

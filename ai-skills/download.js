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
  .option("output-path", {
    alias: "o",
    describe: "输出文件路径",
    demandOption: true,
    type: "string",
  })
  .help().argv;

async function main() {
  try {
    console.log("开始下载文件...");
    console.log(`远程文件路径: ${argv.remoteFilePath}`);
    console.log(`版本: ${argv.version}`);
    console.log(`输出路径: ${argv.outputPath}`);

    const api = new AliyunPackageAPI();

    const success = await api.downloadFile(argv.remoteFilePath, argv.version, argv.outputPath);

    if (success) {
      console.log("\n下载成功!");
      console.log(`文件已保存至: ${argv.outputPath}`);
    } else {
      console.log("\n下载失败!");
    }
  } catch (error) {
    console.error("下载失败:", error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  void main();
}

module.exports = main;

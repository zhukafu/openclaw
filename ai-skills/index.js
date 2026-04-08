#!/usr/bin/env node

const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");
const AliyunPackageAPI = require("./AliyunPackageAPI");

// 主程序入口，展示可用的命令
const _argv = yargs(hideBin(process.argv))
  .usage("用法: $0 <command> [选项]")
  .command(
    "upload",
    "上传文件到阿里云制品仓库",
    (yargs) => {
      return yargs
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
        });
    },
    async (argv) => {
      const api = new AliyunPackageAPI();
      try {
        const result = await api.uploadFile(
          argv.remotePath,
          argv.version,
          argv.localFile,
          argv.fileName || null,
          argv.description || null,
        );
        console.log("上传成功!");
        console.log(JSON.stringify(result, null, 2));
      } catch (error) {
        console.error("上传失败:", error.message);
      }
    },
  )
  .command(
    "download",
    "从阿里云制品仓库下载文件",
    (yargs) => {
      return yargs
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
        });
    },
    async (argv) => {
      const api = new AliyunPackageAPI();
      try {
        const success = await api.downloadFile(argv.remoteFilePath, argv.version, argv.outputPath);
        if (success) {
          console.log("下载成功!");
          console.log(`文件已保存至: ${argv.outputPath}`);
        } else {
          console.log("下载失败!");
        }
      } catch (error) {
        console.error("下载失败:", error.message);
      }
    },
  )
  .command(
    "get-download-link",
    "获取临时免密下载链接",
    (yargs) => {
      return yargs
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
        });
    },
    async (argv) => {
      const api = new AliyunPackageAPI();
      try {
        const expiration = Date.now() + argv.expirationDays * 24 * 60 * 60 * 1000;
        const result = await api.getDownloadLink(argv.remoteFilePath, argv.version, expiration);
        console.log("获取成功!");
        console.log("免密下载链接信息:");
        console.log(JSON.stringify(result, null, 2));
        console.log("\n免密下载链接:");
        console.log(result.downloadUrl);
      } catch (error) {
        console.error("获取下载链接失败:", error.message);
      }
    },
  )
  .demandCommand(1, "请指定一个命令")
  .help().argv;

console.log("阿里云制品仓库工具");
console.log("使用方法:");
console.log(
  "  node index.js upload --local-file <本地文件路径> --remote-path <远程路径> --version <版本号>",
);
console.log(
  "  node index.js download --remote-file-path <远程文件路径> --version <版本号> --output-path <输出路径>",
);
console.log(
  "  node index.js get-download-link --remote-file-path <远程文件路径> --version <版本号> --expiration-days <过期天数>",
);
console.log("");

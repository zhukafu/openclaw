/**
 * 阿里云制品仓库工具使用示例
 */

const AliyunPackageAPI = require("./AliyunPackageAPI");
const fs = require("fs");

async function example() {
  console.log("=== 阿里云制品仓库工具使用示例 ===\n");

  const api = new AliyunPackageAPI();

  // 示例1: 上传文件
  console.log("1. 上传文件示例:");
  try {
    const uploadResult = await api.uploadFile(
      "example/demo", // 远程路径
      "1.0.0", // 版本
      "./test.txt", // 本地文件路径
      "demo.txt", // 文件名
      "示例文件", // 描述
    );

    console.log("上传成功!");
    console.log("文件信息:", {
      fileMd5: uploadResult.object.fileMd5,
      fileSha1: uploadResult.object.fileSha1,
      fileSha256: uploadResult.object.fileSha256,
      fileSize: uploadResult.object.fileSize,
      downloadUrl: uploadResult.object.url,
    });
    console.log("");
  } catch (error) {
    console.error("上传失败:", error.message);
    console.log("");
  }

  // 示例2: 获取免密下载链接
  console.log("2. 获取免密下载链接示例:");
  try {
    // 计算7天后的过期时间
    const expiration = Date.now() + 7 * 24 * 60 * 60 * 1000;

    const linkInfo = await api.getDownloadLink(
      "example/demo/demo.txt", // 远程文件路径（包含文件名）
      "1.0.0", // 版本
      expiration, // 过期时间戳
    );

    console.log("获取免密下载链接成功!");
    console.log("链接信息:", {
      downloadUrl: linkInfo.downloadUrl,
      sha1: linkInfo.sha1,
      sha256: linkInfo.sha256,
      md5: linkInfo.md5,
      versionDescription: linkInfo.versionDescription,
    });
    console.log("");
  } catch (error) {
    console.error("获取下载链接失败:", error.message);
    console.log("");
  }

  // 示例3: 下载文件
  console.log("3. 下载文件示例:");
  try {
    const success = await api.downloadFile(
      "example/demo/demo.txt", // 远程文件路径（包含文件名）
      "1.0.0", // 版本
      "./downloaded_test.txt", // 本地输出路径
    );

    if (success) {
      console.log("下载成功!");
      console.log("文件已保存至: ./downloaded_test.txt");

      // 验证下载的文件是否存在
      if (fs.existsSync("./downloaded_test.txt")) {
        console.log("文件存在，大小:", fs.statSync("./downloaded_test.txt").size, "字节");
      }
    } else {
      console.log("下载失败!");
    }
    console.log("");
  } catch (error) {
    console.error("下载失败:", error.message);
    console.log("");
  }

  console.log("=== 示例执行完成 ===");
}

// 如果直接运行此文件，则执行示例
if (require.main === module) {
  example().catch(console.error);
}

module.exports = example;

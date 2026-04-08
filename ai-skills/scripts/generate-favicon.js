const fs = require("fs");
const os = require("os");
const path = require("path");
const sharp = require("sharp");
const pngToIco = require("png-to-ico");

void (async function () {
  try {
    const svgPath = path.join(__dirname, "..", "favicon.svg");
    if (!fs.existsSync(svgPath)) {
      console.error("favicon.svg not found at", svgPath);
      process.exit(2);
    }

    const svgBuffer = fs.readFileSync(svgPath);

    // png-to-ico 这个库只接受“单个 PNG 路径”，内部会自动生成 256/48/32/16 多尺寸。
    // 因此这里先从 SVG 渲染一个 256x256 的 PNG 临时文件。
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fav-"));
    const png256Path = path.join(tmpDir, "icon-256.png");
    await sharp(svgBuffer).resize(256, 256, { fit: "contain" }).png().toFile(png256Path);

    const icoBuffer = await pngToIco(png256Path);
    const outPath = path.join(__dirname, "..", "favicon.ico");
    fs.writeFileSync(outPath, icoBuffer);
    console.log("Generated", outPath);

    // 清理临时文件
    try {
      fs.unlinkSync(png256Path);
      fs.rmdirSync(tmpDir);
    } catch {
      // 忽略清理错误
    }
  } catch (err) {
    console.error("Failed to generate favicon.ico:", err);
    process.exit(1);
  }
})();
